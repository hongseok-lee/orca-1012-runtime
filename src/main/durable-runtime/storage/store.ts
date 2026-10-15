import { randomUUID } from 'node:crypto';
import { DurableDatabaseError, type DurableTransaction } from '../db/connection.ts';
import { lockAggregates } from '../db/locks.ts';
import { appendAudit, appendSessionEvent, enqueueOutbox } from '../journal/store.ts';
import { counter, logicalId, type SessionId, type RuntimeUnitId, type AttemptId, type OperationId, type StorageBindingId, type ExecutionEpoch, type StorageEpoch, type RowRevision } from '../../../shared/durable-runtime/identity.ts';
import { sameDirectory, type CanonicalCandidate } from './canonical.ts';
import type { StorageEvidenceAuthority, VerifiedDirectoryEvidence, ExecutionTarget } from './evidence.ts';
import { verifyBindingInTransaction, type BindingVerificationInput } from './binding-verification.ts';

type State = 'RESERVED' | 'ACTIVE' | 'REVOKING' | 'REVOKED';
export type Binding = { id: StorageBindingId; backend_id: string; export_id: string;
  canonical_directory: string; identity_proof_ref: string | null; epoch: StorageEpoch;
  revision: RowRevision<'storage-binding'>; access_state: string; writer_attempt_id: string | null };
export type WriterGrant = { id: string; storage_binding_id: string; attempt_id: string;
  storage_epoch: string; state: State; revision: string };
export type StorageScope = { sessionId: SessionId; unitId: RuntimeUnitId;
  expectedUnitRevision: RowRevision<'runtime-unit'>; actorId: string };
export type StorageTarget = StorageScope & { bindingId: StorageBindingId;
  expectedBindingRevision: RowRevision<'storage-binding'>; storageEpoch: StorageEpoch;
  attemptId: AttemptId; podUid: string; executionEpoch: ExecutionEpoch;
  operation?: { id: OperationId; expectedRevision: RowRevision<'operation'> } };
export type StorageResult<T> = { status: 'APPLIED'; value: T } |
  { status: 'BLOCKED'; reason: string; bindingRevision: string; unitRevision: string };
