import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import type { AttemptId, IntentRevision, StepRevision, ExecutionEpoch, ControllerTerm, ProducerId, Sequence } from '../../../shared/durable-runtime/identity.ts'
import { runDurableMutation, type MutationOutcome } from '../db/atomic.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import { appendAudit, enqueueOutbox } from '../journal/store.ts'
import { LockedGatewayAuthority } from '../runtime/gateway/authority.ts'
import { inputDigest } from '../runtime/gateway/input.ts'
import type { GatewayContext } from '../runtime/gateway/types.ts'
import { discoverUnitMembers, lockUnitMembers } from './locks.ts'
import { snapshotGatewayContext } from './reconcile-request.ts'
import { recordObservationLoss } from '../observation/loss.ts'
import type { PodUid } from '../runtime/runtime-evidence.ts'

export type ReconcileObservation = {
  readonly context: GatewayContext
  readonly originalStepRevision: StepRevision
  readonly originalIntentRevision: IntentRevision
  readonly originalControllerTerm: ControllerTerm
  readonly attemptId: AttemptId
  readonly podUid: string
  readonly executionEpoch: ExecutionEpoch
  readonly producerId: ProducerId
  readonly sequence: Sequence<'producer'>
  readonly watermark: Sequence<'observation'>
  readonly source: 'K8S_LIST' | 'K8S_WATCH'
  readonly resourceVersion: string
  readonly kind: 'PRESENT' | 'MISSING' | 'READ_FAILED' | 'STOPPED'
}

/** Records observations of their exact original target. K8s absence or a
 * container STOPPED report is not verified physical fencing or provider READY.
 * Provider work events use the P1-12 handler boundary, not this transport API. */
export async function recordReconcileObservation(pool: Pool, caller: ReconcileObservation): Promise<MutationOutcome> {
  const input: ReconcileObservation = Object.freeze({ ...caller, context: snapshotGatewayContext(caller.context) })
  logicalId('attempt', input.attemptId)
  counter('sequence:producer', input.sequence)
  counter('sequence:observation', input.watermark)
  if (!input.podUid || !input.resourceVersion || !['K8S_LIST', 'K8S_WATCH'].includes(input.source) ||
      !['PRESENT', 'MISSING', 'READ_FAILED', 'STOPPED'].includes(input.kind)) {
    throw new DurableDatabaseError('LIFECYCLE_OBSERVATION')
  }
  const { context } = input
  const json = { ...input, context: { runtimeUnitId: context.runtimeUnitId, operationId: context.operationId,
    controller: { scope: context.controller.scope, owner: context.controller.owner, term: context.controller.term } } }
  const payloadHash = inputDigest(json)
  const members = await discoverUnitMembers(pool, context.runtimeUnitId)
  return runDurableMutation(pool, {
    key: { principalId: context.controller.owner, sessionScope: `runtime-unit:${context.runtimeUnitId}`,
      method: 'lifecycle.record-observation', operationKey: `${input.producerId}:${input.sequence}` },
    payloadHash, locks: { sessionIds: members, runtimeUnitIds: [context.runtimeUnitId], operationIds: [context.operationId] }
  }, async tx => {
    await lockUnitMembers(tx, context.runtimeUnitId, members)
    await LockedGatewayAuthority.acquire(tx, context)
    const target = await tx.query(`SELECT a.id FROM durable_runtime.attempts a
      WHERE a.id=$1 AND a.runtime_unit_id=$2 AND a.pod_uid=$3 AND a.execution_epoch=$4`,
      [input.attemptId, context.runtimeUnitId, input.podUid, input.executionEpoch])
    if (target.rowCount !== 1) { throw new DurableDatabaseError('LIFECYCLE_OBSERVATION_TARGET') }
    const current = await tx.query<{ revision: string }>(`SELECT u.revision FROM durable_runtime.runtime_units u JOIN durable_runtime.operations o ON o.runtime_unit_id=u.id
      WHERE u.id=$1 AND o.id=$2 AND u.active_attempt_id=$3 AND u.execution_epoch=$4 AND u.intent_revision=$5
      AND o.intent_revision=$5 AND o.step_revision=$6 AND o.controller_term=$7 AND o.expected_pod_uid=$8
      AND o.controller_term=$9`,
      [context.runtimeUnitId, context.operationId, input.attemptId, input.executionEpoch,
      input.originalIntentRevision, input.originalStepRevision, input.originalControllerTerm, input.podUid, context.controller.term])
    const watermark = await tx.query(`SELECT id FROM durable_runtime.runtime_audit_events
      WHERE runtime_unit_id=$1 AND attempt_id=$2 AND kind='RECONCILE_OBSERVATION'
      AND producer_id=$3 AND (next_state->>'watermark')::bigint>=$4::bigint`,
      [context.runtimeUnitId, input.attemptId, input.producerId, input.watermark])
    const stale = !current.rowCount || !!watermark.rowCount
    const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now
    const event = { kind: 'RECONCILE_OBSERVATION', observationKind: input.kind, source: input.source,
      resourceVersion: input.resourceVersion, watermark: input.watermark, stale,
      originalIntentRevision: input.originalIntentRevision, originalStepRevision: input.originalStepRevision,
      originalControllerTerm: input.originalControllerTerm, physicalFenceVerified: false }
    const observationAuditId = await appendAudit(tx, { actorId: context.controller.owner, runtimeUnitId: context.runtimeUnitId,
      operationId: context.operationId, attemptId: input.attemptId, podUid: input.podUid,
      kind: 'RECONCILE_OBSERVATION', nextState: event, occurredAt: now, receivedAt: now,
      producerId: input.producerId, producerSeq: input.sequence, evidenceRefs: [] })
    // Every raw STOPPED report remains audit history. In particular stopped_at
    // is a verified-stop boundary consumed by UNKNOWN dispatch safety checks;
    // neither K8s object presence nor container status may write it here.
    if (!stale) {
      let revision = current.rows[0].revision
      if (input.kind === 'READ_FAILED' || input.kind === 'MISSING') {
        const loss = await recordObservationLoss(tx, { actorId: context.controller.owner,
          operationId: context.operationId,
          target: { runtimeUnitId: context.runtimeUnitId, attemptId: input.attemptId,
            podUid: input.podUid as PodUid, executionEpoch: input.executionEpoch },
          // K8s observer sequence is not an authenticated Agent producer stream.
          // Its exact original source remains in the audit event referenced here.
          source: { kind: input.source, reference: `audit-event:${observationAuditId}`, stream: null, watermark: null } })
        revision = loss.unitRevision
      }
      // Presence/STOPPED does not renew Agent/provider/context/activity facts,
      // clear an observation-loss episode or change an authoritative phase.
      await enqueueOutbox(tx, { eventId: logicalId('event', randomUUID()), aggregateId: context.runtimeUnitId,
        aggregateKind: 'runtime-unit', revision: counter('row:runtime-unit', revision), event })
    }
    return { disposition: stale ? 'STALE_HISTORY_ONLY' : 'RECORDED_UNVERIFIED', ...event }
  })
}
