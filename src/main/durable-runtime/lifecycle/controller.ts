import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import type { RowRevision, IntentRevision, StepRevision, SessionId } from '../../../shared/durable-runtime/identity.ts'
import { runDurableMutation, type JsonValue, type MutationOutcome } from '../db/atomic.ts'
import { DurableDatabaseError, type DurableTransaction } from '../db/connection.ts'
import type { RuntimeUnitRow } from '../db/rows.ts'
import { appendAudit, enqueueOutbox } from '../journal/store.ts'
import { LockedGatewayAuthority } from '../runtime/gateway/authority.ts'
import { submitCommand, originalIdentity, takeOverCommand } from '../runtime/gateway/store.ts'
import { claimCommand } from '../runtime/gateway/claim.ts'
import { inputDigest } from '../runtime/gateway/input.ts'
import type { CommandClaim, ExecutorId, GatewayContext, CommandRow } from '../runtime/gateway/types.ts'
import type { CommandEnvelope } from '../runtime/command-types.ts'
import type { PodUid, PayloadHash } from '../runtime/runtime-evidence.ts'
import { discoverUnitMembers, lockUnitMembers } from './locks.ts'
import type { LifecycleOperation } from './types.ts'
import { snapshotCommandInput, snapshotGatewayContext } from './reconcile-request.ts'

export type InitialWakeExpiryRequest = {
  readonly context: GatewayContext
  readonly mutationKey: string
  readonly expectedUnitRevision: RowRevision<'runtime-unit'>
  readonly expectedIntentRevision: IntentRevision
  readonly expectedStepRevision: StepRevision
}
export type ReconcileStepRequest = InitialWakeExpiryRequest & {
  readonly step: 'ENSURE_ATTEMPT' | 'FENCE_ATTEMPT'
  readonly executorId: ExecutorId
  readonly input: JsonValue
}
export type PreparedReconcileStep = {
  readonly mutation: MutationOutcome
  readonly execution:
    | { readonly disposition: 'COMMITTED_EXECUTE'; readonly claim: CommandClaim }
    | { readonly disposition: 'NO_EXECUTION'; readonly reason: string }
}

