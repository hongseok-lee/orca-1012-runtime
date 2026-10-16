import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, type DurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { readAgentPodPlan } from '../runtime/agent-pod-plan-records.ts'
import { LockedGatewayAuthority } from '../runtime/gateway/authority.ts'
import { assertOriginal } from '../runtime/gateway/store.ts'
import { inputDigest, canonicalInput } from '../runtime/gateway/input.ts'
import type { CommandClaim, CommandRow, GatewayContext } from '../runtime/gateway/types.ts'
import type { InitialAgentAttemptInput } from '../runtime/initial-agent-attempt.ts'

type BindingRow = { id: string; backend_id: string; export_id: string; canonical_directory: string;
  revision: string; epoch: string; access_state: string; identity_proof_ref: string | null;
  identity_verified_at: Date | null; writer_attempt_id: string | null; seal_id: string | null }
type UnitRow = { revision: string; active_attempt_id: string | null; dataset_name: string;
  execution_epoch: string; intent_revision: string; desired_mode: string }
const deny = (suffix: string): never => { throw new DurableDatabaseError(`INITIAL_AGENT_${suffix}`) }
function text(value: string): string {
  if (typeof value !== 'string' || !value || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) { return deny('INPUT') }
  return value
}

/** Immutable original claim/revisions are captured before any pool checkout. */
export function captureInitialAgentAttemptContext(originalContext: GatewayContext, original: InitialAgentAttemptInput) {
  const c = originalContext.controller, supplied = original.claim, rawEnvelope = supplied.identity.originalEnvelope
  const context: GatewayContext = Object.freeze({ runtimeUnitId: logicalId('runtime-unit', originalContext.runtimeUnitId),
    operationId: logicalId('operation', originalContext.operationId), controller: Object.freeze({ ...c,
      scope: text(c.scope), owner: text(c.owner), term: counter('controller-term', c.term) }) })
  const claim: CommandClaim = Object.freeze({ visibility: supplied.visibility, commandId: supplied.commandId,
    executorId: supplied.executorId, executionToken: supplied.executionToken, controllerTerm: supplied.controllerTerm,
    identity: Object.freeze({ command: supplied.identity.command, inputHash: supplied.identity.inputHash,
      originalEnvelope: Object.freeze({ ...rawEnvelope }) }) })
  const e = claim.identity.originalEnvelope
  const expectedUnitRevision = counter('row:runtime-unit', original.expectedUnitRevision)
  const planDigest = text(original.planDigest)
  const expected = Object.freeze(original.bindings.map(b => Object.freeze({ bindingId: logicalId('storage-binding', b.bindingId),
    expectedRevision: counter('row:storage-binding', b.expectedRevision), storageEpoch: counter('storage-epoch', b.storageEpoch) }))
    .sort((a,b) => a.bindingId.localeCompare(b.bindingId)))
  if (!/^[0-9a-f]{64}$/u.test(planDigest) ||
      new Set(expected.map(b => b.bindingId)).size !== expected.length || claim.visibility !== 'TRANSACTION_LOCAL' ||
      claim.identity.command !== 'ensureAttempt' || e.podTarget !== 'CREATE_WITHOUT_POD' || e.expectedPodUid !== null ||
      e.operationId !== context.operationId || claim.controllerTerm !== context.controller.term) { return deny('INPUT') }
  const reservationDigest = inputDigest({ commandId: claim.commandId, executorId: claim.executorId,
    executionToken: claim.executionToken, controllerTerm: claim.controllerTerm, command: claim.identity.command,
    inputHash: claim.identity.inputHash, envelope: { operationId: e.operationId, controllerTerm: e.controllerTerm,
      stepRevision: e.stepRevision, executionEpoch: e.executionEpoch, intentRevision: e.intentRevision,
      podTarget: e.podTarget, expectedPodUid: e.expectedPodUid }, planDigest, expectedUnitRevision, bindings: [...expected] })
  const claimDigest = inputDigest({ commandId: claim.commandId, executorId: claim.executorId,
    executionToken: claim.executionToken, controllerTerm: claim.controllerTerm, command: claim.identity.command,
    inputHash: claim.identity.inputHash, originalEnvelope: { ...claim.identity.originalEnvelope } })
  const input: InitialAgentAttemptInput = Object.freeze({ claim, planDigest, expectedUnitRevision, bindings: expected })
  return Object.freeze({ context, input, claim, e, expectedUnitRevision, planDigest, expected, reservationDigest, claimDigest })
}

/** Original read-only reservation validation and lock order. No authority,
 * callback, audit, reservation or grant is issued here. */
