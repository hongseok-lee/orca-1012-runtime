import assert from 'node:assert/strict'
import test from 'node:test'
import {createHash} from 'node:crypto'
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import {tmpdir} from 'node:os'
import {prepareAccountNativeArtifact} from './orcad-account-native-artifact.ts'

test('account executable preparation yields to control traffic and gates execute permission on integrity',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'orca-account-artifact-test-'))
  const source=join(dir,'source'),bytes=Buffer.alloc(4*1024*1024,23)
  let executable:string|undefined
  try {
    await writeFile(source,bytes,{mode:0o600})
    const sha=createHash('sha256').update(bytes).digest('hex')
    const preparation=prepareAccountNativeArtifact(source,sha,bytes.length)
    let finished=false
    void preparation.then(()=>{finished=true})
    await new Promise<void>(done=>setImmediate(done))
    assert.equal(finished,false,'control delivery remains runnable during preparation')
    executable=await preparation
    assert.deepEqual(await readFile(executable),bytes)
    assert.equal((await stat(executable)).mode&0o777,0o500)
    assert.equal((await stat(source)).mode&0o777,0o600,'source unchanged')
    await assert.rejects(prepareAccountNativeArtifact(source,'0'.repeat(64),bytes.length),/ARTIFACT_UNCONFIRMED/)
    await assert.rejects(prepareAccountNativeArtifact(source,sha,bytes.length-1),/ARTIFACT_UNCONFIRMED/)
  }finally{await rm(dir,{recursive:true,force:true});if(executable) {await rm(dirname(executable),{recursive:true,force:true})}}
})
