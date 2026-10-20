import type { NativeSessionCheckpoint } from './native-session-checkpoint.ts'
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
