import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, runDurableTransaction } from '../db/connection.ts'
import type { DurableTransaction } from '../db/connection.ts'
import type { JsonValue } from '../db/atomic.ts'
import { appendAudit } from '../journal/store.ts'
import { canonicalInput, inputDigest } from '../runtime/gateway/input.ts'
import type { GatewayContext } from '../runtime/gateway/types.ts'
import type { InitialAgentAttemptInput } from '../runtime/initial-agent-attempt.ts'
import { sameDirectory } from './canonical.ts'
import type { CanonicalCandidate } from './canonical.ts'
import type { VerifiedDirectoryEvidence } from './evidence.ts'
import { captureAuthenticatedManagedLeafObservation } from './prepared-directory-observation.ts'
import type { PreparedDirectoryObservationInput } from './prepared-directory-observation.ts'
import type { AuthenticatedManagedLeafObservation } from './managed-leaf-collector-types.ts'
import type { NamespaceHoldInput } from './namespace-holds.ts'
import { requireFirstManagedObservation } from './first-managed-observation-identity.ts'
import type { captureFirstManagedBindingProfile } from './first-managed-binding-owner-profile.ts'
import { lockInitialAgentAttemptContext, captureInitialAgentAttemptContext } from './initial-agent-directory-context.ts'
import type { LockedInitialAgentAttemptContext } from './initial-agent-directory-context.ts'

type Accepted = ReturnType<typeof captureFirstManagedBindingProfile>
type Scope = PreparedDirectoryObservationInput['scope']
type AuditRow = { id: string; kind: string; actor_id: string; producer_id: string; producer_seq: string;
  session_id: string | null; runtime_unit_id: string | null; operation_id: string | null; attempt_id: string | null;
  next_state: JsonValue; evidence_refs: JsonValue }
