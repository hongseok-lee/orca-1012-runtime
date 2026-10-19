import { constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,realpathSync,existsSync } from 'node:fs'
import { createNativeArtifactFile,nativeFileMatches,type NativeFileIdentity } from './native-artifact-file.ts'

export type NativeCompanionRepair=Readonly<{agentId:string;podUid:string;pid:number;startTicks:string;
  main:NativeFileIdentity;codeModeHost:NativeFileIdentity;sandboxBwrap?:NativeFileIdentity;resource?:'sandbox-bwrap'}>
/** Explicit maintenance of an already granted, idle Agent: same normal file
 * issuer/checksums as COLD. Adds only a missing version-pinned companion; never
 * overwrites/restarts the live main, changes auth/checkpoint, or creates a host.
 * Caller must target its authorized task-owned Pod; projected UID and exact
 * running executable identity bind the effect inside that exec connection. */
export async function repairAgentNativeCompanion(policy:NativeCompanionRepair,input:NodeJS.ReadableStream=process.stdin) {
  if(!/^[0-9a-f-]{36}$/.test(policy.agentId) || !policy.podUid || !Number.isSafeInteger(policy.pid) || policy.pid<1 || !/^\d+$/.test(policy.startTicks)) {throw Error('NATIVE_REPAIR_POLICY')}
  const token=JSON.parse(Buffer.from(readFileSync('/var/run/secrets/orca-runtime-agent/token','utf8').trim().split('.')[1],'base64url').toString('utf8'))
  if(token['kubernetes.io']?.pod?.uid!==policy.podUid) {throw Error('NATIVE_REPAIR_POD_CHANGED')}
  const root=openSync('/agent',constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW),held=fstatSync(root)
  const home=`/agent/home/${policy.agentId}`,directory=`${home}/.orca-native`,main=`${directory}/codex`
  const guard=()=>{
    const current=lstatSync('/agent')
    if(!current.isDirectory() || current.isSymbolicLink() || current.dev!==held.dev || current.ino!==held.ino) {throw Error('NATIVE_REPAIR_ROOT_CHANGED')}
    for(const path of ['/agent/home',home,directory]) {const stat=lstatSync(path)
      if(!stat.isDirectory() || stat.isSymbolicLink() || stat.uid!==process.getuid?.() || (stat.mode&0o777)!==0o700 || realpathSync(path)!==path) {throw Error('NATIVE_REPAIR_HOME')}
    }
    const stat=readFileSync(`/proc/${policy.pid}/stat`,'utf8'),start=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]
    const exe=lstatSync(main),running=fstatExecutable(policy.pid)
    if(start!==policy.startTicks || exe.dev!==running.dev || exe.ino!==running.ino || realpathSync(`/proc/${policy.pid}/exe`)!==main) {throw Error('NATIVE_REPAIR_PROCESS_CHANGED')}
  }
  let file:ReturnType<typeof createNativeArtifactFile>|undefined
  try {
    guard();if(!nativeFileMatches(main,policy.main)) {throw Error('NATIVE_REPAIR_VERSION_MISMATCH')}
    const name=policy.resource==='sandbox-bwrap'?'codex-resources/bwrap':'codex-code-mode-host',identity=policy.resource==='sandbox-bwrap'?policy.sandboxBwrap:policy.codeModeHost
    if(!identity) {throw Error('NATIVE_REPAIR_RESOURCE_POLICY')}
    if(existsSync(`${directory}/${name}`)) {throw Error('NATIVE_REPAIR_ALREADY_PRESENT')}
    file=createNativeArtifactFile(directory,name,identity,guard)
    file.begin();let offset=0
    for await(const chunk of input) {const bytes=Buffer.from(chunk)
      for(let start=0;start<bytes.length;start+=256*1024) {const part=bytes.subarray(start,start+256*1024);file.append(offset,part);offset+=part.length}
    }
    guard();if(!nativeFileMatches(main,policy.main)) {throw Error('NATIVE_REPAIR_VERSION_CHANGED')}
    file.finish()
    return {installed:true,podUid:policy.podUid,agentId:policy.agentId,mainUnchanged:true,resource:name,identity}
  } finally {file?.close();closeSync(root)}
}
function fstatExecutable(pid:number) {const fd=openSync(`/proc/${pid}/exe`,constants.O_RDONLY);try {return fstatSync(fd)} finally {closeSync(fd)}}
