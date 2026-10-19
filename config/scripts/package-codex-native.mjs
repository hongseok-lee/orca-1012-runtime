import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'

// The installed upstream package supplies BOTH sibling executables. No network,
// installation, private HOME/config or secret input is part of packaging.
export async function packageCodexNative(distribution,output) {
  const root=fs.realpathSync(distribution),meta=JSON.parse(fs.readFileSync(path.join(root,'codex-package.json'),'utf8'))
  if(meta.layoutVersion!==1 || meta.variant!=='codex' || meta.entrypoint!=='bin/codex' || !/^\d+\.\d+\.\d+(?:[-.a-zA-Z0-9]+)?$/.test(meta.version) ||
      !['x86_64-unknown-linux-musl','aarch64-unknown-linux-musl'].includes(meta.target)) {throw Error('CODEX_NATIVE_PACKAGE_LAYOUT')}
  fs.mkdirSync(output,{recursive:true,mode:0o700});const target=meta.target.startsWith('x86_64')?'linux-x64':'linux-arm64',files=[]
  for(const name of ['codex','codex-code-mode-host','codex-resources/bwrap']) {
    const source=name==='codex-resources/bwrap'?path.join(root,name):path.join(root,'bin',name),fd=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),stat=fs.fstatSync(fd)
    if(!stat.isFile() || fs.realpathSync(source)!==source || !(stat.mode&0o111)) {fs.closeSync(fd);throw Error('CODEX_NATIVE_PACKAGE_FILE')}
    const staging=path.join(output,`${path.basename(name)}.package-${process.pid}.partial`),out=fs.openSync(staging,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600),digest=crypto.createHash('sha256');let byteLength=0
    try {
      await pipeline(fs.createReadStream(source,{fd,autoClose:false}),new Transform({transform(chunk,_encoding,done){digest.update(chunk);byteLength+=chunk.length;done(null,chunk)}}),fs.createWriteStream(staging,{fd:out,autoClose:false}))
      const after=fs.fstatSync(fd)
      if(byteLength!==stat.size || after.size!==stat.size || after.mtimeMs!==stat.mtimeMs || after.ctimeMs!==stat.ctimeMs) {throw Error('CODEX_NATIVE_PACKAGE_CHANGED')}
      fs.fsyncSync(out)
    } finally {fs.closeSync(fd);fs.closeSync(out)}
    const sha256=digest.digest('hex'),file=`${path.basename(name)}-${meta.version}-${target}-${sha256}`,destination=path.join(output,file)
    try {fs.linkSync(staging,destination)} catch(e) {
      if(e.code!=='EEXIST') {throw e}
      const existing=fs.openSync(destination,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),hash=crypto.createHash('sha256')
      try {for await(const chunk of fs.createReadStream(destination,{fd:existing,autoClose:false})) {hash.update(chunk)}} finally {fs.closeSync(existing)}
      if(hash.digest('hex')!==sha256) {throw Error('CODEX_NATIVE_PACKAGE_COLLISION')}
    }
    fs.unlinkSync(staging);files.push({name,file,sha256,byteLength})
  }
  const manifest={format:'ORCA_CODEX_NATIVE_V1',version:meta.version,target:meta.target,files},file=path.join(output,`codex-${meta.version}-${target}-${crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}.distribution.json`)
  fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600})
  const dir=fs.openSync(output,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try {fs.fsyncSync(dir)} finally {fs.closeSync(dir)}
  return {manifestFile:file,...manifest}
}
if(process.argv[1] && import.meta.url===new URL('file://'+path.resolve(process.argv[1])).href) {
  const [distribution,output,...extra]=process.argv.slice(2)
  if(!distribution || !output || extra.length) {throw Error('Usage: package-codex-native.mjs UPSTREAM_RELEASE_DIRECTORY OUTPUT_DIRECTORY')}
  console.log(JSON.stringify(await packageCodexNative(distribution,output)))
}