type Locked = { binding: Binding; incarnation: string };
function deny(code: string): never { throw new DurableDatabaseError(code); }
function trustedReference(value: string): void {
  if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value)) deny('STORAGE_EVIDENCE_REF');
}
function matchesBinding(c: CanonicalCandidate, b: Binding): boolean {
  return c.domain.backendId === b.backend_id && c.domain.exportId === b.export_id && c.canonicalDirectory === b.canonical_directory;
}
// DB mutations consume only prepared immutable local evidence, with synchronous
// local validity checks. Collection/verification and pin acquisition/release are
// outside the transaction. No production verifier/pin or actuator is supplied.
export class StorageStore {
  constructor(private readonly authority: StorageEvidenceAuthority) {}
  verifyBinding(tx: DurableTransaction, input: BindingVerificationInput): Promise<Binding> { return verifyBindingInTransaction(tx, input, this.authority, this.directoryPinValid.bind(this), this.event.bind(this)); }
  private async event(tx: DurableTransaction, scope: StorageScope, binding: Binding, kind: string,
    detail: { grantId?: string; mountId?: string; state?: string; reason?: string } = {}): Promise<void> {
    const event = { kind, bindingId: binding.id, revision: binding.revision, ...detail };
    const producer = logicalId('producer', randomUUID());
    const sequence = counter('sequence:producer', '1');
    const journal = await appendSessionEvent(tx, { sessionId: scope.sessionId,
      source: { kind: 'PRODUCER', sourceKind: 'STORAGE', producerId: producer,
        incarnation: 'storage-transition-v1', producerSeq: sequence }, body: event });
    await appendAudit(tx, { actorId: scope.actorId, runtimeUnitId: scope.unitId,
      sessionId: scope.sessionId, kind, reasonCode: detail.reason, nextState: event,
      occurredAt: new Date(), receivedAt: new Date(), producerId: producer,
      producerSeq: sequence, evidenceRefs: [] });
    await enqueueOutbox(tx, { eventId: journal.eventId, aggregateId: binding.id,
      aggregateKind: 'storage-binding', revision: binding.revision, event });
  }
  private async unit(tx: DurableTransaction, scope: StorageScope): Promise<void> {
    const found = await tx.query('SELECT revision FROM durable_runtime.runtime_units WHERE id=$1', [scope.unitId]);
    if (found.rowCount !== 1 || found.rows[0].revision !== scope.expectedUnitRevision) deny('STORAGE_UNIT_STALE');
  }
  async registerBinding(tx: DurableTransaction, input: StorageScope & {
    bindingId: StorageBindingId; directoryEvidenceRef: string;
  }): Promise<Binding> {
    trustedReference(input.directoryEvidenceRef);
    let evidence;
    try { evidence = this.authority.directory(input.directoryEvidenceRef); }
    catch { deny('STORAGE_DIRECTORY_UNVERIFIED'); }
    if (!evidence || evidence.evidenceRef !== input.directoryEvidenceRef) deny('STORAGE_DIRECTORY_UNVERIFIED');
    if (!this.directoryPinValid(evidence)) deny('STORAGE_DIRECTORY_PIN_INVALID');
    const c = evidence.candidate;
    await lockAggregates(tx, { sessionIds: [input.sessionId], runtimeUnitIds: [input.unitId] });
    await this.unit(tx, input);
    const member = await tx.query<{ runtime_unit_id: string }>(
      'SELECT runtime_unit_id FROM durable_runtime.runtime_members WHERE session_id=$1', [input.sessionId]);
    if (member.rows[0] && member.rows[0].runtime_unit_id !== input.unitId) { deny('STORAGE_MEMBER_UNIT_MISMATCH'); }
    await tx.query('INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [c.domain.backendId, c.domain.exportId]);
    await lockAggregates(tx, { storageDomains: [{ backendId: c.domain.backendId, exportId: c.domain.exportId }] });
    // Local validity only, after lock waits. No stat/cloud/K8s callback in tx.
    if (!this.directoryPinValid(evidence)) deny('STORAGE_DIRECTORY_PIN_INVALID');
    const row = await tx.query<Binding>(`INSERT INTO durable_runtime.storage_bindings
      (id,backend_id,export_id,canonical_directory,identity_proof_ref,identity_verified_at,access_state)
      VALUES($1,$2,$3,$4,$5,clock_timestamp(),'VERIFIED') RETURNING *`,
      [input.bindingId, c.domain.backendId, c.domain.exportId, c.canonicalDirectory, evidence.evidenceRef]);
    // The 021 INSERT trigger records a new primary binding in the same tx.
    await tx.query(member.rows[0]
      ? 'INSERT INTO durable_runtime.runtime_member_storage_bindings(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)'
      : 'INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)', [input.unitId, input.sessionId, input.bindingId]);
    await this.event(tx, input, row.rows[0], 'STORAGE_BINDING_REGISTERED');
    return row.rows[0];
  }
  /** Association only: existing primary/proof/epoch/writer state is untouched. */
  async attachBinding(tx: DurableTransaction, original: StorageScope & {
    bindingId: StorageBindingId;
  }): Promise<Binding> {
    const input = Object.freeze({
      sessionId: logicalId('session', original.sessionId), unitId: logicalId('runtime-unit', original.unitId),
      bindingId: logicalId('storage-binding', original.bindingId),
      expectedUnitRevision: counter('row:runtime-unit', original.expectedUnitRevision), actorId: original.actorId
    });
    const query = tx.query.bind(tx);
    await lockAggregates(tx, { sessionIds: [input.sessionId], runtimeUnitIds: [input.unitId] });
    await this.unit(tx, input);
    const member = await query<{ runtime_unit_id: string }>(
      'SELECT runtime_unit_id FROM durable_runtime.runtime_members WHERE session_id=$1', [input.sessionId]);
    if (member.rowCount !== 1) { deny('STORAGE_MEMBER_MISSING'); }
    if (member.rows[0].runtime_unit_id !== input.unitId) { deny('STORAGE_MEMBER_UNIT_MISMATCH'); }
    const first = await query<Binding>('SELECT * FROM durable_runtime.storage_bindings WHERE id=$1', [input.bindingId]);
    if (first.rowCount !== 1) { deny('STORAGE_BINDING_MISSING'); }
    await lockAggregates(tx, { storageDomains: [{ backendId: first.rows[0].backend_id, exportId: first.rows[0].export_id }] });
    const binding = (await query<Binding>('SELECT * FROM durable_runtime.storage_bindings WHERE id=$1', [input.bindingId])).rows[0];
    if (!binding) { deny('STORAGE_BINDING_MISSING'); }
    const inserted = await query(`INSERT INTO durable_runtime.runtime_member_storage_bindings
      (runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)
      ON CONFLICT(runtime_unit_id,session_id,storage_binding_id) DO NOTHING RETURNING storage_binding_id`,
      [input.unitId, input.sessionId, input.bindingId]);
    if (inserted.rowCount) { await this.event(tx, input, binding, 'STORAGE_BINDING_ATTACHED'); }
    return binding;
  }
  private async lock(tx: DurableTransaction, target: StorageTarget): Promise<Locked> {
    const first = await tx.query<Binding>('SELECT * FROM durable_runtime.storage_bindings WHERE id=$1', [target.bindingId]);
    if (first.rowCount !== 1) deny('STORAGE_BINDING_MISSING');
    const b = first.rows[0];
    await lockAggregates(tx, { sessionIds: [target.sessionId], runtimeUnitIds: [target.unitId],
      storageDomains: [{ backendId: b.backend_id, exportId: b.export_id }],
      operationIds: target.operation ? [target.operation.id] : [] });
    await this.unit(tx, target);
    const read = await tx.query<Binding>('SELECT * FROM durable_runtime.storage_bindings WHERE id=$1', [target.bindingId]);
    const binding = read.rows[0];
    if (binding.revision !== target.expectedBindingRevision || binding.epoch !== target.storageEpoch)
      deny('STORAGE_BINDING_STALE');
    const member = await tx.query(`SELECT a.incarnation FROM durable_runtime.attempts a
      WHERE a.id=$1 AND a.runtime_unit_id=$2 AND a.execution_epoch=$3 AND a.pod_uid=$4
      AND EXISTS(SELECT 1 FROM durable_runtime.runtime_member_storage_bindings m
        WHERE m.runtime_unit_id=a.runtime_unit_id AND m.session_id=$5 AND m.storage_binding_id=$6)`,
      [target.attemptId, target.unitId, target.executionEpoch, target.podUid, target.sessionId, target.bindingId]);
    if (member.rowCount !== 1 || !member.rows[0].incarnation) deny('STORAGE_TARGET_STALE');
    if (target.operation) {
      const operation = await tx.query(`SELECT id FROM durable_runtime.operations WHERE id=$1
        AND runtime_unit_id=$2 AND revision=$3 AND execution_epoch=$4 AND expected_pod_uid=$5`,
        [target.operation.id, target.unitId, target.operation.expectedRevision, target.executionEpoch, target.podUid]);
      if (operation.rowCount !== 1) deny('STORAGE_OPERATION_STALE');
    }
    return { binding, incarnation: member.rows[0].incarnation };
  }
  private async currentExecution(tx: DurableTransaction, target: StorageTarget, active: boolean): Promise<void> {
    const session = await tx.query("SELECT id FROM durable_runtime.sessions WHERE id=$1 AND lifecycle='OPEN'", [target.sessionId]);
    if (session.rowCount !== 1) deny('STORAGE_SESSION_CLOSED');
    const result = await tx.query(`SELECT g.id FROM durable_runtime.execution_grants g
      JOIN durable_runtime.runtime_units u ON u.id=g.runtime_unit_id WHERE g.runtime_unit_id=$1
      AND g.attempt_id=$2 AND g.execution_epoch=$3 AND u.active_attempt_id=$2 AND u.execution_epoch=$3
      AND u.desired_mode='RUNNING' AND g.state=ANY($4::text[])`, [target.unitId, target.attemptId, target.executionEpoch, active ? ['ACTIVE'] : ['RESERVED','ACTIVE']]);
    if (result.rowCount !== 1) deny('STORAGE_EXECUTION_NOT_CURRENT');
  }
  private async blocked(tx: DurableTransaction, target: StorageTarget, b: Binding, reason: string): Promise<StorageResult<never>> {
    const binding = await tx.query<Binding>(`UPDATE durable_runtime.storage_bindings SET access_state='BLOCKED',revision=revision+1
      WHERE id=$1 AND revision=$2 RETURNING *`, [b.id, b.revision]);
    const unit = await tx.query(`UPDATE durable_runtime.runtime_units SET phase='BLOCKED',reconcile_due_at=clock_timestamp(),revision=revision+1
      WHERE id=$1 AND revision=$2 RETURNING revision`, [target.unitId, target.expectedUnitRevision]);
    if (binding.rowCount !== 1 || unit.rowCount !== 1) deny('STORAGE_CAS');
    if (target.operation) await tx.query(`UPDATE durable_runtime.operations SET retry_at=clock_timestamp(),result=$2::jsonb,revision=revision+1
      WHERE id=$1`, [target.operation.id, JSON.stringify({ status: 'BLOCKED', reason })]);
    await this.event(tx, target, binding.rows[0], 'STORAGE_BLOCKED', { reason });
    return { status: 'BLOCKED', reason, bindingRevision: binding.rows[0].revision, unitRevision: unit.rows[0].revision };
  }
  private localPin(read: () => boolean): boolean {
    try { return read() === true; } catch { return false; }
  }
  private directoryPinValid(evidence: VerifiedDirectoryEvidence): boolean {
    try {
      return !!evidence.topologyPinId && Object.isFrozen(evidence) &&
        Object.isFrozen(evidence.candidate) && Object.isFrozen(evidence.candidate.domain) &&
        this.authority.directoryPinValid(evidence) === true;
    } catch { return false; }
  }
  private directory(b: Binding): VerifiedDirectoryEvidence | null {
    if (!b.identity_proof_ref) return null;
    try {
      const held = this.authority.directory(b.identity_proof_ref);
      if (!held || held.evidenceRef !== b.identity_proof_ref || !matchesBinding(held.candidate, b)) return null;
      return this.directoryPinValid(held) ? held : null;
    } catch { return null; }
  }
  private async revise(tx: DurableTransaction, binding: Binding, state: string, writer: string | null): Promise<Binding> {
    const result = await tx.query<Binding>(`UPDATE durable_runtime.storage_bindings SET access_state=$3,writer_attempt_id=$4,revision=revision+1
      WHERE id=$1 AND revision=$2 RETURNING *`, [binding.id, binding.revision, state, writer]);
    if (result.rowCount !== 1) deny('STORAGE_CAS');
    return result.rows[0];
  }
  async reserveWriter(tx: DurableTransaction, target: StorageTarget & { grantId: string }): Promise<StorageResult<WriterGrant>> {
    const { binding: b } = await this.lock(tx, target);
    await this.currentExecution(tx, target, false);
    if (!(this.directory(b))) return this.blocked(tx, target, b, 'DIRECTORY_UNVERIFIED_OR_CHANGED');
    const conflict = await tx.query(`SELECT g.id FROM durable_runtime.storage_write_grants g
      JOIN durable_runtime.storage_bindings b ON b.id=g.storage_binding_id
      WHERE g.state IN ('RESERVED','ACTIVE','REVOKING') AND b.backend_id=$1 AND b.export_id=$2
      AND (b.canonical_directory=$3 OR b.canonical_directory='/' OR $3='/'
        OR left(b.canonical_directory,length($3)+1)=$3||'/'
        OR left($3,length(b.canonical_directory)+1)=b.canonical_directory||'/')`, [b.backend_id, b.export_id, b.canonical_directory]);
    if (conflict.rowCount) return this.blocked(tx, target, b, 'WRITER_HELD');
    const grant = await tx.query<WriterGrant>(`INSERT INTO durable_runtime.storage_write_grants(id,storage_binding_id,attempt_id,storage_epoch,state)
      VALUES($1,$2,$3,$4,'RESERVED') RETURNING *`, [target.grantId, b.id, target.attemptId, b.epoch]);
    const updated = await this.revise(tx, b, 'RESERVED', target.attemptId);
    await this.event(tx, target, updated, 'STORAGE_WRITER_RESERVED', { grantId: target.grantId, state: 'RESERVED' });
    return { status: 'APPLIED', value: grant.rows[0] };
  }
  async registerReadOnlyMount(tx: DurableTransaction, target: StorageTarget & { mountId: string }): Promise<StorageResult<string>> {
    const { binding: b } = await this.lock(tx, target);
    if (!(this.directory(b))) return this.blocked(tx, target, b, 'DIRECTORY_UNVERIFIED_OR_CHANGED');
    await tx.query(`INSERT INTO durable_runtime.storage_mounts(id,storage_binding_id,attempt_id,pod_uid,mode,desired_state,observed_state,grant_epoch)
      VALUES($1,$2,$3,$4,'RO','ACTIVE','RESERVED',$5)`, [target.mountId, b.id, target.attemptId, target.podUid, b.epoch]);
    const updated = await this.revise(tx, b, b.access_state, b.writer_attempt_id);
    await this.event(tx, target, updated, 'STORAGE_RO_RESERVED', { mountId: target.mountId, state: 'RESERVED' });
    return { status: 'APPLIED', value: target.mountId };
  }
  private async grant(tx: DurableTransaction, target: StorageTarget, grantId: string, revision: string, state: State): Promise<WriterGrant> {
    const result = await tx.query<WriterGrant>(`SELECT * FROM durable_runtime.storage_write_grants
      WHERE id=$1 AND storage_binding_id=$2 AND attempt_id=$3 AND storage_epoch=$4 AND revision=$5 AND state=$6`,
      [grantId, target.bindingId, target.attemptId, target.storageEpoch, revision, state]);
    if (result.rowCount !== 1) deny('STORAGE_GRANT_STALE');
    return result.rows[0];
  }
  private targetMatches(a: ExecutionTarget, target: StorageTarget, incarnation: string): boolean {
    return a.attemptId === target.attemptId && a.podUid === target.podUid &&
      a.executionEpoch === target.executionEpoch && a.incarnation === incarnation && /^[1-9]\d*$/.test(a.numericInstanceId);
  }
  async observeMount(tx: DurableTransaction, target: StorageTarget & {
    mountId: string; mountEvidenceRef: string;
    writer?: { grantId: string; expectedRevision: string };
  }): Promise<StorageResult<string>> {
    const { binding: b, incarnation } = await this.lock(tx, target);
    if (target.writer) await this.currentExecution(tx, target, true);
    const directory = this.directory(b);
    let observation, expected;
    try {
      observation = this.authority.mount(target.mountEvidenceRef);
      expected = this.authority.executionTarget(target.attemptId, target.podUid, incarnation, target.executionEpoch);
    } catch { observation = null; expected = null; }
    const mode = target.writer ? 'RW' : 'RO';
    if (!directory || !observation || !expected || observation.evidenceRef !== target.mountEvidenceRef ||
        !Object.isFrozen(observation) || !Object.isFrozen(observation.directory) || !Object.isFrozen(observation.target) ||
        !Object.isFrozen(expected) || this.localPin(() => this.authority.executionTargetPinValid(expected!)) !== true || this.localPin(() => this.authority.mountPinValid(observation!)) !== true ||
        !sameDirectory(directory.candidate, observation.directory) || observation.mode !== mode ||
        !this.targetMatches(observation.target, target, incarnation) ||
        observation.target.nodeUid !== expected.nodeUid || observation.target.computeIdentityRef !== expected.computeIdentityRef ||
        observation.target.numericInstanceId !== expected.numericInstanceId || observation.actualReadOnly !== (mode === 'RO'))
      return this.blocked(tx, target, b, 'MOUNT_UNVERIFIED');
    if (target.writer) {
      await this.grant(tx, target, target.writer.grantId, target.writer.expectedRevision, 'RESERVED');
      await tx.query(`INSERT INTO durable_runtime.storage_mounts(id,storage_binding_id,attempt_id,pod_uid,mode,write_grant_id,desired_state,observed_state,grant_epoch,mounted_at,evidence_ref)
        VALUES($1,$2,$3,$4,'RW',$5,'ACTIVE','ACTIVE',$6,clock_timestamp(),$7)`,
        [target.mountId, b.id, target.attemptId, target.podUid, target.writer.grantId, b.epoch, target.mountEvidenceRef]);
      await tx.query(`UPDATE durable_runtime.storage_write_grants SET state='ACTIVE',revision=revision+1 WHERE id=$1`, [target.writer.grantId]);
    } else {
      const row = await tx.query(`UPDATE durable_runtime.storage_mounts SET observed_state='ACTIVE',mounted_at=clock_timestamp(),evidence_ref=$6
        WHERE id=$1 AND storage_binding_id=$2 AND attempt_id=$3 AND pod_uid=$4 AND grant_epoch=$5 AND mode='RO' AND observed_state='RESERVED'`,
        [target.mountId, b.id, target.attemptId, target.podUid, b.epoch, target.mountEvidenceRef]);
      if (row.rowCount !== 1) deny('STORAGE_MOUNT_STALE');
    }
    const updated = await this.revise(tx, b, target.writer ? 'ACTIVE' : b.access_state, b.writer_attempt_id);
    await this.event(tx, target, updated, 'STORAGE_MOUNT_OBSERVED', { mountId: target.mountId, state: 'ACTIVE' });
    return { status: 'APPLIED', value: target.mountId };
  }
  async beginRevocation(tx: DurableTransaction, target: StorageTarget & {
    grantId: string; expectedGrantRevision: string; expectedGrantState: 'RESERVED' | 'ACTIVE';
  }): Promise<WriterGrant> {
    const { binding: b } = await this.lock(tx, target);
    await this.grant(tx, target, target.grantId, target.expectedGrantRevision, target.expectedGrantState);
    const row = await tx.query<WriterGrant>(`UPDATE durable_runtime.storage_write_grants SET state='REVOKING',revision=revision+1 WHERE id=$1 RETURNING *`, [target.grantId]);
    await tx.query(`UPDATE durable_runtime.storage_mounts SET desired_state='REVOKED',observed_state='REVOKING',revoking_at=clock_timestamp()
      WHERE write_grant_id=$1 AND observed_state<>'REVOKED'`, [target.grantId]);
    const updated = await this.revise(tx, b, 'REVOKING', target.attemptId);
    await this.event(tx, target, updated, 'STORAGE_WRITER_REVOKING', { grantId: target.grantId, state: 'REVOKING' });
    return row.rows[0];
  }
  async confirmRevocation(tx: DurableTransaction, target: StorageTarget & {
    grantId: string; expectedGrantRevision: string; permanentStopRef: string;
  }): Promise<StorageResult<Binding>> {
    const { binding: b, incarnation } = await this.lock(tx, target);
    await this.grant(tx, target, target.grantId, target.expectedGrantRevision, 'REVOKING');
    if (!this.directory(b)) return this.blocked(tx, target, b, 'DIRECTORY_PIN_INVALID');
    let stopped, expected;
    try {
      stopped = this.authority.permanentComputeStop(target.permanentStopRef);
      expected = this.authority.executionTarget(target.attemptId, target.podUid, incarnation, target.executionEpoch);
    } catch { stopped = null; expected = null; }
    const proof = stopped?.proof;
    if (!stopped || !expected || !proof || !Object.isFrozen(stopped) || !Object.isFrozen(proof) ||
        !Object.isFrozen(expected) || this.localPin(() => this.authority.executionTargetPinValid(expected!)) !== true ||
        this.localPin(() => this.authority.computeStopPinValid(stopped!)) !== true || stopped.disposition !== 'DELETED_NO_REENTRY' ||
        proof.evidenceRef !== target.permanentStopRef || proof.kind !== 'COMPUTE_STOPPED' ||
        proof.observationSource !== 'COMPUTE_CONTROL_PLANE' || !this.targetMatches(expected, target, incarnation) ||
        proof.attemptId !== expected.attemptId || proof.podUid !== expected.podUid ||
        proof.executionEpoch !== expected.executionEpoch || proof.incarnation !== expected.incarnation ||
        proof.nodeUid !== expected.nodeUid || proof.computeIdentityRef !== expected.computeIdentityRef ||
        stopped.numericInstanceId !== expected.numericInstanceId)
      return this.blocked(tx, target, b, 'COMPUTE_STOP_UNCONFIRMED');
    await tx.query(`UPDATE durable_runtime.storage_write_grants SET state='REVOKED',revoked_at=clock_timestamp(),revocation_proof_ref=$2,revision=revision+1 WHERE id=$1`,
      [target.grantId, target.permanentStopRef]);
    await tx.query(`UPDATE durable_runtime.storage_mounts SET desired_state='REVOKED',observed_state='REVOKED',revoked_at=clock_timestamp(),evidence_ref=$2 WHERE write_grant_id=$1 AND observed_state<>'REVOKED'`,
      [target.grantId, target.permanentStopRef]);
    const updated = await tx.query<Binding>(`UPDATE durable_runtime.storage_bindings SET epoch=epoch+1,revision=revision+1,access_state='VERIFIED',writer_attempt_id=NULL WHERE id=$1 RETURNING *`, [b.id]);
    await this.event(tx, target, updated.rows[0], 'STORAGE_WRITER_REVOKED', { grantId: target.grantId, state: 'REVOKED' });
    // A caller may reserve the next grant in this SAME tx with the returned epoch
    // and revision. If that fails, the whole revoke/epoch/reservation rolls back.
    return { status: 'APPLIED', value: updated.rows[0] };
  }
  async recordBlocked(tx: DurableTransaction, target: StorageTarget & {
    reason: 'OBSERVATION_LOST' | 'COMPUTE_STOP_FAILED' | 'IDENTITY_CHANGED';
  }): Promise<StorageResult<never>> {
    const { binding } = await this.lock(tx, target);
    return this.blocked(tx, target, binding, target.reason);
  }
}
