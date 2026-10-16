import { createHash } from 'node:crypto'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { RowRevision, StorageBindingId, StorageEpoch } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, type DurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import type { JsonValue } from '../db/atomic.ts'
import type { StorageEvidenceAuthority, VerifiedDirectoryEvidence } from '../storage/evidence.ts'
import { readAgentPodPlan } from './agent-pod-plan-records.ts'
import { LockedGatewayAuthority, currentAuthoritySql } from './gateway/authority.ts'
import { assertOriginal } from './gateway/store.ts'
import { inputDigest, canonicalInput } from './gateway/input.ts'
import type { CommandClaim, CommandRow, GatewayContext } from './gateway/types.ts'

export type InitialAgentAttemptInput = Readonly<{
  claim: CommandClaim
  planDigest: string
  expectedUnitRevision: RowRevision<'runtime-unit'>
  bindings: readonly Readonly<{ bindingId: StorageBindingId; expectedRevision: RowRevision<'storage-binding'>; storageEpoch: StorageEpoch }>[]
}>
export type InitialAgentAttemptReservation = Readonly<{
  disposition: 'RESERVED' | 'REPLAYED'
  visibility: 'TRANSACTION_LOCAL'
  attemptId: string
  executionGrantId: string
  storageGrants: readonly Readonly<{ bindingId: string; grantId: string; storageEpoch: string }>[]
  planDigest: string
  unitRevision: string
  kubernetesExecutionAuthorized: false
  physicalPinIssuerImplemented: false
}>
type BindingRow = { id: string; backend_id: string; export_id: string; canonical_directory: string;
  revision: string; epoch: string; access_state: string; identity_proof_ref: string | null;
  identity_verified_at: Date | null; writer_attempt_id: string | null }
type UnitRow = { revision: string; active_attempt_id: string | null; dataset_name: string;
  execution_epoch: string; intent_revision: string; desired_mode: string }
