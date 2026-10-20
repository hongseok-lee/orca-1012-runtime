import {createHash} from 'node:crypto'
import {createReadStream,createWriteStream} from 'node:fs'
import {chmod,mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {Transform} from 'node:stream'
import {pipeline} from 'node:stream/promises'

/** Prepare once when the account service is created, before a native refresh
 * callback needs it. Streaming I/O keeps provider frames and their deadlines
 * running; the private executable is returned only after full integrity proof. */
export async function prepareAccountNativeArtifact(source:string,expectedSha:string,expectedBytes:number):Promise<string> {
  const directory=await mkdtemp(join(tmpdir(),'orca-account-auth-'))
  const target=join(directory,'codex'),hash=createHash('sha256')
  let size=0
  try {
    await pipeline(createReadStream(source),new Transform({transform(chunk:Buffer,_encoding,done){
      size+=chunk.length
      if(size>expectedBytes) {done(new Error('CODEX_ACCOUNT_ARTIFACT_UNCONFIRMED'));return}
      hash.update(chunk);done(null,chunk)
    }}),createWriteStream(target,{flags:'wx',mode:0o400}))
    if(size!==expectedBytes||hash.digest('hex')!==expectedSha) {throw new Error('CODEX_ACCOUNT_ARTIFACT_UNCONFIRMED')}
    await chmod(target,0o500)
    return target
  } catch {
    await rm(directory,{recursive:true,force:true})
    throw new Error('CODEX_ACCOUNT_ARTIFACT_UNCONFIRMED')
  }
}