// This core records claims, not effects. A returned transaction-local claim is
// never exposed as an execution disposition until P1-03 confirms COMMITTED.
export async function prepareReconcileStep(pool: Pool, caller: ReconcileStepRequest): Promise<PreparedReconcileStep> {
  const request: ReconcileStepRequest = Object.freeze({
    ...caller, context: snapshotGatewayContext(caller.context), input: snapshotCommandInput(caller.input)
  })
  const { context } = request
  counter('row:runtime-unit', request.expectedUnitRevision)
  counter('intent-revision', request.expectedIntentRevision)
  counter('step-revision', request.expectedStepRevision)
  if (!request.mutationKey || !['ENSURE_ATTEMPT', 'FENCE_ATTEMPT'].includes(request.step)) {
    throw new DurableDatabaseError('LIFECYCLE_STEP')
  }
  const bodyHash = inputDigest({ context: { runtimeUnitId: context.runtimeUnitId, operationId: context.operationId,
    controller: { scope: context.controller.scope, owner: context.controller.owner, term: context.controller.term } },
    expectedUnitRevision: request.expectedUnitRevision, expectedIntentRevision: request.expectedIntentRevision,
    expectedStepRevision: request.expectedStepRevision, step: request.step, executorId: request.executorId, input: request.input })
  const members = await discoverUnitMembers(pool, context.runtimeUnitId)
  let provisional: CommandClaim | null = null
  const mutation = await runDurableMutation(pool, {
    key: { principalId: context.controller.owner, sessionScope: `runtime-unit:${context.runtimeUnitId}`,
      method: 'lifecycle.prepare-reconcile-step', operationKey: request.mutationKey }, payloadHash: bodyHash,
    locks: { sessionIds: members, runtimeUnitIds: [context.runtimeUnitId], operationIds: [context.operationId] }
  }, async (tx): Promise<JsonValue> => {
    const state = await lockedReconcileState(tx, request, members, 'STEP')
    if (state.preliminary) { return state.preliminary }
    const { authority, unit, operation, clock } = state
    if (operation.deadline_at && operation.deadline_at <= clock) {
      if (request.step === 'ENSURE_ATTEMPT') { return recordInitialWakeExpiry(tx, request, state) }
      return { disposition: 'DEADLINE_EXPIRED', operationId: operation.id }
    }
    if (operation.retry_at && operation.retry_at > clock) {
      return { disposition: 'RETRY_NOT_DUE', operationId: operation.id }
    }
    if (request.step === 'ENSURE_ATTEMPT') {
      if (unit.desired_mode !== 'RUNNING') { throw new DurableDatabaseError('LIFECYCLE_STEP_STALE') }
      // An earlier attempt blocks a new writer until orphan reconciliation has
      // observed its Pod absent and stopped it (grants revoked, epoch fenced).
      const prior = await tx.query('SELECT id FROM durable_runtime.attempts WHERE runtime_unit_id=$1 AND stopped_at IS NULL', [context.runtimeUnitId])
      const grants = await tx.query(`SELECT g.id FROM durable_runtime.storage_write_grants g
        WHERE g.state<>'REVOKED' AND EXISTS(SELECT 1 FROM durable_runtime.runtime_member_storage_bindings m
          WHERE m.storage_binding_id=g.storage_binding_id AND m.runtime_unit_id=$1)`, [context.runtimeUnitId])
      if (unit.active_attempt_id || prior.rowCount || grants.rowCount) {
        const blocked = await tx.query<{ revision: string }>(`UPDATE durable_runtime.runtime_units
          SET phase='BLOCKED',revision=revision+1 WHERE id=$1 AND revision=$2
          AND EXISTS(SELECT 1 FROM durable_runtime.controller_leases c WHERE c.scope=$3 AND c.owner=$4
            AND c.term=$5 AND c.expires_at>clock_timestamp()) RETURNING revision`,
          [context.runtimeUnitId, request.expectedUnitRevision, context.controller.scope, context.controller.owner, context.controller.term])
        if (blocked.rowCount !== 1) { throw new DurableDatabaseError('LIFECYCLE_STEP_STALE') }
        const event: JsonValue = { kind: 'RECONCILE_BLOCKED', operationId: operation.id, reason: 'PHYSICAL_FENCE_UNVERIFIED' }
        await appendAudit(tx, { actorId: context.controller.owner, runtimeUnitId: context.runtimeUnitId,
          operationId: operation.id, kind: 'RECONCILE_BLOCKED', nextState: event, occurredAt: clock, receivedAt: clock,
          producerId: context.runtimeUnitId, producerSeq: counter('sequence:producer', blocked.rows[0].revision), evidenceRefs: [] })
        await enqueueOutbox(tx, { eventId: logicalId('event', randomUUID()), aggregateId: context.runtimeUnitId,
          aggregateKind: 'runtime-unit', revision: counter('row:runtime-unit', blocked.rows[0].revision), event })
        return { disposition: 'PHYSICAL_FENCE_UNVERIFIED', operationId: operation.id }
      }
    } else if ((operation.kind === 'SLEEP' && unit.desired_mode !== 'SUSPENDED') ||
               (operation.kind === 'DELETE' && unit.desired_mode !== 'DELETED')) {
      throw new DurableDatabaseError('LIFECYCLE_STEP_STALE')
    } else if (!unit.active_attempt_id || operation.expected_pod_uid === null) {
      return { disposition: 'NO_CURRENT_FENCE_TARGET', operationId: operation.id }
    }
    const advanced = await tx.query<LifecycleOperation>(`UPDATE durable_runtime.operations SET step=$2,
      step_revision=step_revision+1,revision=revision+1 WHERE id=$1 AND step_revision=$3 AND controller_term=$4
      AND EXISTS(SELECT 1 FROM durable_runtime.controller_leases c WHERE c.scope=$5 AND c.owner=$6 AND c.term=$4 AND c.expires_at>clock_timestamp()) RETURNING *`,
      [operation.id, request.step, request.expectedStepRevision, context.controller.term, context.controller.scope, context.controller.owner])
    if (advanced.rowCount !== 1) { throw new DurableDatabaseError('LIFECYCLE_STEP_STALE') }
    const after = advanced.rows[0]
    const envelope: CommandEnvelope = after.expected_pod_uid === null
      ? { operationId: operation.id, controllerTerm: context.controller.term, stepRevision: after.step_revision,
          executionEpoch: after.execution_epoch, intentRevision: after.intent_revision, podTarget: 'CREATE_WITHOUT_POD', expectedPodUid: null }
      : { operationId: operation.id, controllerTerm: context.controller.term, stepRevision: after.step_revision,
          executionEpoch: after.execution_epoch, intentRevision: after.intent_revision, podTarget: 'EXISTING_POD', expectedPodUid: after.expected_pod_uid as PodUid }
    const input: JsonValue = { resourceName: after.external_resource_name, body: request.input }
    const submitted = await submitCommand(authority, { command: request.step === 'ENSURE_ATTEMPT' ? 'ensureAttempt' : 'fenceAttempt',
      // inputDigest computes the canonical SHA-256 bytes; this nominal type
      // marks that computed hash, never a provider/fence evidence claim.
      envelope, input, inputHash: inputDigest(input) as PayloadHash, predecessor: { kind: 'NONE' } })
    if (submitted.disposition === 'BLOCKED_BY_UNRESOLVED_COMMAND') {
      return { disposition: submitted.disposition, commandId: submitted.command.id }
    }
    const claimed = await claimCommand(authority, originalIdentity(submitted.command), request.executorId)
    if (claimed.disposition !== 'CLAIMED') { return { disposition: 'LOOKUP_ORIGINAL', commandId: claimed.command.id } }
    provisional = claimed.claim
    const changed = await tx.query<{ revision: string }>(`UPDATE durable_runtime.runtime_units SET revision=revision+1,
      phase=$2 WHERE id=$1 AND revision=$3 RETURNING revision`, [context.runtimeUnitId,
      request.step === 'ENSURE_ATTEMPT' ? 'PROVISIONING' : 'QUIESCING', request.expectedUnitRevision])
    if (changed.rowCount !== 1) { throw new DurableDatabaseError('LIFECYCLE_STEP_STALE') }
    const event: JsonValue = { kind: 'RECONCILE_STEP_CLAIMED', operationId: operation.id, commandId: claimed.command.id,
      stepRevision: after.step_revision, intentRevision: after.intent_revision }
    await appendAudit(tx, { actorId: context.controller.owner, runtimeUnitId: context.runtimeUnitId,
      operationId: operation.id, kind: 'RECONCILE_STEP_CLAIMED', nextState: event, occurredAt: clock, receivedAt: clock,
      producerId: context.runtimeUnitId, producerSeq: counter('sequence:producer', changed.rows[0].revision), evidenceRefs: [] })
    await enqueueOutbox(tx, { eventId: logicalId('event', randomUUID()), aggregateId: context.runtimeUnitId,
      aggregateKind: 'runtime-unit', revision: counter('row:runtime-unit', changed.rows[0].revision), event })
    return { disposition: 'CLAIMED', commandId: claimed.command.id }
  })
  // Only the successful current callback's claim can be authorized. Stored
  // replayed responses never reconstruct a permission or trigger effects.
  return { mutation, execution: mutation.status === 'COMMITTED' && provisional !== null
    ? { disposition: 'COMMITTED_EXECUTE', claim: provisional }
    : { disposition: 'NO_EXECUTION', reason: mutationReason(mutation) } }
}

