import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { JsonValue } from '../db/atomic.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import { appendSessionEvent, enqueueOutbox } from '../journal/store.ts'
import type { JournalSource } from '../journal/store.ts'
import { parseStructuredProviderEvent } from '../output/structured-provider-event.ts'
import { jsonValue, requireHeldStructuredSession } from '../structured/durable-common.ts'
import { snapshotStructuredJson } from '../structured/snapshot.ts'
import type { EventHandler } from './types.ts'

function reject(code: string): never { throw new DurableDatabaseError(code) }
function text(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || !value.trim()) { reject('STRUCTURED_OUTPUT_EVENT_IDENTITY') }
  return value
}
/** Internal processRuntimeEvent handler; not a workload/permit/authority issuer. */
export const structuredOutputEventHandler: EventHandler = async (tx, event) => {
  const data = jsonValue(snapshotStructuredJson(event))
  if (data === null || typeof data !== 'object' || Array.isArray(data)) { reject('STRUCTURED_OUTPUT_EVENT_SHAPE') }
  const payload = parseStructuredProviderEvent(data.payload)
  if (!Array.isArray(data.targetSessionIds) || data.targetSessionIds.length !== 1) { reject('STRUCTURED_OUTPUT_TARGET') }
  const sessionId = logicalId('session', text(data.targetSessionIds[0]))
  const agentId = logicalId('agent', text(data.agentId))
  const eventId = logicalId('event', text(data.eventId))
  const unitId = logicalId('runtime-unit', text(data.runtimeUnitId))
  const producerId = logicalId('producer', text(data.producerId))
  const sequence = counter('sequence:producer', text(data.sequence))
  const incarnation = event.incarnation
  if (sequence === '0' || text(data.incarnation) !== incarnation) { reject('STRUCTURED_OUTPUT_EVENT_IDENTITY') }
  requireHeldStructuredSession(tx, sessionId)
  if (!tx.isLockHeld(2, unitId) || !tx.isLockHeld(7, eventId)) { reject('STRUCTURED_OUTPUT_EVENT_LOCK_REQUIRED') }
  const source: JournalSource = payload.source.kind === 'PRODUCER'
    ? { kind: 'PRODUCER', sourceKind: 'STRUCTURED_PROVIDER_OUTPUT', producerId, incarnation, producerSeq: sequence }
    : { kind: 'NATIVE', sourceKind: 'STRUCTURED_PROVIDER_OUTPUT', provider: payload.provider,
      lineage: payload.source.lineage, nativeId: payload.source.nativeEventId }
  // Payload only: no retry count, current attempt/controller/fence or processing time.
  const body: JsonValue = payload
  const found = await tx.query<{ session_id: string; workspace_id: string; actual_workspace_id: string;
    agent_id: string; provider: string; actual_provider: string }>(
    `SELECT a.session_id,a.workspace_id,a.provider,s.workspace_id AS actual_workspace_id,
      s.agent_id,g.provider AS actual_provider
     FROM durable_runtime.structured_session_aliases a
     JOIN durable_runtime.sessions s ON s.id=a.session_id
     JOIN durable_runtime.agents g ON g.id=s.agent_id
     WHERE a.public_session_id=$1`, [payload.publicSessionId])
  const alias = found.rows[0]
  if (!alias || alias.session_id !== sessionId || alias.workspace_id !== alias.actual_workspace_id ||
    alias.agent_id !== agentId || alias.provider !== payload.provider || alias.actual_provider !== payload.provider) {
    reject('STRUCTURED_OUTPUT_ALIAS_SCOPE')
  }
  // Original target identity only; no lifecycle/current-attempt or Tab reopening filter.
  const journal = await appendSessionEvent(tx, { sessionId, source, body })
  await enqueueOutbox(tx, { eventId: journal.eventId, aggregateId: sessionId, aggregateKind: 'session',
    revision: counter('row:session', journal.sequence), event: body })
}
