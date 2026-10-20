import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { runDurableMutation, type JsonValue } from '../db/atomic.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import type { SessionId, RowRevision, IntentRevision, StepRevision } from '../../../shared/durable-runtime/identity.ts'
import type { GatewayContext, ExecutorId, CommandClaim } from './gateway/types.ts'
import type { CommandEnvelope, SettledCommandReceipt } from './command-types.ts'
import type { PayloadHash, PodUid } from './runtime-evidence.ts'
import { LockedGatewayAuthority, currentAuthoritySql } from './gateway/authority.ts'
import { inputDigest } from './gateway/input.ts'
import { submitCommand, originalIdentity } from './gateway/store.ts'
import { claimCommand } from './gateway/claim.ts'
import { immutableSnapshot } from '../providers/shared/recovery-renderer.ts'
import { appendAudit, enqueueOutbox } from '../journal/store.ts'
import { captureReleaseGateInput } from './release-gate-input.ts'
import { readAgentPodPlan } from './agent-pod-plan-records.ts'

/** Continuation of the EXISTING cold operation, not a new wake, replacement
 * attempt, deadline extension or execution permit. Only the current callback's
 * claim can leave with an actual COMMITTED mutation; receipt replay cannot
 * reconstruct an effect capability. */
export async function prepareInitialProviderStep(pool: Pool, original: Readonly<{
  context: GatewayContext; sessionId: SessionId; mutationKey: string
  expectedUnitRevision: RowRevision<'runtime-unit'>; expectedIntentRevision: IntentRevision
  expectedStepRevision: StepRevision; step: 'BIND' | 'RELEASE_GATE'
  executorId: ExecutorId; input: JsonValue
  predecessor: Extract<SettledCommandReceipt<JsonValue>, { state: 'RESOLVED' }>
}>) {
  const request = immutableSnapshot(original)
  const coldGate = request.step === 'RELEASE_GATE' ? captureReleaseGateInput(request.input) : null
  if (coldGate && !coldGate.coldStart) { throw new DurableDatabaseError('INITIAL_PROVIDER_NEW_GATE_REQUIRED') }
  const predecessorName = request.step === 'BIND' ? 'ensureAttempt' : 'bind'
  if (!request.mutationKey || !['BIND', 'RELEASE_GATE'].includes(request.step) ||
      request.predecessor.identity.command !== predecessorName || request.predecessor.state !== 'RESOLVED') {
    throw new DurableDatabaseError('INITIAL_PROVIDER_STEP_INPUT')
  }
  let provisional: CommandClaim | null = null
  const mutation = await runDurableMutation(pool, {
    key: { principalId: request.context.controller.owner, sessionScope: `runtime-unit:${request.context.runtimeUnitId}`,
      method: 'lifecycle.prepare-initial-provider-step', operationKey: request.mutationKey },
    payloadHash: inputDigest(JSON.parse(JSON.stringify(request))),
    locks: { sessionIds: [request.sessionId], runtimeUnitIds: [request.context.runtimeUnitId], operationIds: [request.context.operationId] },
  }, async tx => {
    const context = request.context
    const members = await tx.query<{ session_id: string }>(
      'SELECT session_id FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1', [context.runtimeUnitId])
    if (members.rowCount !== 1 || members.rows[0].session_id !== request.sessionId) {
      throw new DurableDatabaseError('INITIAL_PROVIDER_STEP_MEMBER_SET')
    }
    const authority = await LockedGatewayAuthority.acquire(tx, context)
    const pending = await tx.query<{ id: string }>(`SELECT id FROM durable_runtime.runtime_commands
      WHERE runtime_unit_id=$1 AND (state IN ('ACCEPTED','EXECUTING') OR (state='UNKNOWN' AND command_name NOT IN ('dispatchInput','cancel')))`,
    [context.runtimeUnitId])
    if (pending.rowCount) { return { disposition: 'LOOKUP_ORIGINAL', commandId: pending.rows[0].id } }
    const target = await tx.query<{ pod_uid: string; attempt_id: string; execution_epoch: string }>(
      `SELECT a.pod_uid,a.id AS attempt_id,u.execution_epoch FROM durable_runtime.runtime_units u
       JOIN durable_runtime.attempts a ON a.id=u.active_attempt_id JOIN durable_runtime.execution_grants g ON g.attempt_id=a.id
       JOIN durable_runtime.sessions s ON s.id=$3 WHERE u.id=$1 AND u.revision=$2 AND u.desired_mode='RUNNING'
       AND u.intent_revision=$4 AND a.mode='COLD' AND a.execution_epoch=u.execution_epoch AND a.pod_uid IS NOT NULL
       AND a.stopped_at IS NULL AND s.lifecycle='OPEN' AND g.execution_epoch=u.execution_epoch
       AND (($5='BIND' AND u.phase='PROVISIONING' AND a.status='POD_ASSIGNED' AND g.state='RESERVED')
         OR ($5='RELEASE_GATE' AND u.phase='REHYDRATING' AND a.status='BOUND' AND g.state='ACTIVE'))`,
      [context.runtimeUnitId, request.expectedUnitRevision, request.sessionId, request.expectedIntentRevision, request.step])
    if (target.rowCount !== 1) { throw new DurableDatabaseError('INITIAL_PROVIDER_STEP_STALE') }
    const actual = target.rows[0], previous = request.predecessor.identity.originalEnvelope
    if (coldGate) {
      const plan = await readAgentPodPlan(tx, context.operationId)
      if (!plan || coldGate.attemptId !== actual.attempt_id || plan.planDigest !== coldGate.coldStart?.planDigest ||
          plan.plan.identity.attemptId !== actual.attempt_id || plan.plan.identity.unitId !== context.runtimeUnitId ||
          plan.plan.identity.executionEpoch !== actual.execution_epoch) {
        throw new DurableDatabaseError('INITIAL_PROVIDER_NEW_GATE_PLAN')
      }
    }
    if (previous.operationId !== context.operationId || previous.executionEpoch !== actual.execution_epoch ||
        previous.intentRevision !== request.expectedIntentRevision || previous.stepRevision !== request.expectedStepRevision ||
        request.step === 'RELEASE_GATE' && previous.expectedPodUid !== actual.pod_uid) {
      throw new DurableDatabaseError('INITIAL_PROVIDER_STEP_PREDECESSOR')
    }
    const changed = await tx.query<{ step_revision: StepRevision; revision: string }>(`UPDATE durable_runtime.operations
      SET step=$5,step_revision=step_revision+1,revision=revision+1,expected_pod_uid=$6
      WHERE id=$4 AND runtime_unit_id=$7 AND controller_term=$3 AND controller_scope=$1 AND result IS NULL
      AND kind='WAKE' AND step_revision=$8 AND execution_epoch=$9 AND intent_revision=$10
      AND step=$11 AND expected_pod_uid IS NOT DISTINCT FROM $12
      AND (deadline_at IS NULL OR deadline_at>clock_timestamp()) AND ${currentAuthoritySql} RETURNING step_revision,revision`,
      [context.controller.scope, context.controller.owner, context.controller.term, context.operationId,
        request.step, actual.pod_uid, context.runtimeUnitId, request.expectedStepRevision, actual.execution_epoch, request.expectedIntentRevision,
        request.step === 'BIND' ? 'ENSURE_ATTEMPT' : 'BIND', previous.expectedPodUid])
    if (changed.rowCount !== 1) { throw new DurableDatabaseError('INITIAL_PROVIDER_STEP_DEADLINE_OR_STALE') }
    const envelope: CommandEnvelope = { operationId: context.operationId, controllerTerm: context.controller.term,
      stepRevision: changed.rows[0].step_revision, executionEpoch: previous.executionEpoch,
      intentRevision: previous.intentRevision, podTarget: 'EXISTING_POD', expectedPodUid: actual.pod_uid as PodUid }
    const submitted = await submitCommand(authority, { command: request.step === 'BIND' ? 'bind' : 'releaseGate', envelope,
      input: request.input, inputHash: inputDigest(request.input) as PayloadHash,
      predecessor: { kind: 'RECONCILED', receipt: request.predecessor } })
    if (submitted.disposition === 'BLOCKED_BY_UNRESOLVED_COMMAND') {
      throw new DurableDatabaseError('INITIAL_PROVIDER_STEP_UNRESOLVED')
    }
    const claimed = await claimCommand(authority, originalIdentity(submitted.command), request.executorId)
    if (claimed.disposition !== 'CLAIMED') { return { disposition: 'LOOKUP_ORIGINAL', commandId: claimed.command.id } }
    provisional = claimed.claim
    const event = { kind: 'INITIAL_PROVIDER_STEP_CLAIMED', operationId: context.operationId, step: request.step,
      stepRevision: changed.rows[0].step_revision, commandId: claimed.claim.commandId,
      attemptId: actual.attempt_id, podUid: actual.pod_uid }
    const audit = await appendAudit(tx, { actorId: context.controller.owner, runtimeUnitId: context.runtimeUnitId,
      operationId: context.operationId, sessionId: request.sessionId, kind: event.kind, nextState: event,
      occurredAt: new Date(), receivedAt: new Date(), producerId: randomUUID(), producerSeq: counter('sequence:producer', '1'), evidenceRefs: [] })
    await enqueueOutbox(tx, { eventId: logicalId('event', audit), aggregateId: context.operationId,
      aggregateKind: 'operation', revision: counter('row:operation', changed.rows[0].revision), event })
    await authority.assertCurrent()
    return { disposition: 'CLAIMED', commandId: logicalId('runtime-command', claimed.command.id) }
  })
  return Object.freeze({ mutation, execution: mutation.status === 'COMMITTED' && provisional !== null
    ? Object.freeze({ disposition: 'COMMITTED_EXECUTE' as const, claim: provisional })
    : Object.freeze({ disposition: 'NO_EXECUTION' as const }) })
}