type ReconcileState = {
  readonly authority: LockedGatewayAuthority
  readonly unit: RuntimeUnitRow
  readonly operation: LifecycleOperation
  readonly clock: Date
  readonly preliminary: JsonValue | null
}

// Both entry points share actual locks, lease, pending and CAS checks.
async function lockedReconcileState(tx: DurableTransaction, request: InitialWakeExpiryRequest,
  members: readonly SessionId[], mode: 'STEP' | 'EXPIRY'): Promise<ReconcileState> {
  const { context } = request
  await lockUnitMembers(tx, context.runtimeUnitId, members)
  const authority = await LockedGatewayAuthority.acquire(tx, context)
  const unit = (await tx.query<RuntimeUnitRow>('SELECT * FROM durable_runtime.runtime_units WHERE id=$1', [context.runtimeUnitId])).rows[0]
  let operation = (await tx.query<LifecycleOperation>('SELECT * FROM durable_runtime.operations WHERE id=$1', [context.operationId])).rows[0]
  const clock = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now
  if (mode === 'STEP') { operation = await adoptOperation(tx, request, operation, clock) }
  // Same rule as the one-unresolved-command index: an UNKNOWN input dispatch is
  // kept history (R03) and never holds the Unit's lifecycle step.
  const pending = await tx.query<CommandRow>(`SELECT * FROM durable_runtime.runtime_commands
    WHERE runtime_unit_id=$1 AND (state IN ('ACCEPTED','EXECUTING') OR (state='UNKNOWN' AND command_name<>'dispatchInput'))`,
  [context.runtimeUnitId])
  if (pending.rows[0]) {
    const command = pending.rows[0]
    if (mode === 'STEP' && command.operation_id === operation.id) { await takeOverCommand(authority, originalIdentity(command)) }
    return { authority, unit, operation, clock, preliminary: { disposition: 'LOOKUP_ORIGINAL', commandId: command.id, state: command.state } }
  }
  if (operation.intent_revision !== unit.intent_revision || unit.intent_revision !== request.expectedIntentRevision ||
      unit.revision !== request.expectedUnitRevision || operation.step_revision !== request.expectedStepRevision ||
      operation.execution_epoch !== unit.execution_epoch || (mode === 'STEP' && operation.result !== null)) {
    throw new DurableDatabaseError('LIFECYCLE_STEP_STALE')
  }
  return { authority, unit, operation, clock, preliminary: null }
}

