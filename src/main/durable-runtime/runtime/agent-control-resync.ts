import { DurableDatabaseError } from '../db/connection.ts'
import { isDeepStrictEqual } from 'node:util'
const object=(v:unknown):Record<string,unknown>|null=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null
const deny=(reason:string):never=>{throw new DurableDatabaseError(`AGENT_CONTROL_RESYNC_${reason}`)}
/** A gap is never declared a harmless response. Only complete terminal native
 * history whose effects/output are already durable can close an unknown gap.
 * Active/unknown deliveries, missing/truncated turns or missing items stay blocked. */
export function assertResyncCoverage(snapshot:unknown,native:string,deliveries:readonly {state:string;provider_ref:string|null}[],notifications:unknown[]):void {
  const thread=object(object(snapshot)?.thread),turns=thread?.turns
  if(thread?.id!==native || !Array.isArray(turns) || !turns.length) {deny('SNAPSHOT_UNCONFIRMED')}
  if(deliveries.some(d=>!['SETTLED','CANCELLED','INTERRUPTED'].includes(d.state))) {deny('UNSETTLED_DELIVERY')}
  const settled=new Set(deliveries.filter(d=>d.state==='SETTLED').map(d=>d.provider_ref))
  const nativeIds=new Set<string>()
  for(const value of turns as unknown[]) {
    const turn=object(value),items=turn?.items
    if(typeof turn?.id!=='string'||!['completed','failed'].includes(String(turn.status))||!Array.isArray(items)||!settled.has(turn.id)||nativeIds.has(turn.id)||!items.length||!items.some(i=>object(i)?.type==='userMessage')) {deny('TURN_UNCONFIRMED')}
    nativeIds.add(turn!.id as string)
    const done=notifications.filter(n=>object(n)?.method==='item/completed').map(n=>object(object(n)?.params)).filter(p=>p?.turnId===turn!.id)
    if(!notifications.some(n=>{const v=object(n),p=object(v?.params);return v?.method==='turn/completed'&&object(p?.turn)?.id===turn!.id&&object(p?.turn)?.status===turn!.status})) {deny('COMPLETION_MISSING')}
    for(const item of items as unknown[]) {
      const id=object(item)?.id
      if(typeof id!=='string'||!done.some(p=>isDeepStrictEqual(p?.item,item))) {deny('ITEM_NOT_RETAINED')}
    }
  }
  if([...settled].some(id=>!id||!nativeIds.has(id))) {deny('HISTORY_TRUNCATED')}
}
