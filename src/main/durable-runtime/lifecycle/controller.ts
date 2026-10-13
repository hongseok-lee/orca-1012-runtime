import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import type { RowRevision, IntentRevision, StepRevision } from '../../../shared/durable-runtime/identity.ts'
import { runDurableMutation, type JsonValue, type MutationOutcome } from '../db/atomic.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import { appendAudit, enqueueOutbox } from '../journal/store.ts'
import { LockedGatewayAuthority } from '../runtime/gateway/authority.ts'
import { submitCommand, originalIdentity, takeOverCommand } from '../runtime/gateway/store.ts'
import { claimCommand } from '../runtime/gateway/claim.ts'
import { inputDigest } from '../runtime/gateway/input.ts'
import type { CommandClaim, ExecutorId, GatewayContext, CommandRow } from '../runtime/gateway/types.ts'
import type { CommandEnvelope } from '../runtime/command-types.ts'
import type { PodUid } from '../runtime/runtime-evidence.ts'
import { discoverUnitMembers, lockUnitMembers } from './locks.ts'
import type { LifecycleOperation } from './types.ts'
import { snapshotCommandInput, snapshotGatewayContext } from './reconcile-request.ts'

export type ReconcileStepRequest = {
  readonly context: GatewayContext
  readonly mutationKey: string
  readonly expectedUnitRevision: RowRevision<'runtime-unit'>
  readonly expectedIntentRevision: IntentRevision
  readonly expectedStepRevision: StepRevision
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
  }, async tx => {
    await lockUnitMembers(tx, context.runtimeUnitId, members)
    const authority = await LockedGatewayAuthority.acquire(tx, context)
    const unit = (await tx.query<{ revision: string; intent_revision: string; execution_epoch: string;
      active_attempt_id: string | null; desired_mode: string }>('SELECT * FROM durable_runtime.runtime_units WHERE id=$1', [context.runtimeUnitId])).rows[0]
    let operation = (await tx.query<LifecycleOperation>('SELECT * FROM durable_runtime.operations WHERE id=$1', [context.operationId])).rows[0]
    const clock = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now
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
    const pending = await tx.query<CommandRow>(`SELECT * FROM durable_runtime.runtime_commands
      WHERE runtime_unit_id=$1 AND state IN ('ACCEPTED','EXECUTING','UNKNOWN')`, [context.runtimeUnitId])
    if (pending.rows[0]) {
      const command = pending.rows[0]
      if (command.operation_id === operation.id) { await takeOverCommand(authority, originalIdentity(command)) }
      return { disposition: 'LOOKUP_ORIGINAL', commandId: command.id, state: command.state }
    }
    if (operation.intent_revision !== unit.intent_revision || unit.intent_revision !== request.expectedIntentRevision ||
        unit.revision !== request.expectedUnitRevision || operation.step_revision !== request.expectedStepRevision ||
        operation.execution_epoch !== unit.execution_epoch || operation.result !== null) {
      throw new DurableDatabaseError('LIFECYCLE_STEP_STALE')
    }
    if (operation.deadline_at && operation.deadline_at <= clock) {
      return { disposition: 'DEADLINE_EXPIRED', operationId: operation.id }
    }
    if (operation.retry_at && operation.retry_at > clock) {
      return { disposition: 'RETRY_NOT_DUE', operationId: operation.id }
    }
    if (request.step === 'ENSURE_ATTEMPT') {
      if (unit.desired_mode !== 'RUNNING') { throw new DurableDatabaseError('LIFECYCLE_STEP_STALE') }
      // Absence/STOPPED/status strings are not permanent compute-stop proof.
      // No G04 verifier is supplied, so any earlier attempt keeps new writer
      // admission BLOCKED. Never reset epoch/grants or infer safe replacement.
      const prior = await tx.query('SELECT id FROM durable_runtime.attempts WHERE runtime_unit_id=$1', [context.runtimeUnitId])
      const grants = await tx.query(`SELECT g.id FROM durable_runtime.storage_write_grants g JOIN durable_runtime.runtime_members m
        ON m.storage_binding_id=g.storage_binding_id WHERE m.runtime_unit_id=$1 AND g.state<>'REVOKED'`, [context.runtimeUnitId])
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
      envelope, input, inputHash: inputDigest(input), predecessor: { kind: 'NONE' } })
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
    : { disposition: 'NO_EXECUTION', reason: mutation.status === 'UNCERTAIN' ? 'UNCERTAIN_COMMIT' :
        mutation.status === 'REPLAYED' ? 'RECEIPT_REPLAY' : String((mutation.receipt.response as { disposition: string }).disposition) } }
}