// Normal steps retain adoption before pending/stale handling. Expiry-only
// adoption is deferred until every terminal no-effect condition has passed.
export async function adoptOperation(tx: DurableTransaction, request: InitialWakeExpiryRequest,
  operation: LifecycleOperation, clock: Date): Promise<LifecycleOperation> {
  const { context } = request
  // Actual lease has already been locked/validated by the gateway. This
  // explicit adoption preserves name/deadline/retry/original command identity.
  const adopted = await tx.query<LifecycleOperation>(`UPDATE durable_runtime.operations SET controller_term=$2,revision=revision+1
    WHERE id=$1 AND controller_term<>$2 AND EXISTS(SELECT 1 FROM durable_runtime.controller_leases c
      WHERE c.scope=$3 AND c.owner=$4 AND c.term=$2 AND c.expires_at>clock_timestamp()) RETURNING *`,
    [operation.id, context.controller.term, context.controller.scope, context.controller.owner])
  if (adopted.rows[0]) {
    const beforeTerm = operation.controller_term
    operation = adopted.rows[0]
    const event: JsonValue = { kind: 'RECONCILE_OPERATION_ADOPTED', operationId: operation.id,
      previousTerm: beforeTerm, controllerTerm: operation.controller_term }
    await appendAudit(tx, { actorId: context.controller.owner, runtimeUnitId: context.runtimeUnitId,
      operationId: operation.id, kind: 'RECONCILE_OPERATION_ADOPTED', nextState: event,
      occurredAt: clock, receivedAt: clock, producerId: operation.id,
      producerSeq: counter('sequence:producer', operation.revision), evidenceRefs: [] })
    await enqueueOutbox(tx, { eventId: logicalId('event', randomUUID()), aggregateId: operation.id,
      aggregateKind: 'operation', revision: operation.revision, event })
  }
  return operation
}

