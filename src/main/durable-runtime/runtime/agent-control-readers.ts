import type { NativeSessionCheckpoint } from './native-session-checkpoint.ts'
export const NATIVE_HISTORY_EVIDENCE_CAPABILITY='native-history-evidence-v1'
export function supportsNativeHistoryEvidence(capabilities:unknown):boolean {
  return Array.isArray(capabilities)&&capabilities.includes(NATIVE_HISTORY_EVIDENCE_CAPABILITY)
}
export function nativeHistoryReader(read:()=>Promise<NativeSessionCheckpoint>,supported:()=>boolean) {
  return async():Promise<NativeSessionCheckpoint>=>{
    if(!supported()) {throw new Error('NATIVE_HISTORY_EVIDENCE_UNSUPPORTED')}
    const checkpoint=await read()
    if(!supported()) {throw new Error('NATIVE_HISTORY_EVIDENCE_UNSUPPORTED')}
    return checkpoint
  }
}
/** Read-only probes using the original authenticated channel. Native history
 * can materialize after first input; mount qualification remains pre-open. */
export function agentControlReaders(request:(method:string)=>Promise<unknown>,available:()=>boolean,provider:string,
  observed:(checkpoint:NativeSessionCheckpoint)=>void, mountAvailable:()=>boolean=available) {
  function fail():never {throw new Error('AGENT_CODEX_CONTROL_UNCONFIRMED')}
  return {
    async readNativeSession():Promise<NativeSessionCheckpoint> {
      if(!available()) {fail()}
      const value=await request('NATIVE_STATE')
      if(!value || typeof value!=='object') {fail()}
      const state=Reflect.get(value,'state')
      let checkpoint:NativeSessionCheckpoint
      if(state==='NONE' || state==='UNKNOWN') {checkpoint={state}}
      else {
        if(!['FOUND','PROVISIONAL'].includes(String(state)) || Reflect.get(value,'provider')!==provider || typeof Reflect.get(value,'nativeSessionRef')!=='string') {fail()}
        checkpoint={state:state as 'FOUND'|'PROVISIONAL',provider:Reflect.get(value,'provider'),nativeSessionRef:Reflect.get(value,'nativeSessionRef')}
      }
      if(!available()) {fail()}
      observed(checkpoint);return checkpoint
    },
    async readMountProbe():Promise<string> {
      if(!mountAvailable()) {fail()}
      const value=await request('MOUNT_PROBE')
      if(!value || typeof value!=='object' || typeof Reflect.get(value,'output')!=='string') {fail()}
      if(!mountAvailable()) {fail()}
      return Reflect.get(value,'output')
    },
  }
}
