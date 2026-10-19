import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,existsSync,symlinkSync,rmSync,chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { supplyNativeAndCold } from './agent-control-native-supply.ts'
import { createNativeArtifactFile } from './native-artifact-file.ts'
import { packageCodexNative } from '../../../../config/scripts/package-codex-native.mjs'

test('version-consistent distribution pins both siblings; incomplete/corrupt/symlink files cannot publish',async()=>{
  const root=mkdtempSync(join(tmpdir(),'orca-native-dist-')),upstream=join(root,'upstream'),output=join(root,'artifacts'),home=join(root,'home')
  mkdirSync(join(upstream,'bin'),{recursive:true});mkdirSync(home,{mode:0o700});chmodSync(home,0o700)
  try {
    writeFileSync(join(upstream,'codex-package.json'),JSON.stringify({layoutVersion:1,variant:'codex',version:'0.160.1',target:'x86_64-unknown-linux-musl',entrypoint:'bin/codex'}))
    mkdirSync(join(upstream,'codex-resources'));writeFileSync(join(upstream,'codex-resources/bwrap'),Buffer.from('fixture-bwrap'),{mode:0o700})
    for(const name of ['codex','codex-code-mode-host']) {writeFileSync(join(upstream,'bin',name),Buffer.from('fixture-'+name),{mode:0o700})}
    const distribution=await packageCodexNative(upstream,output)
    assert.deepEqual(distribution.files.map(f=>f.name),['codex','codex-code-mode-host','codex-resources/bwrap'])
    for(const identity of distribution.files) {
      const bytes=readFileSync(join(output,identity.file));assert.equal(createHash('sha256').update(bytes).digest('hex'),identity.sha256)
      const file=createNativeArtifactFile(home,identity.name,identity,()=>{})
      try {file.begin();assert.throws(()=>file.finish());assert.equal(existsSync(join(home,identity.name)),false)
        file.append(0,bytes);file.finish();assert.equal(file.ready(),true);assert.equal(statSync(join(home,identity.name)).mode&0o777,0o700)
      } finally {file.close()}
    }
    const data=Buffer.from('wrong'),identity={sha256:'0'.repeat(64),byteLength:data.length},bad=createNativeArtifactFile(home,'claude',identity,()=>{})
    try {bad.begin();bad.append(0,data);assert.throws(()=>bad.finish());assert.equal(existsSync(join(home,'claude')),false)} finally {bad.close()}
    const evil=join(root,'link');symlinkSync(home,evil);assert.throws(()=>createNativeArtifactFile(evil,'claude',identity,()=>{}).begin())
    assert.equal(readFileSync(join(home,'codex'),'utf8'),'fixture-codex','companion handling preserves the main executable')
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('normal native transfer cannot enter COLD until both pinned sibling files verify',async()=>{
  const root=mkdtempSync(join(tmpdir(),'orca-native-transfer-')),main=Buffer.from('native-main'),host=Buffer.from('native-host'),bwrap=Buffer.from('native-bwrap')
  const identity=(b:Buffer)=>({sha256:createHash('sha256').update(b).digest('hex'),byteLength:b.length})
  writeFileSync(join(root,'main'),main);writeFileSync(join(root,'host'),host);writeFileSync(join(root,'bwrap'),bwrap)
  try {
    for(const corrupt of [false,true]) {
      const home=join(root,String(corrupt));mkdirSync(home,{mode:0o700});chmodSync(home,0o700)
      const files=new Map([['codex',createNativeArtifactFile(home,'codex',identity(main),()=>{})],
        ['codex-code-mode-host',createNativeArtifactFile(home,'codex-code-mode-host',identity(host),()=>{})],
        ['codex-resources/bwrap',createNativeArtifactFile(home,'codex-resources/bwrap',corrupt?{...identity(bwrap),sha256:'0'.repeat(64)}:identity(bwrap),()=>{})]])
      let cold=false
      const request=async(method:string,params?:Record<string,unknown>)=>{
        if(method==='PREPARE_COLD') {for(const file of files.values()) {file.begin()}}
        if(method==='NATIVE_CHUNK') {files.get(String(params?.name??'codex'))!.append(params?.offset,Buffer.from(String(params?.bytes),'base64'))}
        if(method==='NATIVE_FINISH') {files.get('codex-code-mode-host')!.finish();files.get('codex-resources/bwrap')!.finish();files.get('codex')!.finish()}
        if(method==='COLD') {assert.ok([...files.values()].every(file=>file.ready()));cold=true;return {nativePid:123}}
      }
      try {
        const transfer=supplyNativeAndCold(request,join(root,'main'),main.length,{file:join(root,'host'),byteLength:host.length,sandboxBwrap:{file:join(root,'bwrap'),byteLength:bwrap.length}})
        if(corrupt) {await assert.rejects(transfer);assert.equal(cold,false);assert.equal(existsSync(join(home,'codex')),false)}
        else {assert.equal(await transfer,123);assert.equal(cold,true);assert.deepEqual(readFileSync(join(home,'codex-code-mode-host')),host)}
      } finally {for(const file of files.values()) {file.close()}}
    }
  } finally {rmSync(root,{recursive:true,force:true})}
})