// One SQL guard and terminal mutation shared by the step and expiry-only paths.
// This function never submits a command or constructs an execution claim.
async function recordInitialWakeExpiry(tx: DurableTransaction, request: InitialWakeExpiryRequest,
  state: ReconcileState): Promise<JsonValue> {
  const { context } = request
  const { unit, clock } = state
  let { operation } = state
  const deadlineAt = operation.deadline_at
  if (deadlineAt === null || deadlineAt > clock) {
    return { disposition: 'DEADLINE_NOT_EXPIRED', operationId: operation.id }
  }
  // Only the initial WAKE with no accepted/planned/executed footprint can
  // become terminal here. Pending commands already took the lookup branch.
  const initial = operation.result === null && operation.kind === 'WAKE' &&
    operation.step === 'INTENT_QUEUED' && operation.step_revision === '0' &&
    operation.expected_pod_uid === null && unit.desired_mode === 'RUNNING' && unit.active_attempt_id === null
  if (initial) {
    const commands = await tx.query('SELECT id FROM durable_runtime.runtime_commands WHERE operation_id=$1 AND runtime_unit_id=$2 LIMIT 1',
      [operation.id, context.runtimeUnitId])
    const plans = await tx.query('SELECT operation_id FROM durable_runtime.agent_pod_plans WHERE operation_id=$1 AND runtime_unit_id=$2 LIMIT 1',
      [operation.id, context.runtimeUnitId])
    const attempts = await tx.query('SELECT id FROM durable_runtime.attempts WHERE runtime_unit_id=$1 LIMIT 1', [context.runtimeUnitId])
    const executions = await tx.query("SELECT id FROM durable_runtime.execution_grants WHERE runtime_unit_id=$1 AND state<>'REVOKED' LIMIT 1", [context.runtimeUnitId])
    // Protected member bindings can retain another owner's writer grant
    // even when this Unit has never had an attempt. Shared RW is not queried.
    const writers = await tx.query(`SELECT g.id FROM durable_runtime.storage_write_grants g
      WHERE g.state<>'REVOKED' AND EXISTS(SELECT 1 FROM durable_runtime.runtime_member_storage_bindings m
        WHERE m.storage_binding_id=g.storage_binding_id AND m.runtime_unit_id=$1) LIMIT 1`, [context.runtimeUnitId])
    if (commands.rowCount === 0 && plans.rowCount === 0 && attempts.rowCount === 0 &&
        executions.rowCount === 0 && writers.rowCount === 0) {
      if (operation.controller_term !== context.controller.term) { operation = await adoptOperation(tx, request, operation, clock) }
      const reason = 'DEADLINE_EXPIRED_BEFORE_ACCEPTANCE'
      const result = { state: 'FAILED', reason }
      const failed = await tx.query<LifecycleOperation>(`UPDATE durable_runtime.operations SET step='FAILED',
        step_revision=step_revision+1,revision=revision+1,result=$8::jsonb
        WHERE id=$1 AND runtime_unit_id=$2 AND revision=$3 AND step_revision=$4 AND controller_term=$5
        AND kind='WAKE' AND step='INTENT_QUEUED' AND result IS NULL AND expected_pod_uid IS NULL
        AND execution_epoch=$6 AND intent_revision=$7 AND deadline_at<=$9::timestamptz
        AND EXISTS(SELECT 1 FROM durable_runtime.controller_leases c WHERE c.scope=$10 AND c.owner=$11
          AND c.term=$5 AND c.expires_at>clock_timestamp()) RETURNING *`,
      [operation.id, context.runtimeUnitId, operation.revision, request.expectedStepRevision, context.controller.term,
        operation.execution_epoch, operation.intent_revision, JSON.stringify(result), clock, context.controller.scope, context.controller.owner])
      if (failed.rowCount !== 1) { throw new DurableDatabaseError('LIFECYCLE_STEP_STALE') }
      const blocked = await tx.query<{ revision: string }>(`UPDATE durable_runtime.runtime_units SET phase='BLOCKED',revision=revision+1
        WHERE id=$1 AND revision=$2 AND desired_mode='RUNNING' AND active_attempt_id IS NULL
        AND execution_epoch=$3 AND intent_revision=$4
        AND EXISTS(SELECT 1 FROM durable_runtime.controller_leases c WHERE c.scope=$5 AND c.owner=$6
          AND c.term=$7 AND c.expires_at>clock_timestamp()) RETURNING revision`,
      [context.runtimeUnitId, request.expectedUnitRevision, operation.execution_epoch, operation.intent_revision,
        context.controller.scope, context.controller.owner, context.controller.term])
      if (blocked.rowCount !== 1) { throw new DurableDatabaseError('LIFECYCLE_STEP_STALE') }
      const event: JsonValue = { kind: 'RECONCILE_OPERATION_DEADLINE_EXPIRED', operationId: operation.id,
        runtimeUnitId: context.runtimeUnitId, state: 'FAILED', reason, phase: 'BLOCKED',
        deadlineAt: deadlineAt.toISOString(), retryAt: operation.retry_at?.toISOString() ?? null,
        executionEpoch: operation.execution_epoch, intentRevision: operation.intent_revision,
        operationRevision: failed.rows[0].revision, stepRevision: failed.rows[0].step_revision,
        unitRevision: blocked.rows[0].revision, terminalRecorded: true }
      await appendAudit(tx, { actorId: context.controller.owner, runtimeUnitId: context.runtimeUnitId,
        operationId: operation.id, kind: 'RECONCILE_OPERATION_DEADLINE_EXPIRED', reasonCode: reason,
        previousState: { step: operation.step, stepRevision: operation.step_revision, operationRevision: operation.revision,
          phase: unit.phase, unitRevision: unit.revision }, nextState: event, occurredAt: clock, receivedAt: clock,
        producerId: operation.id, producerSeq: counter('sequence:producer', failed.rows[0].revision), evidenceRefs: [] })
      await enqueueOutbox(tx, { eventId: logicalId('event', randomUUID()), aggregateId: context.runtimeUnitId,
        aggregateKind: 'runtime-unit', revision: counter('row:runtime-unit', blocked.rows[0].revision), event })
      return { disposition: 'DEADLINE_EXPIRED', operationId: operation.id, terminalRecorded: true,
        state: 'FAILED', phase: 'BLOCKED', operationRevision: failed.rows[0].revision, unitRevision: blocked.rows[0].revision }
    }
  }
  return { disposition: 'DEADLINE_EXPIRED', operationId: operation.id }
}

