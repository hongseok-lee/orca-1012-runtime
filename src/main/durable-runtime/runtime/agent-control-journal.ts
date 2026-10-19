import type { Pool } from 'pg'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { appendAudit, enqueueOutbox } from '../journal/store.ts'
import { withDurableTransaction, DurableDatabaseError } from '../db/connection.ts'
import { assertResyncCoverage } from './agent-control-resync.ts'
export type ControlFrame = Readonly<Record<string, unknown>>
export type ControlJournal = Readonly<{
  load(controlId:string):Promise<{cursor:number;notifications:ControlFrame[]}>
  record(controlId:string,frame:ControlFrame):Promise<number>
  resync(controlId:string,through:number,snapshot:unknown):Promise<number>
}>
const deny=():never=>{throw new DurableDatabaseError('AGENT_CONTROL_JOURNAL_UNCONFIRMED')}
/** Private authenticated transport observations. Raw notifications remain recoverable
 * even if a backend dies after ACK and before the original output spool drains. */
export function createAgentControlJournal(pool:Pool,podUid:string):ControlJournal {
  return Object.freeze({
    async load(controlId) {
      const row=await pool.query<{last_seq:string;pod_uid:string}>('SELECT last_seq::text,pod_uid FROM durable_runtime.agent_control_cursors WHERE control_id=$1',[controlId])
      if(row.rowCount && row.rows[0].pod_uid!==podUid) {deny()}
      const frames=await pool.query<{body:ControlFrame}>(`SELECT body FROM durable_runtime.agent_control_frames WHERE control_id=$1 AND body->>'event'='NOTIFICATION' ORDER BY seq`,[controlId])
      return {cursor:Number(row.rows[0]?.last_seq??0),notifications:frames.rows.map(x=>x.body)}
    },
    async record(controlId,frame) {
      const seq=frame.hostSeq
      if(!Number.isSafeInteger(seq)||Number(seq)<1) {deny()}
      return withDurableTransaction(pool,async tx=>{
        await tx.query('INSERT INTO durable_runtime.agent_control_cursors(control_id,pod_uid) VALUES($1,$2) ON CONFLICT DO NOTHING',[controlId,podUid])
        const row=await tx.query<{last_seq:string;pod_uid:string}>('SELECT last_seq::text,pod_uid FROM durable_runtime.agent_control_cursors WHERE control_id=$1 FOR UPDATE',[controlId])
        if(row.rows[0].pod_uid!==podUid) {deny()}
        const clean={...frame};delete clean.podBearer
        await tx.query('INSERT INTO durable_runtime.agent_control_frames(control_id,seq,body) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[controlId,seq,JSON.stringify(clean)])
        const saved=await tx.query<{body:unknown}>('SELECT body FROM durable_runtime.agent_control_frames WHERE control_id=$1 AND seq=$2',[controlId,seq])
        if(!isDeepStrictEqual(saved.rows[0].body,clean)) {deny()}
        let cursor=Number(row.rows[0].last_seq)
        const next=await tx.query<{seq:string}>('SELECT seq::text FROM durable_runtime.agent_control_frames WHERE control_id=$1 AND seq>$2 ORDER BY seq',[controlId,cursor])
        for(const item of next.rows) {if(Number(item.seq)!==cursor+1) {break};cursor++}
        await tx.query('UPDATE durable_runtime.agent_control_cursors SET last_seq=$2 WHERE control_id=$1',[controlId,cursor])
        return cursor
      })
    },
    async resync(controlId,through,snapshot) {
      return withDurableTransaction(pool,async tx=>{
        const host=await tx.query<{session_id:string;connection_instance_id:string;native:string;runtime_unit_id:string;attempt_id:string;revision:string}>(`SELECT h.session_id,h.connection_instance_id,h.runtime_unit_id,h.attempt_id,u.revision::text,
          (SELECT e.next_state->'providerRef'->>'nativeSessionRef' FROM durable_runtime.runtime_audit_events e WHERE e.kind='INITIAL_PROVIDER_READY'
           AND e.next_state->>'attemptId'=h.attempt_id::text ORDER BY e.occurred_at DESC LIMIT 1) AS native
          FROM durable_runtime.agent_control_hosts h JOIN durable_runtime.attempts a ON a.id=h.attempt_id JOIN durable_runtime.runtime_units u ON u.id=h.runtime_unit_id
          WHERE h.control_id=$1 AND h.pod_uid=$2 AND h.provider='codex' AND a.status='READY' AND a.stopped_at IS NULL FOR UPDATE OF a`,[controlId,podUid])
        if(host.rowCount!==1) {deny()}
        const h=host.rows[0]
        const deliveries=await tx.query<{state:string;provider_ref:string|null}>('SELECT state,provider_ref FROM durable_runtime.delivery_attempts WHERE session_id=$1',[h.session_id])
        const notifications=await tx.query<{notification:unknown}>(`SELECT body->'notification' AS notification FROM durable_runtime.session_events WHERE session_id=$1 AND body->>'kind'='TERMINAL_CODEX_NOTIFICATION'`,[h.session_id])
        assertResyncCoverage(snapshot,h.native,deliveries.rows,notifications.rows.map(x=>x.notification))
        await tx.query('INSERT INTO durable_runtime.agent_control_cursors(control_id,pod_uid) VALUES($1,$2) ON CONFLICT DO NOTHING',[controlId,podUid])
        const row=await tx.query<{last_seq:string;pod_uid:string}>('SELECT last_seq::text,pod_uid FROM durable_runtime.agent_control_cursors WHERE control_id=$1 FOR UPDATE',[controlId])
        if(row.rows[0].pod_uid!==podUid || Number(row.rows[0].last_seq)>through) {deny()}
        // Full terminal history already represented by committed output and settled
        // deliveries. This records an explicit snapshot barrier, not invented frames.
        await tx.query(`INSERT INTO durable_runtime.agent_control_resyncs(control_id,through_seq,missing_kind,snapshot) VALUES($1,$2,'UNKNOWN',$3)
          ON CONFLICT DO NOTHING`,[controlId,through,JSON.stringify(snapshot)])
        let cursor=through
        const tail=await tx.query<{seq:string}>('SELECT seq::text FROM durable_runtime.agent_control_frames WHERE control_id=$1 AND seq>$2 ORDER BY seq',[controlId,through])
        for(const row of tail.rows) {if(Number(row.seq)!==cursor+1) {break};cursor++}
        await tx.query('UPDATE durable_runtime.agent_control_cursors SET last_seq=$2 WHERE control_id=$1',[controlId,cursor])
        const event={kind:'AGENT_CONTROL_EXPLICIT_RESYNC',controlId,throughSeq:through,missingFrameKind:'UNKNOWN',basis:'RETAINED_TERMINAL_NATIVE_HISTORY_AND_COMMITTED_OUTPUT'}
        const audit=await appendAudit(tx,{actorId:'orca-agent-control',runtimeUnitId:h.runtime_unit_id,attemptId:h.attempt_id,podUid,
          sessionId:logicalId('session',h.session_id),kind:event.kind,nextState:event,occurredAt:new Date(),receivedAt:new Date(),producerId:randomUUID(),producerSeq:counter('sequence:producer','1'),evidenceRefs:[]})
        await enqueueOutbox(tx,{eventId:logicalId('event',audit),aggregateId:h.runtime_unit_id,aggregateKind:'runtime-unit',revision:counter('row:runtime-unit',h.revision),event})
        return cursor
      })
    },
  })
}