type Association = Readonly<{ sessionId: string; bindingId: string }>
export type InitialDirectoryRevalidationInput = Readonly<{
  accepted: Accepted; hold: NamespaceHoldInput; sessionId: string; actorId: string;
  context: GatewayContext; attempt: InitialAgentAttemptInput; originalAuditId: string;
  observation: AuthenticatedManagedLeafObservation;
}>
export type InitialDirectoryRevalidationRecord = Readonly<{
  auditId: string; auditRef: string; originalAuditId: string; evidenceRef: string;
  pinId: string; originalCandidate: CanonicalCandidate;
}>
/** Internal server handle; no proof/lease is produced by this data object. */
export type InitialDirectoryRevalidationGuard = InitialDirectoryRevalidationRecord & Readonly<{
  accepted: Accepted; ownerTokenHash: string;
}>
const kind = 'INITIAL_AGENT_DIRECTORY_REVALIDATED'
const deny = (code: string): never => { throw new DurableDatabaseError(`INITIAL_DIRECTORY_${code}`) }
const hash = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')
function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function object(value: JsonValue): Record<string, JsonValue> {
  if (!isRecord(value)) { return deny('AUDIT_SHAPE') }
  return value
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512 || [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
    return deny('INPUT')
  }
  return value
}
function captureScope(value: JsonValue): Scope {
  const s = object(value)
  // Preserve the original owner's exact property order for its JSON ref hash.
  return Object.freeze({ sessionId: logicalId('session', text(s.sessionId)), unitId: logicalId('runtime-unit', text(s.unitId)),
    bindingId: logicalId('storage-binding', text(s.bindingId)),
    expectedUnitRevision: counter('row:runtime-unit', text(s.expectedUnitRevision)),
    expectedBindingRevision: counter('row:storage-binding', text(s.expectedBindingRevision)), actorId: text(s.actorId) })
}
async function readAudit(tx: DurableTransaction, id: string): Promise<AuditRow> {
  const value = await tx.query<AuditRow>(`SELECT id,kind,actor_id,producer_id,producer_seq,session_id,
    runtime_unit_id,operation_id,attempt_id,next_state,evidence_refs
    FROM durable_runtime.runtime_audit_events WHERE id=$1`, [id])
  if (value.rowCount !== 1 || value.rows[0].id !== id) { return deny('AUDIT_MISSING') }
  return value.rows[0]
}
function originalAudit(row: AuditRow, accepted: Accepted, sessionId: string, locked: LockedInitialAgentAttemptContext) {
  const raw = object(row.next_state), scope = captureScope(raw.scope), p = accepted.record
  const observation = captureAuthenticatedManagedLeafObservation(raw.observation)
  requireFirstManagedObservation(p, observation, p.leafId)
  const pinId = logicalId('storage-namespace-pin', text(raw.pinId)), evidenceRef = text(raw.evidenceRef)
  const expected = `first-managed-binding:sha256:${hash(JSON.stringify({ profileDigest: accepted.digest,
    profileId: p.profile.profileId, generation: p.profile.generation, pinId, scope, leafId: p.leafId,
    observationRef: observation.reference, qualificationRef: p.qualificationRef }))}`
  if (row.kind !== 'STORAGE_DIRECTORY_OBSERVATION_PREPARED' || raw.kind !== row.kind || row.producer_id !== pinId ||
      row.producer_seq !== '1' || row.actor_id !== scope.actorId || row.session_id !== null || row.runtime_unit_id !== null ||
      row.operation_id !== null || row.attempt_id !== null || evidenceRef !== expected ||
      raw.profileId !== p.profile.profileId || raw.datasetName !== p.profile.datasetName ||
      raw.backendId !== p.profile.backendId || raw.exportId !== p.profile.exportId ||
      raw.generation !== p.profile.generation || raw.digest !== accepted.digest || raw.qualificationRef !== p.qualificationRef ||
      scope.sessionId !== sessionId || scope.unitId !== locked.context.runtimeUnitId ||
      scope.bindingId !== locked.expected[0].bindingId ||
      canonicalInput(row.evidence_refs) !== canonicalInput([observation.reference, p.qualificationRef, evidenceRef])) {
    return deny('ORIGINAL_AUDIT_MISMATCH')
  }
  return Object.freeze({ id: row.id, scope, pinId, evidenceRef, observation, candidate: observation.candidate })
}
function exactSingle(locked: LockedInitialAgentAttemptContext, accepted: Accepted): void {
  const binding = locked.expected[0], mount = locked.protectedBindings[0], p = accepted.record
  if (locked.expected.length !== 1 || locked.protectedBindings.length !== 1 || !binding || !mount ||
      binding.bindingId !== mount.bindingId || binding.storageEpoch !== '0' || mount.leafId !== p.leafId ||
      mount.serverPath !== `/exports/runtime-domains/${p.profile.datasetName}/${p.leafId}` || locked.dataset !== p.profile.datasetName ||
      locked.unit.revision !== locked.expectedUnitRevision || locked.unit.active_attempt_id !== null) {
    deny('FIRST_SCOPE_REQUIRED')
  }
}
async function unused(tx: DurableTransaction, accepted: Accepted, sessionId: string,
  locked: LockedInitialAgentAttemptContext, evidenceRef: string) {
  exactSingle(locked, accepted)
  const expected = locked.expected[0], p = accepted.record
  // A child grant/mount FK insertion serializes here. Its history is read in the
  // following statement, after a possible lock wait, not in the old snapshot.
  const rows = await tx.query<{ id: string; backend_id: string; export_id: string; canonical_directory: string;
    revision: string; epoch: string; access_state: string; identity_proof_ref: string | null;
    identity_verified_at: Date | null; writer_attempt_id: string | null; seal_id: string | null }>(
    'SELECT * FROM durable_runtime.storage_bindings WHERE id=$1 FOR UPDATE', [expected.bindingId])
  const b = rows.rows[0]
  if (rows.rowCount !== 1 || !b || b.backend_id !== p.profile.backendId || b.export_id !== p.profile.exportId ||
      b.canonical_directory !== `/${p.profile.datasetName}/${p.leafId}` || b.revision !== expected.expectedRevision ||
      b.identity_proof_ref !== evidenceRef || b.identity_verified_at === null || b.access_state !== 'VERIFIED' ||
      b.epoch !== '0' || b.writer_attempt_id !== null || b.seal_id !== null) { return deny('BINDING_CHANGED_OR_USED') }
  const history = await tx.query<{ grants: boolean; mounts: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM durable_runtime.storage_write_grants WHERE storage_binding_id=$1) AS grants,
    EXISTS(SELECT 1 FROM durable_runtime.storage_mounts WHERE storage_binding_id=$1) AS mounts`, [expected.bindingId])
  if (history.rows[0].grants || history.rows[0].mounts) { return deny('PAST_USE') }
  const associations = (await tx.query<{ session_id: string; storage_binding_id: string }>(`SELECT session_id,storage_binding_id
    FROM durable_runtime.runtime_member_storage_bindings WHERE runtime_unit_id=$1 ORDER BY session_id,storage_binding_id`,
  [locked.context.runtimeUnitId])).rows.map(row => Object.freeze({ sessionId: row.session_id, bindingId: row.storage_binding_id }))
  if (canonicalInput([...associations]) !== canonicalInput(locked.sessions.map(id => ({ sessionId: id, bindingId: expected.bindingId }))) ||
      !associations.some(a => a.sessionId === sessionId && a.bindingId === expected.bindingId)) { return deny('ASSOCIATION_SET') }
  return Object.freeze(associations)
}
async function heldProfile(tx: DurableTransaction, accepted: Accepted, pinId: string, tokenHash: string): Promise<void> {
  const p = accepted.record.profile
  const profile = (await tx.query<{ dataset_name: string; backend_id: string; export_id: string; generation: string; digest: string; state: string }>(
    `SELECT dataset_name,backend_id,export_id,generation,digest,state FROM durable_runtime.storage_namespace_profiles WHERE id=$1 FOR UPDATE`,
    [p.profileId])).rows[0]
  if (!profile || profile.dataset_name !== p.datasetName || profile.backend_id !== p.backendId || profile.export_id !== p.exportId ||
      profile.generation !== p.generation || profile.digest !== accepted.digest || !['ACTIVE', 'DRAINING'].includes(profile.state)) {
    deny('PROFILE_CHANGED')
  }
  const hold = (await tx.query<{ profile_id: string; generation: string; digest: string; owner_token_hash: string; state: string }>(
    'SELECT profile_id,generation,digest,owner_token_hash,state FROM durable_runtime.storage_namespace_holds WHERE id=$1 FOR UPDATE', [pinId])).rows[0]
  if (!hold || hold.profile_id !== p.profileId || hold.generation !== p.generation || hold.digest !== accepted.digest ||
      hold.owner_token_hash !== tokenHash || hold.state !== 'HELD') { deny('HOLD_NOT_OWNED') }
}
function scopeState(locked: LockedInitialAgentAttemptContext, sessionId: string, actorId: string) {
  const c = locked.context.controller, binding = locked.expected[0]
  return Object.freeze({ sessionId, unitId: locked.context.runtimeUnitId, operationId: locked.context.operationId,
    actorId, controller: Object.freeze({ scope: c.scope, owner: c.owner, term: c.term }),
    commandId: locked.claim.commandId, claimDigest: locked.claimDigest, planDigest: locked.planDigest,
    expectedUnitRevision: locked.expectedUnitRevision, bindingId: binding.bindingId,
    expectedBindingRevision: binding.expectedRevision, storageEpoch: binding.storageEpoch,
    attemptId: locked.identity.attemptId })
}
function auditState(accepted: Accepted, pinId: string, tokenHash: string, origin: ReturnType<typeof originalAudit>,
  observation: AuthenticatedManagedLeafObservation, scope: ReturnType<typeof scopeState>, associations: readonly Association[]) {
  const p = accepted.record
  const content = Object.freeze({ kind, profileId: p.profile.profileId, profileDigest: accepted.digest,
    datasetName: p.profile.datasetName, backendId: p.profile.backendId, exportId: p.profile.exportId,
    generation: p.profile.generation, leafId: p.leafId, qualificationRef: p.qualificationRef,
    originalAuditId: origin.id, originalIdentityRef: origin.evidenceRef, originalCandidate: origin.candidate,
    pinId, ownerTokenHash: tokenHash, observation, scope, associations: [...associations] })
  return Object.freeze({ ...content, auditRef: `initial-agent-directory-revalidated:sha256:${inputDigest(content)}` })
}

/** Records a distinct observation scoped to the CURRENT original command. It
 * never constructs branded evidence, changes the original proof, or reserves. */
export function recordInitialDirectoryRevalidation(pool: Pool, original: InitialDirectoryRevalidationInput) {
  const accepted = original.accepted, hold = original.hold
  const captured = captureInitialAgentAttemptContext(original.context, original.attempt)
  const input = Object.freeze({ accepted, pinId: logicalId('storage-namespace-pin', hold.pinId),
    ownerTokenHash: hash(text(hold.ownerToken)), actorId: text(original.actorId),
    sessionId: logicalId('session', original.sessionId), originalAuditId: logicalId('event', original.originalAuditId),
    observation: captureAuthenticatedManagedLeafObservation(original.observation), context: captured.context, attempt: captured.input })
  if (text(hold.ownerToken).length < 32 || hold.actorId !== input.actorId || hold.profileId !== accepted.record.profile.profileId ||
      hold.datasetName !== accepted.record.profile.datasetName || hold.backendId !== accepted.record.profile.backendId ||
      hold.exportId !== accepted.record.profile.exportId || hold.generation !== accepted.record.profile.generation || hold.digest !== accepted.digest) {
    deny('INPUT')
  }
  requireFirstManagedObservation(accepted.record, input.observation, accepted.record.leafId)
  const connect = pool.connect.bind(pool), borrowed: Pool = Object.create(pool, { connect: { value: connect } })
  return runDurableTransaction(borrowed, async tx => {
    const locked = await lockInitialAgentAttemptContext(tx, input.context, input.attempt)
    exactSingle(locked, accepted)
    const origin = originalAudit(await readAudit(tx, input.originalAuditId), accepted, input.sessionId, locked)
    if (origin.pinId === input.pinId) { deny('NEW_PIN_REQUIRED') }
    // Preserve both records; a changed tuple is never refreshed into the binding.
    if (!sameDirectory(origin.candidate, input.observation.candidate)) { deny('FULL_TUPLE_CHANGED') }
    const associations = await unused(tx, accepted, input.sessionId, locked, origin.evidenceRef)
    await heldProfile(tx, accepted, input.pinId, input.ownerTokenHash)
    const body = auditState(accepted, input.pinId, input.ownerTokenHash, origin, input.observation,
      scopeState(locked, input.sessionId, input.actorId), associations)
    await locked.authority.assertCurrent()
    const auditId = await appendAudit(tx, { actorId: input.actorId, sessionId: input.sessionId,
      runtimeUnitId: locked.context.runtimeUnitId, operationId: locked.context.operationId,
      kind, nextState: body, occurredAt: new Date(input.observation.observedAt), receivedAt: new Date(),
      producerId: input.pinId, producerSeq: counter('sequence:producer', '1'),
      evidenceRefs: [origin.evidenceRef, input.observation.reference, accepted.record.qualificationRef, body.auditRef] })
    await locked.authority.assertCurrent()
    return Object.freeze({ auditId, auditRef: body.auditRef, originalAuditId: origin.id,
      evidenceRef: origin.evidenceRef, pinId: input.pinId, originalCandidate: origin.candidate })
  })
}

/** Called only by the explicitly selected first reservation, after its original
 * Session/Unit -> domain -> operation/lease/claim validation and before writes. */
export async function assertInitialDirectoryRevalidation(tx: DurableTransaction,
  guard: InitialDirectoryRevalidationGuard, locked: LockedInitialAgentAttemptContext): Promise<void> {
  const row = await readAudit(tx, logicalId('event', guard.auditId)), raw = object(row.next_state)
  const rawScope = object(raw.scope), sessionId = text(rawScope.sessionId), actorId = text(rawScope.actorId)
  exactSingle(locked, guard.accepted)
  const origin = originalAudit(await readAudit(tx, guard.originalAuditId), guard.accepted, sessionId, locked)
  const observation = captureAuthenticatedManagedLeafObservation(raw.observation)
  requireFirstManagedObservation(guard.accepted.record, observation, guard.accepted.record.leafId)
  if (!sameDirectory(origin.candidate, observation.candidate) || !sameDirectory(origin.candidate, guard.originalCandidate) ||
      origin.evidenceRef !== guard.evidenceRef || origin.pinId === guard.pinId) { deny('FULL_TUPLE_CHANGED') }
  const associations = await unused(tx, guard.accepted, sessionId, locked, origin.evidenceRef)
  await heldProfile(tx, guard.accepted, guard.pinId, guard.ownerTokenHash)
  const expected = auditState(guard.accepted, guard.pinId, guard.ownerTokenHash, origin, observation,
    scopeState(locked, sessionId, actorId), associations)
  if (row.kind !== kind || row.actor_id !== actorId || row.session_id !== sessionId || row.runtime_unit_id !== locked.context.runtimeUnitId ||
      row.operation_id !== locked.context.operationId || row.attempt_id !== null || row.producer_id !== guard.pinId || row.producer_seq !== '1' ||
      expected.auditRef !== guard.auditRef || canonicalInput(raw) !== canonicalInput(expected) ||
      canonicalInput(row.evidence_refs) !== canonicalInput([origin.evidenceRef, observation.reference, guard.accepted.record.qualificationRef, expected.auditRef])) {
    deny('FINAL_AUDIT_SCOPE_MISMATCH')
  }
  await locked.authority.assertCurrent()
}

/** The consumed brand must be the original FULL candidate and this new hold. */
export function assertInitialDirectoryEvidence(guard: InitialDirectoryRevalidationGuard,
  evidence: VerifiedDirectoryEvidence): void {
  if (evidence.evidenceRef !== guard.evidenceRef || evidence.topologyPinId !== guard.pinId ||
      !sameDirectory(evidence.candidate, guard.originalCandidate)) { deny('CONSUMED_EVIDENCE_MISMATCH') }
}