function mutationReason(mutation: MutationOutcome): string {
  return mutation.status === 'UNCERTAIN' ? 'UNCERTAIN_COMMIT' : mutation.status === 'REPLAYED' ? 'RECEIPT_REPLAY' :
    String((mutation.receipt.response as { disposition: string }).disposition)
}

/** Internal planner-independent expiry only. Caller supplies authenticated
 * controller context; receipt replay never reconstructs execution permission. */
export async function expireInitialWake(pool: Pool, caller: InitialWakeExpiryRequest):
  Promise<{ mutation: MutationOutcome; reason: string }> {
  const request: InitialWakeExpiryRequest = Object.freeze({ context: snapshotGatewayContext(caller.context),
    mutationKey: caller.mutationKey, expectedUnitRevision: counter('row:runtime-unit', caller.expectedUnitRevision),
    expectedIntentRevision: counter('intent-revision', caller.expectedIntentRevision),
    expectedStepRevision: counter('step-revision', caller.expectedStepRevision) })
  if (typeof request.mutationKey !== 'string' || !request.mutationKey) { throw new DurableDatabaseError('LIFECYCLE_STEP') }
  const { context } = request
  const payloadHash = inputDigest({ context: { runtimeUnitId: context.runtimeUnitId, operationId: context.operationId,
    controller: { scope: context.controller.scope, owner: context.controller.owner, term: context.controller.term } },
    expectedUnitRevision: request.expectedUnitRevision, expectedIntentRevision: request.expectedIntentRevision,
    expectedStepRevision: request.expectedStepRevision })
  const members = await discoverUnitMembers(pool, context.runtimeUnitId)
  const mutation = await runDurableMutation(pool, {
    key: { principalId: context.controller.owner, sessionScope: `runtime-unit:${context.runtimeUnitId}`,
      method: 'lifecycle.expire-initial-wake', operationKey: request.mutationKey }, payloadHash,
    locks: { sessionIds: members, runtimeUnitIds: [context.runtimeUnitId], operationIds: [context.operationId] }
  }, async tx => {
    const state = await lockedReconcileState(tx, request, members, 'EXPIRY')
    return state.preliminary ?? recordInitialWakeExpiry(tx, request, state)
  })
  return { mutation, reason: mutationReason(mutation) }
}
