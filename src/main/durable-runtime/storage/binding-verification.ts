import { DurableDatabaseError, type DurableTransaction } from '../db/connection.ts';
import { lockAggregates } from '../db/locks.ts';
import { counter, logicalId, type RowRevision } from '../../../shared/durable-runtime/identity.ts';
import type { StorageEvidenceAuthority, VerifiedDirectoryEvidence } from './evidence.ts';
import type { Binding, StorageScope } from './store.ts';

export type BindingVerificationInput = StorageScope & {
  bindingId: Binding['id']; expectedBindingRevision: RowRevision<'storage-binding'>;
  directoryEvidenceRef: string;
};
type VerificationRow = Binding & { identity_verified_at: Date | null; seal_id: string | null };
type RecordVerification = (tx: DurableTransaction, scope: StorageScope, binding: Binding,
  kind: 'STORAGE_BINDING_VERIFIED') => Promise<void>;

function deny(code: string): never { throw new DurableDatabaseError(code); }
function reference(value: string): string {
  if (typeof value !== 'string' || !value || [...value].some(char => char.charCodeAt(0) < 32)) {
    deny('STORAGE_EVIDENCE_REF');
  }
  return value;
}

/** Consumes prepared evidence only. Its owner retains the topology pin through
 * the caller's actual COMMIT/ROLLBACK; these local checks do not prove lifetime. */
export async function verifyBindingInTransaction(
  tx: DurableTransaction, original: BindingVerificationInput, authority: StorageEvidenceAuthority,
  pinValid: (evidence: VerifiedDirectoryEvidence) => boolean, record: RecordVerification,
): Promise<Binding> {
  const input = Object.freeze({
    sessionId: logicalId('session', original.sessionId), unitId: logicalId('runtime-unit', original.unitId),
    bindingId: logicalId('storage-binding', original.bindingId),
    expectedUnitRevision: counter('row:runtime-unit', original.expectedUnitRevision),
    expectedBindingRevision: counter('row:storage-binding', original.expectedBindingRevision),
    directoryEvidenceRef: reference(original.directoryEvidenceRef), actorId: reference(original.actorId),
  });
  const query = tx.query.bind(tx), directory = authority.directory.bind(authority);
  let held;
  try { held = directory(input.directoryEvidenceRef); }
  catch { deny('STORAGE_DIRECTORY_UNVERIFIED'); }
  if (!held || held.evidenceRef !== input.directoryEvidenceRef) { deny('STORAGE_DIRECTORY_UNVERIFIED'); }
  const evidence = held;
  const checkPin = (): void => {
    if (!pinValid(evidence)) { deny('STORAGE_DIRECTORY_PIN_INVALID'); }
  };
  checkPin();
  const { backendId, exportId } = evidence.candidate.domain;
  const canonicalDirectory = evidence.candidate.canonicalDirectory;
  const matches = (binding: Binding): boolean => binding.backend_id === backendId &&
    binding.export_id === exportId && binding.canonical_directory === canonicalDirectory;

  await lockAggregates(tx, { sessionIds: [input.sessionId], runtimeUnitIds: [input.unitId] });
  const scope = await query<{ lifecycle: string; revision: string; member: boolean }>(
    `SELECT s.lifecycle,u.revision,EXISTS(SELECT 1 FROM durable_runtime.runtime_member_storage_bindings m
      WHERE m.session_id=s.id AND m.runtime_unit_id=u.id AND m.storage_binding_id=$3) AS member
     FROM durable_runtime.sessions s CROSS JOIN durable_runtime.runtime_units u WHERE s.id=$1 AND u.id=$2`,
    [input.sessionId, input.unitId, input.bindingId]);
  if (scope.rowCount !== 1 || !scope.rows[0].member) { deny('STORAGE_MEMBER_MISSING'); }
  if (scope.rows[0].lifecycle !== 'OPEN') { deny('STORAGE_SESSION_CLOSED'); }
  if (scope.rows[0].revision !== input.expectedUnitRevision) { deny('STORAGE_UNIT_STALE'); }
  const first = await query<VerificationRow>('SELECT * FROM durable_runtime.storage_bindings WHERE id=$1', [input.bindingId]);
  if (first.rowCount !== 1) { deny('STORAGE_BINDING_MISSING'); }
  if (!matches(first.rows[0])) { deny('STORAGE_DIRECTORY_MISMATCH'); }
  await lockAggregates(tx, { storageDomains: [{ backendId, exportId }] });
  // Held through the caller's transaction. Child mount/grant FK inserts also
  // serialize on this row. Read history in a NEW statement after a lock wait.
  const locked = await query<VerificationRow>(
    'SELECT * FROM durable_runtime.storage_bindings WHERE id=$1 FOR UPDATE', [input.bindingId]);
  if (locked.rowCount !== 1) { deny('STORAGE_BINDING_MISSING'); }
  const binding = locked.rows[0];
  checkPin();
  if (!matches(binding)) { deny('STORAGE_DIRECTORY_MISMATCH'); }
  const history = await query<{ grants: boolean; mounts: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM durable_runtime.storage_write_grants WHERE storage_binding_id=$1) AS grants,
      EXISTS(SELECT 1 FROM durable_runtime.storage_mounts WHERE storage_binding_id=$1) AS mounts`, [input.bindingId]);
  if (binding.epoch !== '0' || binding.writer_attempt_id !== null || binding.seal_id !== null ||
      history.rows[0].grants || history.rows[0].mounts) { deny('STORAGE_BINDING_USED'); }
  if (binding.access_state === 'VERIFIED') {
    if (binding.identity_proof_ref !== input.directoryEvidenceRef || binding.identity_verified_at === null) {
      deny('STORAGE_VERIFICATION_PROOF_MISMATCH');
    }
    if (input.expectedBindingRevision !== binding.revision &&
        BigInt(input.expectedBindingRevision) !== BigInt(binding.revision) - 1n) { deny('STORAGE_BINDING_STALE'); }
    checkPin();
    return binding;
  }
  if (binding.access_state !== 'UNVERIFIED' || binding.identity_proof_ref !== null || binding.identity_verified_at !== null) {
    deny('STORAGE_VERIFICATION_STATE');
  }
  if (binding.revision !== input.expectedBindingRevision) { deny('STORAGE_BINDING_STALE'); }
  checkPin();
  const updated = await query<Binding>(`UPDATE durable_runtime.storage_bindings
    SET identity_proof_ref=$3,identity_verified_at=clock_timestamp(),access_state='VERIFIED',revision=revision+1
    WHERE id=$1 AND revision=$2 AND access_state='UNVERIFIED' AND identity_proof_ref IS NULL
      AND identity_verified_at IS NULL AND epoch=0 AND writer_attempt_id IS NULL AND seal_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM durable_runtime.storage_write_grants WHERE storage_binding_id=$1)
      AND NOT EXISTS(SELECT 1 FROM durable_runtime.storage_mounts WHERE storage_binding_id=$1) RETURNING *`,
    [input.bindingId, input.expectedBindingRevision, input.directoryEvidenceRef]);
  if (updated.rowCount !== 1) { deny('STORAGE_CAS'); }
  checkPin();
  await record(tx, input, updated.rows[0], 'STORAGE_BINDING_VERIFIED');
  return updated.rows[0];
}
