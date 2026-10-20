import type {NativeSessionCheckpoint} from './native-session-checkpoint.ts'

/** Serialize authenticated disk observations without changing input admission.
 * An ID returned by thread/start alone is not persisted-history evidence. */
export function createNativeHistoryObserver(nativeSessionRef:string,read:()=>Promise<NativeSessionCheckpoint>,
  current:()=>boolean,record:(checkpoint:NativeSessionCheckpoint)=>Promise<boolean>) {
  let tail=Promise.resolve(),saved:string|null=null
  return {
    observe():Promise<void> {
      const next=tail.then(async()=>{
        if(!current()) {return}
        const checkpoint=await read()
        if(!current()) {return}
        if((checkpoint.state==='FOUND'||checkpoint.state==='PROVISIONAL') &&
            (checkpoint.provider!=='codex'||checkpoint.nativeSessionRef!==nativeSessionRef)) {
          throw new Error('NATIVE_HISTORY_IDENTITY_MISMATCH')
        }
        // Only committed observations are coalesced. Failure must remain
        // retryable at the next real provider event, without a polling loop.
        const key=JSON.stringify(checkpoint)
        if(key!==saved && await record(checkpoint) && current()) {saved=key}
      })
      tail=next.catch(()=>undefined)
      return next
    },
  }
}