export async function lockInitialAgentAttemptContext(tx: DurableTransaction,
  originalContext: GatewayContext, original: InitialAgentAttemptInput) {
  const query = tx.query.bind(tx)
  const captured = captureInitialAgentAttemptContext(originalContext, original)
  const { context, claim, e, expectedUnitRevision, planDigest, expected, reservationDigest, claimDigest } = captured
  const record = await readAgentPodPlan(tx, context.operationId)
  if (!record || record.planDigest !== planDigest) { return deny('PLAN') }
  const plan = record.plan, identity = plan.identity, dataset = plan.pod.metadata.labels['orca.dev/dataset']
  const profileRevision = plan.pod.metadata.annotations['orca.dev/resource-profile-revision']
  const protectedBindings = plan.mountExpectations.protected
  if (identity.unitId !== context.runtimeUnitId || identity.operationId !== context.operationId ||
      e.executionEpoch !== identity.executionEpoch || e.intentRevision !== identity.intentRevision ||
      canonicalInput(expected.map(b => b.bindingId)) !== canonicalInput(protectedBindings.map(b => b.bindingId).sort())) { return deny('PLAN') }

  const members = async () => (await query<{ session_id: string }>(
    'SELECT session_id FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1 ORDER BY session_id', [identity.unitId])).rows.map(r => r.session_id)
  const sessions = await members()
  if (!sessions.length) { return deny('MEMBERS') }
  await lockAggregates(tx, { sessionIds: sessions.map(s => logicalId('session', s)), runtimeUnitIds: [identity.unitId] })
  if (canonicalInput(await members()) !== canonicalInput(sessions)) { return deny('MEMBERS_CHANGED') }
  const associations = (await query<{ storage_binding_id: string }>(`SELECT DISTINCT storage_binding_id
    FROM durable_runtime.runtime_member_storage_bindings WHERE runtime_unit_id=$1 ORDER BY storage_binding_id`, [identity.unitId])).rows
  if (canonicalInput(associations.map(r => r.storage_binding_id)) !== canonicalInput(expected.map(b => b.bindingId))) { return deny('BINDING_SET') }
  const open = await query(`SELECT id FROM durable_runtime.sessions WHERE id=ANY($1::uuid[]) AND lifecycle='OPEN'`, [sessions])
  if (open.rowCount !== sessions.length) { return deny('SESSION_CLOSED') }
  const readBindings = async () => (await query<BindingRow>(
    'SELECT * FROM durable_runtime.storage_bindings WHERE id=ANY($1::uuid[]) ORDER BY id', [expected.map(b => b.bindingId)])).rows
  const beforeDomains = await readBindings()
  if (beforeDomains.length !== expected.length) { return deny('BINDING_SET') }
  await lockAggregates(tx, { storageDomains: beforeDomains.map(b => ({ backendId: b.backend_id, exportId: b.export_id })) })
  const bindings = await readBindings()
  const authority = await LockedGatewayAuthority.acquire(tx, context)
  const unit = (await query<UnitRow>('SELECT * FROM durable_runtime.runtime_units WHERE id=$1', [identity.unitId])).rows[0]
  const operation = (await query<{ kind: string; result: unknown; external_resource_name: string | null;
    execution_epoch: string; intent_revision: string; controller_term: string; step_revision: string; expected_pod_uid: string | null }>(
    'SELECT * FROM durable_runtime.operations WHERE id=$1 AND runtime_unit_id=$2', [identity.operationId, identity.unitId])).rows[0]
  if (!unit || !operation || unit.dataset_name !== dataset || unit.desired_mode !== 'RUNNING' ||
      unit.execution_epoch !== identity.executionEpoch || unit.intent_revision !== identity.intentRevision ||
      operation.kind !== 'WAKE' || operation.result !== null || operation.external_resource_name !== identity.resourceName ||
      operation.execution_epoch !== identity.executionEpoch || operation.intent_revision !== identity.intentRevision ||
      operation.controller_term !== context.controller.term || operation.step_revision !== e.stepRevision || operation.expected_pod_uid !== null) { return deny('STALE') }
  const command = (await query<CommandRow>('SELECT * FROM durable_runtime.runtime_commands WHERE id=$1 FOR UPDATE', [claim.commandId])).rows[0]
  if (!command) { return deny('CLAIM') }
  assertOriginal(command, claim.identity)
  if (command.operation_id !== identity.operationId || command.runtime_unit_id !== identity.unitId || command.state !== 'EXECUTING' ||
      command.executor_id !== claim.executorId || command.execution_token !== claim.executionToken || command.owner_controller_term !== context.controller.term) { return deny('CLAIM') }
  if (canonicalInput(command.input) !== canonicalInput({ resourceName: identity.resourceName,
    body: { mode: 'COLD', planDigest, attemptId: identity.attemptId, resourceProfileRevision: profileRevision } })) { return deny('CLAIM_PLAN') }

  const input = captured.input
  return Object.freeze({ context, input, claim, e, expectedUnitRevision, planDigest, expected,
    reservationDigest, claimDigest, record, identity, dataset, profileRevision, protectedBindings,
    sessions: Object.freeze(sessions), bindings: Object.freeze(bindings), authority, unit, operation })
}
export type LockedInitialAgentAttemptContext = Awaited<ReturnType<typeof lockInitialAgentAttemptContext>>
