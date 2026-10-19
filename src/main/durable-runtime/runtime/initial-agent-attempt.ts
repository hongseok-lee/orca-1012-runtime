import { createHash } from 'node:crypto'
import type { RowRevision, StorageBindingId, StorageEpoch } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, type DurableTransaction } from '../db/connection.ts'
import type { JsonValue } from '../db/atomic.ts'
import type { StorageEvidenceAuthority, VerifiedDirectoryEvidence } from '../storage/evidence.ts'
import { currentAuthoritySql } from './gateway/authority.ts'
import { canonicalInput } from './gateway/input.ts'
import type { CommandClaim, GatewayContext } from './gateway/types.ts'
import { lockInitialAgentAttemptContext } from '../storage/initial-agent-directory-context.ts'
import { assertInitialDirectoryRevalidation, assertInitialDirectoryEvidence, type InitialDirectoryRevalidationGuard } from '../storage/initial-directory-revalidation-guard.ts'

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
const deny = (suffix: string): never => { throw new DurableDatabaseError(`INITIAL_AGENT_${suffix}`) }
function idFor(value: string): string {
  const h = createHash('sha256').update(`initial-agent-attempt:v1:${value}`).digest('hex')
  return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`
}

/** Initial SQL reservation only. Caller must propagate any throw to rollback,
 * observe the actual transaction outcome and retain every prepared physical pin
 * through that settlement. This module neither issues pins nor authorizes K8s. */
async function reserveInitialAgentAttemptInternal(tx: DurableTransaction, originalContext: GatewayContext,
  original: InitialAgentAttemptInput, evidenceAuthority: StorageEvidenceAuthority,
  firstDirectory?: InitialDirectoryRevalidationGuard): Promise<InitialAgentAttemptReservation> {
  const query = tx.query.bind(tx), directory = evidenceAuthority.directory.bind(evidenceAuthority)
  const pinValid = evidenceAuthority.directoryPinValid.bind(evidenceAuthority)
  if (!Object.isFrozen(evidenceAuthority)) { return deny('INPUT') }
  const locked = await lockInitialAgentAttemptContext(tx, originalContext, original)
  const { context, claim, expectedUnitRevision, planDigest, expected, reservationDigest,
    identity, dataset, profileRevision, protectedBindings, bindings, authority, unit } = locked
  if (firstDirectory) {
    await assertInitialDirectoryRevalidation(tx, firstDirectory, locked)
  }

  const held: VerifiedDirectoryEvidence[] = []
  for (const b of bindings) {
    const p = protectedBindings.find(p => p.bindingId === b.id), v = expected.find(v => v.bindingId === b.id)
    if (!p || !v || !b.identity_proof_ref || b.identity_verified_at === null || b.epoch !== v.storageEpoch) { return deny('BINDING') }
    let evidence
    try { evidence = directory(b.identity_proof_ref) } catch { return deny('DIRECTORY') }
    if (!evidence || evidence.evidenceRef !== b.identity_proof_ref || !evidence.topologyPinId || !Object.isFrozen(evidence) ||
        !Object.isFrozen(evidence.candidate) || !Object.isFrozen(evidence.candidate.domain) ||
        evidence.candidate.domain.backendId !== b.backend_id || evidence.candidate.domain.exportId !== b.export_id ||
        evidence.candidate.canonicalDirectory !== b.canonical_directory ||
        b.canonical_directory !== `/${dataset}/${p.leafId}` || p.serverPath !== `/exports/runtime-domains${b.canonical_directory}`) { return deny('DIRECTORY') }
    if (firstDirectory) { assertInitialDirectoryEvidence(firstDirectory, evidence) }
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
    storageGrants: [...storageGrants], unitRevision, state: 'RESERVED', kubernetesExecutionAuthorized: false, physicalPinIssued: false }
  const old = (await query<{ next_state: JsonValue }>(
    "SELECT next_state FROM durable_runtime.runtime_audit_events WHERE id=$1 AND kind='INITIAL_AGENT_ATTEMPT_RESERVED'", [eventId])).rows[0]
  const attempts = (await query<{ id: string; status: string; mode: string; pod_uid: string | null; incarnation: string | null;
    execution_epoch: string; resource_profile_revision: string; effective_resources: JsonValue; ready_at: Date | null; started_at: Date | null; stopped_at: Date | null }>(
    'SELECT * FROM durable_runtime.attempts WHERE runtime_unit_id=$1 AND stopped_at IS NULL', [identity.unitId])).rows
  const executions = (await query<{ id: string; attempt_id: string; execution_epoch: string; state: string; revision: string }>(
    "SELECT * FROM durable_runtime.execution_grants WHERE runtime_unit_id=$1 AND state<>'REVOKED'", [identity.unitId])).rows
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

/** Generic reservation retains its original multi-binding/replay semantics. */
export function reserveInitialAgentAttempt(tx: DurableTransaction, context: GatewayContext,
  input: InitialAgentAttemptInput, authority: StorageEvidenceAuthority): Promise<InitialAgentAttemptReservation> {
  return reserveInitialAgentAttemptInternal(tx, context, input, authority)
}
/** Explicit first-unused, single accepted-directory path; never inferred for a generic caller. */
export function reserveFirstManagedInitialAgentAttempt(tx: DurableTransaction, context: GatewayContext,
  input: InitialAgentAttemptInput, authority: StorageEvidenceAuthority,
  revalidation: InitialDirectoryRevalidationGuard): Promise<InitialAgentAttemptReservation> {
  if (!revalidation || !Object.isFrozen(revalidation)) {
    return Promise.reject(new DurableDatabaseError('INITIAL_AGENT_FIRST_REVALIDATION_REQUIRED'))
  }
  return reserveInitialAgentAttemptInternal(tx, context, input, authority, revalidation)
}
