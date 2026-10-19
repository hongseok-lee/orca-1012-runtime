import type { NativeSessionCheckpoint } from './native-session-checkpoint.ts'
/** Read-only pre-open control probes, using the original authenticated channel. */
export function agentControlReaders(request:(method:string)=>Promise<unknown>,available:()=>boolean,provider:string,
  observed:(checkpoint:NativeSessionCheckpoint)=>void) {
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
        if(state!=='FOUND' || Reflect.get(value,'provider')!==provider || typeof Reflect.get(value,'nativeSessionRef')!=='string') {fail()}
        checkpoint={state:'FOUND',provider:Reflect.get(value,'provider'),nativeSessionRef:Reflect.get(value,'nativeSessionRef')}
      }
      observed(checkpoint);return checkpoint
    },
    async readMountProbe():Promise<string> {
      if(!available()) {fail()}
      const value=await request('MOUNT_PROBE')
      if(!value || typeof value!=='object' || typeof Reflect.get(value,'output')!=='string') {fail()}
      return Reflect.get(value,'output')
    },
  }
}
