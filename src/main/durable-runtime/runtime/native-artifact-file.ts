import { createHash } from 'node:crypto'
import { constants,openSync,closeSync,lstatSync,fstatSync,writeSync,fsyncSync,fchmodSync,linkSync,unlinkSync,realpathSync,readSync,mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type NativeFileIdentity=Readonly<{sha256:string;byteLength:number}>
export function nativeFileMatches(file:string,expected:NativeFileIdentity):boolean {
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW)
  try {
    const stat=fstatSync(fd)
    if(!stat.isFile() || stat.uid!==process.getuid?.() || stat.size!==expected.byteLength || (stat.mode&0o777)!==0o700) {return false}
    const hash=createHash('sha256'),buffer=Buffer.alloc(256*1024);let n:number
    while((n=readSync(fd,buffer,0,buffer.length,null))>0) {hash.update(buffer.subarray(0,n))}
    return hash.digest('hex')===expected.sha256
  } finally {closeSync(fd)}
}
/** Fixed native filenames only. Streams directly to the protected HOME; no
 * archive paths, symlink extraction, /tmp executable or unverified publication. */
export function createNativeArtifactFile(directory:string,name:'codex'|'claude'|'codex-code-mode-host'|'codex-resources/bwrap',identity:NativeFileIdentity,
  rootCurrent:()=>void,replace=false) {
  if(!/^[0-9a-f]{64}$/.test(identity.sha256) || !Number.isSafeInteger(identity.byteLength) || identity.byteLength<1) {throw Error('NATIVE_ARTIFACT_POLICY')}
  let fd:number|null=null,offset=0,ready=false
  const targetDirectory=name==='codex-resources/bwrap'?join(directory,'codex-resources'):directory,base=name==='codex-resources/bwrap'?'bwrap':name
  const hash=createHash('sha256'),partial=join(targetDirectory,`${base}.${identity.sha256}.partial`),final=join(targetDirectory,base)
  const checkDirectory=(path:string)=>{const dir=lstatSync(path)
    if(!dir.isDirectory() || dir.isSymbolicLink() || dir.uid!==process.getuid?.() || (dir.mode&0o777)!==0o700 || realpathSync(path)!==path) {throw Error('NATIVE_ARTIFACT_DIRECTORY')}}
  const guard=()=>{rootCurrent();for(const path of new Set([directory,targetDirectory])) {checkDirectory(path)}}
  return Object.freeze({
    begin() {rootCurrent();checkDirectory(directory);if(targetDirectory!==directory) {try {mkdirSync(targetDirectory,{mode:0o700})} catch(e) {if((e as NodeJS.ErrnoException).code!=='EEXIST') {throw e}}}
      guard();if(fd!==null || ready) {throw Error('NATIVE_ARTIFACT_USED')}
      if(replace) {for(const file of [partial,final]) {try {unlinkSync(file)} catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT') {throw e}}}}
      fd=openSync(partial,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
    },
    append(at:unknown,chunk:Uint8Array) {guard();if(fd===null || at!==offset || !chunk.length || chunk.length>256*1024 || offset+chunk.length>identity.byteLength) {throw Error('NATIVE_ARTIFACT_BOUNDS')}
      let written=0;while(written<chunk.length) {const n=writeSync(fd,chunk,written,chunk.length-written);if(n<=0) {throw Error('NATIVE_ARTIFACT_WRITE')};written+=n}
      hash.update(chunk);offset+=chunk.length
    },
    finish() {guard();if(fd===null || offset!==identity.byteLength || hash.digest('hex')!==identity.sha256) {throw Error('NATIVE_ARTIFACT_IDENTITY')}
      fchmodSync(fd,0o700);fsyncSync(fd);const staged=fstatSync(fd)
      linkSync(partial,final);const published=lstatSync(final)
      if(published.dev!==staged.dev || published.ino!==staged.ino || !published.isFile()) {throw Error('NATIVE_ARTIFACT_PUBLICATION')}
      closeSync(fd);fd=null;unlinkSync(partial)
      for(const path of new Set([targetDirectory,directory])) {
        const parent=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
        try {fsyncSync(parent)} finally {closeSync(parent)}
      }
      ready=true
    },
    ready:()=>ready,
    close() {if(fd!==null) {closeSync(fd);fd=null}}
  })
}