const deny = (suffix: string): never => { throw new DurableDatabaseError(`INITIAL_AGENT_${suffix}`) }
function text(value: string): string {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/u.test(value)) { return deny('INPUT') }
  return value
}
function idFor(value: string): string {
  const h = createHash('sha256').update(`initial-agent-attempt:v1:${value}`).digest('hex')
  return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`
}

/** Initial SQL reservation only. Caller must propagate any throw to rollback,
 * observe the actual transaction outcome and retain every prepared physical pin
 * through that settlement. This module neither issues pins nor authorizes K8s. */
export async function reserveInitialAgentAttempt(tx: DurableTransaction, originalContext: GatewayContext,
  original: InitialAgentAttemptInput, evidenceAuthority: StorageEvidenceAuthority): Promise<InitialAgentAttemptReservation> {
  const query = tx.query.bind(tx), directory = evidenceAuthority.directory.bind(evidenceAuthority)
  const pinValid = evidenceAuthority.directoryPinValid.bind(evidenceAuthority)
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
  if (!Object.isFrozen(evidenceAuthority) || !/^[0-9a-f]{64}$/u.test(planDigest) ||
      new Set(expected.map(b => b.bindingId)).size !== expected.length || claim.visibility !== 'TRANSACTION_LOCAL' ||
      claim.identity.command !== 'ensureAttempt' || e.podTarget !== 'CREATE_WITHOUT_POD' || e.expectedPodUid !== null ||
      e.operationId !== context.operationId || claim.controllerTerm !== context.controller.term) { return deny('INPUT') }
  const reservationDigest = inputDigest({ commandId: claim.commandId, executorId: claim.executorId,
    executionToken: claim.executionToken, controllerTerm: claim.controllerTerm, command: claim.identity.command,
    inputHash: claim.identity.inputHash, envelope: { operationId: e.operationId, controllerTerm: e.controllerTerm,
      stepRevision: e.stepRevision, executionEpoch: e.executionEpoch, intentRevision: e.intentRevision,
      podTarget: e.podTarget, expectedPodUid: e.expectedPodUid }, planDigest, expectedUnitRevision, bindings: expected })
  const record = await readAgentPodPlan(tx, context.operationId)
  if (!record || record.planDigest !== planDigest) { return deny('PLAN') }
  const plan = record.plan, identity = plan.identity, dataset = plan.pod.metadata.labels['orca.dev/dataset']
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

  const held: VerifiedDirectoryEvidence[] = []
  for (const b of bindings) {
    const p = protectedBindings.find(p => p.bindingId === b.id), v = expected.find(v => v.bindingId === b.id)
    if (!p || !v || !b.identity_proof_ref || b.identity_verified_at === null || b.epoch !== v.storageEpoch) { return deny('BINDING') }
    let evidence
    try { evidence = directory(b.identity_proof_ref) } catch { return deny('DIRECTORY') }
    if (!evidence || evidence.evidenceRef !== b.identity_proof_ref || !evidence.topologyPinId || !Object.isFrozen(evidence) ||
        !Object.isFrozen(evidence.candidate) || !Object.isFrozen(evidence.candidate.domain) ||
        evidence.candidate.domain.backendId !== b.backend_id || evidence.candidate.domain.exportId !== b.export_id ||
        evidence.candidate.domain.pvUid !== p.pvUid || evidence.candidate.canonicalDirectory !== b.canonical_directory ||
        b.canonical_directory !== `/${dataset}/${p.leafId}` || p.serverPath !== `/exports/runtime-domains${b.canonical_directory}`) { return deny('DIRECTORY') }
    held.push(evidence)
  }
  function pins(): void {
    for (const evidence of held) {
      try { if (pinValid(evidence) === true) { continue } } catch { /* fixed error below */ }
      deny('PIN_INVALID')
    }
  }
  pins()
  const prefix = `${identity.operationId}:${planDigest}:${claim.commandId}`
  const eventId = idFor(`${prefix}:event`), executionGrantId = idFor(`${prefix}:execution`)
  const storageGrants = Object.freeze(protectedBindings.filter(b => b.mode === 'RW').map(b => Object.freeze({
    bindingId: b.bindingId, grantId: idFor(`${prefix}:storage:${b.bindingId}`), storageEpoch: expected.find(v => v.bindingId === b.bindingId)!.storageEpoch })))
  const unitRevision = String(BigInt(expectedUnitRevision) + 1n)
  const event = { kind: 'INITIAL_AGENT_ATTEMPT_RESERVED', operationId: identity.operationId, unitId: identity.unitId,
    attemptId: identity.attemptId, commandId: claim.commandId, planDigest, reservationDigest, executionGrantId,
    storageGrants, unitRevision, state: 'RESERVED', kubernetesExecutionAuthorized: false, physicalPinIssued: false }
  const old = (await query<{ next_state: JsonValue }>(
    "SELECT next_state FROM durable_runtime.runtime_audit_events WHERE id=$1 AND kind='INITIAL_AGENT_ATTEMPT_RESERVED'", [eventId])).rows[0]
  const attempts = (await query<{ id: string; status: string; mode: string; pod_uid: string | null; incarnation: string | null;
    execution_epoch: string; resource_profile_revision: string; effective_resources: JsonValue; ready_at: Date | null; started_at: Date | null; stopped_at: Date | null }>(
    'SELECT * FROM durable_runtime.attempts WHERE runtime_unit_id=$1', [identity.unitId])).rows
  const executions = (await query<{ id: string; attempt_id: string; execution_epoch: string; state: string; revision: string }>(
    'SELECT * FROM durable_runtime.execution_grants WHERE runtime_unit_id=$1', [identity.unitId])).rows
  const profileRevision = plan.pod.metadata.annotations['orca.dev/resource-profile-revision']
  const result = (disposition: 'RESERVED' | 'REPLAYED'): InitialAgentAttemptReservation => Object.freeze({ disposition,
    visibility: 'TRANSACTION_LOCAL', attemptId: identity.attemptId, executionGrantId, storageGrants, planDigest, unitRevision,
    kubernetesExecutionAuthorized: false, physicalPinIssuerImplemented: false })
  if (old) {
    const a = attempts[0], g = executions[0]
    if (canonicalInput(old.next_state) !== canonicalInput(event) || unit.active_attempt_id !== identity.attemptId || unit.revision !== unitRevision ||
        attempts.length !== 1 || !a || a.id !== identity.attemptId || a.status !== 'RESERVED' || a.mode !== 'COLD' ||
        a.pod_uid !== null || a.incarnation !== null || a.ready_at !== null || a.started_at !== null || a.stopped_at !== null ||
        a.execution_epoch !== identity.executionEpoch || a.resource_profile_revision !== profileRevision || canonicalInput(a.effective_resources) !== '{}' ||
        executions.length !== 1 || !g || g.id !== executionGrantId || g.attempt_id !== identity.attemptId || g.execution_epoch !== identity.executionEpoch || g.state !== 'RESERVED' || g.revision !== '0') { return deny('REPLAY_CONFLICT') }
    const grants = (await query<{ id: string; storage_binding_id: string; storage_epoch: string; state: string; revision: string }>(
      'SELECT * FROM durable_runtime.storage_write_grants WHERE attempt_id=$1 ORDER BY id', [identity.attemptId])).rows
    if (grants.length !== storageGrants.length || storageGrants.some(g => !grants.some(r => r.id === g.grantId && r.storage_binding_id === g.bindingId &&
        r.storage_epoch === g.storageEpoch && r.state === 'RESERVED' && r.revision === '0'))) { return deny('REPLAY_CONFLICT') }
    for (const b of bindings) {
      const v = expected.find(v => v.bindingId === b.id)!, rw = storageGrants.some(g => g.bindingId === b.id)
      if (b.revision !== String(BigInt(v.expectedRevision) + (rw ? 1n : 0n)) || b.access_state !== (rw ? 'RESERVED' : 'VERIFIED') ||
          b.writer_attempt_id !== (rw ? identity.attemptId : null)) { return deny('REPLAY_CONFLICT') }
    }
    if ((await query('SELECT id FROM durable_runtime.storage_mounts WHERE attempt_id=$1', [identity.attemptId])).rowCount) { return deny('REPLAY_CONFLICT') }
    await authority.assertCurrent(); pins()
    return result('REPLAYED')
  }
  if (unit.revision !== expectedUnitRevision || unit.active_attempt_id !== null || attempts.length || executions.some(g => g.state !== 'REVOKED')) { return deny('NOT_INITIAL') }
  for (const b of bindings) {
    if (b.revision !== expected.find(v => v.bindingId === b.id)!.expectedRevision || b.access_state !== 'VERIFIED' || b.writer_attempt_id !== null) { return deny('BINDING') }
    if (!storageGrants.some(g => g.bindingId === b.id)) { continue }
    const conflicts = await query(`SELECT g.id FROM durable_runtime.storage_write_grants g JOIN durable_runtime.storage_bindings b ON b.id=g.storage_binding_id
      WHERE g.state IN ('RESERVED','ACTIVE','REVOKING') AND b.backend_id=$1 AND b.export_id=$2
      AND (b.canonical_directory=$3 OR b.canonical_directory='/' OR $3='/'
        OR left(b.canonical_directory,length($3)+1)=$3||'/' OR left($3,length(b.canonical_directory)+1)=b.canonical_directory||'/')`,
    [b.backend_id,b.export_id,b.canonical_directory])
    if (conflicts.rowCount) { return deny('WRITER_HELD') }
  }
  // Approved desired profile must already exist. Effective/admitted resources remain unknown ({}).
  if ((await query('SELECT revision FROM durable_runtime.resource_profiles WHERE runtime_unit_id=$1 AND revision=$2', [identity.unitId, profileRevision])).rowCount !== 1) { return deny('PROFILE_MISSING') }
  const auth = [context.controller.scope, context.controller.owner, context.controller.term]
  async function write(sql: string, values: readonly unknown[]): Promise<void> {
    pins()
    if ((await query(sql, [...auth, ...values])).rowCount !== 1) { return deny('STALE') }
  }
  await write(`INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,resource_profile_revision,effective_resources,status)
    SELECT $4,$5,$6,'COLD',$7,'{}'::jsonb,'RESERVED' WHERE ${currentAuthoritySql} RETURNING id`, [identity.attemptId,identity.unitId,identity.executionEpoch,profileRevision])
  await write(`UPDATE durable_runtime.runtime_units SET active_attempt_id=$5,revision=revision+1 WHERE id=$4 AND revision=$6
    AND active_attempt_id IS NULL AND ${currentAuthoritySql} RETURNING id`, [identity.unitId,identity.attemptId,expectedUnitRevision])
  await write(`INSERT INTO durable_runtime.execution_grants(id,runtime_unit_id,attempt_id,execution_epoch,state)
    SELECT $4,$5,$6,$7,'RESERVED' WHERE ${currentAuthoritySql} RETURNING id`, [executionGrantId,identity.unitId,identity.attemptId,identity.executionEpoch])
  for (const g of storageGrants) {
    await write(`INSERT INTO durable_runtime.storage_write_grants(id,storage_binding_id,attempt_id,storage_epoch,state)
      SELECT $4,$5,$6,$7,'RESERVED' WHERE ${currentAuthoritySql} RETURNING id`, [g.grantId,g.bindingId,identity.attemptId,g.storageEpoch])
    await write(`UPDATE durable_runtime.storage_bindings SET access_state='RESERVED',writer_attempt_id=$5,revision=revision+1
      WHERE id=$4 AND revision=$6 AND ${currentAuthoritySql} RETURNING id`, [g.bindingId,identity.attemptId,expected.find(v => v.bindingId === g.bindingId)!.expectedRevision])
  }
  const body = canonicalInput(event)
  await write(`INSERT INTO durable_runtime.runtime_audit_events(id,actor_id,runtime_unit_id,operation_id,attempt_id,kind,next_state,
    occurred_at,received_at,producer_id,producer_seq,evidence_refs,payload)
    SELECT $4,$2,$5,$6,$7,'INITIAL_AGENT_ATTEMPT_RESERVED',$8::jsonb,clock_timestamp(),clock_timestamp(),$4,1,'[]'::jsonb,'{}'::jsonb
    WHERE ${currentAuthoritySql} RETURNING id`, [eventId,identity.unitId,identity.operationId,identity.attemptId,body])
  await write(`INSERT INTO durable_runtime.outbox_events(id,aggregate_id,aggregate_kind,revision,event,created_at)
    SELECT $4,$5,'runtime-unit',$6,$7::jsonb,clock_timestamp() WHERE ${currentAuthoritySql} RETURNING id`, [eventId,identity.unitId,unitRevision,body])
  await authority.assertCurrent(); pins()
  return result('RESERVED')
}
