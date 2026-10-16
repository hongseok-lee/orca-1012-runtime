import type { Pool } from 'pg';
import { DurableDatabaseError, runDurableTransaction, type DurableTransactionResult } from '../db/connection.ts';
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts';
import type { BindingVerificationInput } from './binding-verification.ts';
import type { StorageEvidenceAuthority, VerifiedDirectoryEvidence } from './evidence.ts';
import { StorageStore, type Binding } from './store.ts';

/** Externally prepared capability, not a physical pin issuer. Release errors
 * leave this handle with its owner until an explicit external resolution. */
export type PreparedBindingPinLease = Readonly<{
  evidence: VerifiedDirectoryEvidence;
  release(): void | Promise<void>;
}>;
export type PreparedBindingPinOwner = Readonly<{
  /** Synchronous exclusive handoff of an ALREADY held pin. A throw must leave
   * ownership here; a return transfers it through actual transaction settlement. */
  takePreparedPin(evidence: VerifiedDirectoryEvidence): PreparedBindingPinLease;
}>;
export type BindingPinDisposition = Readonly<{
  disposition: 'RELEASED'; releaseError: null; retainedOwner: null; retainedLease: null;
}> | Readonly<{
  disposition: 'RETAINED'; reason: 'UNCONFIRMED' | 'RELEASE_FAILED' | 'INVALID_HANDOFF' | 'TAKE_FAILED';
  releaseError: DurableDatabaseError | null;
  retainedOwner: PreparedBindingPinOwner; retainedLease: PreparedBindingPinLease | null;
}>;
export type BindingVerificationTransactionResult = Readonly<{
  database: DurableTransactionResult<Binding>;
  pin: BindingPinDisposition;
  physicalPinIssuerImplemented: false;
}>;

function reference(value: string): string {
  if (typeof value !== 'string' || !value || [...value].some(char => char.charCodeAt(0) < 32)) {
    throw new DurableDatabaseError('STORAGE_EVIDENCE_REF');
  }
  return value;
}

/** Caller supplies an immutable prepared authority and trusted atomic owner.
 * Rejection before take leaves ownership with the caller. No physical issuer. */
export async function verifyBindingWithPreparedPin(
  pool: Pool, original: BindingVerificationInput,
  authority: StorageEvidenceAuthority, owner: PreparedBindingPinOwner,
): Promise<BindingVerificationTransactionResult> {
  const input = Object.freeze({
    sessionId: logicalId('session', original.sessionId), unitId: logicalId('runtime-unit', original.unitId),
    bindingId: logicalId('storage-binding', original.bindingId),
    expectedUnitRevision: counter('row:runtime-unit', original.expectedUnitRevision),
    expectedBindingRevision: counter('row:storage-binding', original.expectedBindingRevision),
    directoryEvidenceRef: reference(original.directoryEvidenceRef), actorId: reference(original.actorId),
  });
  if (!Object.isFrozen(authority) || !Object.isFrozen(owner)) {
    throw new DurableDatabaseError('STORAGE_PREPARED_OWNER_REQUIRED');
  }
  const directory = authority.directory.bind(authority), pinValid = authority.directoryPinValid.bind(authority);
  const take = owner.takePreparedPin.bind(owner), connect = pool.connect.bind(pool);
  let prepared;
  try { prepared = directory(input.directoryEvidenceRef); }
  catch { throw new DurableDatabaseError('STORAGE_DIRECTORY_UNVERIFIED'); }
  if (!prepared || prepared.evidenceRef !== input.directoryEvidenceRef ||
      !Object.isFrozen(prepared) || !Object.isFrozen(prepared.candidate) || !Object.isFrozen(prepared.candidate.domain)) {
    throw new DurableDatabaseError('STORAGE_DIRECTORY_UNVERIFIED');
  }
  const evidence = prepared;
  const capturedAuthority = Object.freeze({
    directory: (ref: string) => ref === input.directoryEvidenceRef ? evidence : null,
    directoryPinValid: (held: VerifiedDirectoryEvidence) => held === evidence && pinValid(held),
    mount: authority.mount.bind(authority), mountPinValid: authority.mountPinValid.bind(authority),
    executionTarget: authority.executionTarget.bind(authority), executionTargetPinValid: authority.executionTargetPinValid.bind(authority),
    permanentComputeStop: authority.permanentComputeStop.bind(authority), computeStopPinValid: authority.computeStopPinValid.bind(authority),
  });
  const store = new StorageStore(capturedAuthority), verify = store.verifyBinding.bind(store);
  const notStarted = (code: string, reason: 'TAKE_FAILED' | 'INVALID_HANDOFF',
    lease: PreparedBindingPinLease | null): BindingVerificationTransactionResult => Object.freeze({
    database: Object.freeze({ ok: false, settlement: 'NOT_STARTED', commitOutcome: 'NOT_ATTEMPTED',
      error: new DurableDatabaseError(code), cleanupFailed: false }),
    pin: Object.freeze({ disposition: 'RETAINED', reason, releaseError: null, retainedOwner: owner, retainedLease: lease }),
    physicalPinIssuerImplemented: false,
  });
  let lease;
  try { lease = take(evidence); }
  catch { return notStarted('STORAGE_PIN_HANDOFF_FAILED', 'TAKE_FAILED', null); }
  if (!lease || !Object.isFrozen(lease) || lease.evidence !== evidence || typeof lease.release !== 'function') {
    return notStarted('STORAGE_PIN_HANDOFF_INVALID', 'INVALID_HANDOFF', lease ?? null);
  }
  const heldLease = lease, release = heldLease.release.bind(heldLease);
  const retained = (reason: 'UNCONFIRMED' | 'RELEASE_FAILED',
    releaseError: DurableDatabaseError | null = null): BindingPinDisposition => Object.freeze({
    disposition: 'RETAINED', reason, releaseError, retainedOwner: owner, retainedLease: heldLease,
  });
  // Borrow the original pool, capture its receiver, and never end it here.
  const borrowed: Pool = Object.create(pool, { connect: { value: connect } });
  const database = await runDurableTransaction<Binding>(borrowed, tx => verify(tx, input));
  if (database.settlement === 'UNCONFIRMED') {
    return Object.freeze({ database, pin: retained('UNCONFIRMED'), physicalPinIssuerImplemented: false });
  }
  try {
    await release();
  } catch {
    return Object.freeze({ database, pin: retained('RELEASE_FAILED', new DurableDatabaseError('STORAGE_PIN_RELEASE_FAILED')),
      physicalPinIssuerImplemented: false });
  }
  return Object.freeze({ database, pin: Object.freeze({ disposition: 'RELEASED', releaseError: null,
    retainedOwner: null, retainedLease: null }), physicalPinIssuerImplemented: false });
}
