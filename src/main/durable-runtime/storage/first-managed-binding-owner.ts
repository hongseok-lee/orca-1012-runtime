import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { DurableDatabaseError, DurableTransactionResult } from '../db/connection.ts';
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts';
import { createManagedLeafCredentialReader, type ManagedLeafCredentialConfig } from './managed-leaf-credential.ts';
import { createManagedLeafCollector, ManagedLeafCollectorError } from './managed-leaf-collector.ts';
import { captureManagedLeafConfig, managedLeafUuid } from './managed-leaf-collector-config.ts';
import type { ManagedLeafCollectorConfig, ManagedLeafCollectorDependencies,
  AuthenticatedManagedLeafObservation } from './managed-leaf-collector-types.ts';
import { acquireNamespaceHold, releaseNamespaceHold, type NamespaceHoldInput,
  type NamespaceTransactionResult } from './namespace-holds.ts';
import { recordPreparedDirectoryObservation, type PreparedDirectoryObservationInput,
  type PreparedDirectoryObservationRecord } from './prepared-directory-observation.ts';
import { verifyBindingWithPreparedPin, type BindingVerificationTransactionResult,
  type PreparedBindingPinOwner, type PreparedBindingPinLease } from './binding-verification-transaction.ts';
import type { StorageEvidenceAuthority, VerifiedDirectoryEvidence } from './evidence.ts';
import { captureFirstManagedBindingProfile, requireProfileCollectorIdentity,
  FirstManagedBindingOwnerError } from './first-managed-binding-owner-profile.ts';

export type FirstManagedBindingOwnerConfig = Readonly<{
  acceptedProfileBytes: Uint8Array;
  expectedProfileDigest: string;
  credential: ManagedLeafCredentialConfig;
  collector: Omit<ManagedLeafCollectorConfig, 'readReviewerBearer'>;
}>;
export type FirstManagedBindingInput = PreparedDirectoryObservationInput['scope'] & Readonly<{
  pinId: string; ownerToken: string; leafId: string;
}>;
type SafeBindingResult = Readonly<{
  database: BindingVerificationTransactionResult['database'];
  engineError: DurableDatabaseError | null;
  pin: Readonly<{ disposition: 'RELEASED' | 'RETAINED'; reason: string | null; releaseError: DurableDatabaseError | null }>;
  physicalPinIssuerImplemented: false;
}>;
export type FirstManagedBindingResult = Readonly<{
  phase: 'HOLD' | 'COLLECT' | 'AUDIT' | 'VERIFY' | 'RELEASE';
  outcome: 'VERIFIED' | 'FAILED' | 'RECONCILIATION_REQUIRED';
  hold: NamespaceTransactionResult | null;
  audit: DurableTransactionResult<PreparedDirectoryObservationRecord> | null;
  binding: SafeBindingResult | null;
  release: NamespaceTransactionResult | null;
  qualificationRef: string; observationRef: string | null; evidenceRef: string | null;
  pin: Readonly<{ pinId: string; state: 'NOT_ACQUIRED' | 'PREEXISTING' | 'HELD' | 'RELEASED' | 'UNKNOWN';
    handedOff: boolean; failedPreparationReleaseEligible: boolean }>;
  errorCode: string | null;
  namespacePin: false; physicalPinIssued: false; writerGrantActivated: false;
}>;
type Operation = {
  holdInput: NamespaceHoldInput;
  scope: PreparedDirectoryObservationInput['scope'];
  tokenHash: string;
  hold: NamespaceTransactionResult | null;
  audit: DurableTransactionResult<PreparedDirectoryObservationRecord> | null;
  binding: SafeBindingResult | null;
  release: NamespaceTransactionResult | null;
  observationRef: string | null; evidenceRef: string | null;
  pinState: FirstManagedBindingResult['pin']['state'];
  handedOff: boolean; releaseEligible: boolean; releaseAttempted: boolean;
  reconciliation: boolean;
  // Retained handles remain private to this owner; safe results never expose them.
  preparedOwner: PreparedBindingPinOwner | null;
  retainedLease: PreparedBindingPinLease | null;
};

function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512 || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new FirstManagedBindingOwnerError('FIRST_MANAGED_INPUT_INVALID');
  }
  return value;
}
function tokenHash(value: unknown): string {
  const token = text(value);
  if (token.length < 32) throw new FirstManagedBindingOwnerError('FIRST_MANAGED_TOKEN_INVALID');
  return createHash('sha256').update(token).digest('hex');
}
function confirmed<T>(result: DurableTransactionResult<T>): result is Extract<DurableTransactionResult<T>, { ok: true }> {
  return result.ok && result.settlement === 'COMMITTED' && result.commitOutcome === 'ACKNOWLEDGED';
}
function definiteFailure<T>(result: DurableTransactionResult<T>): boolean {
  return !result.ok && result.settlement !== 'UNCONFIRMED' && result.commitOutcome === 'NOT_ATTEMPTED' && !result.cleanupFailed;
}
function safeBinding(result: BindingVerificationTransactionResult): SafeBindingResult {
  const pin = result.pin;
  return Object.freeze({ database: result.database, engineError: result.engineError,
    pin: Object.freeze({ disposition: pin.disposition,
      reason: pin.disposition === 'RETAINED' ? pin.reason : null, releaseError: pin.releaseError }),
    physicalPinIssuerImplemented: false });
}
function pinReleased(operation: Operation): boolean { return operation.pinState === 'RELEASED'; }
function captureCall(original: FirstManagedBindingInput) {
  try {
    const scope: PreparedDirectoryObservationInput['scope'] = Object.freeze({
      sessionId: logicalId('session', original.sessionId), unitId: logicalId('runtime-unit', original.unitId),
      bindingId: logicalId('storage-binding', original.bindingId),
      expectedUnitRevision: counter('row:runtime-unit', original.expectedUnitRevision),
      expectedBindingRevision: counter('row:storage-binding', original.expectedBindingRevision), actorId: text(original.actorId) });
    const pinId = logicalId('storage-namespace-pin', original.pinId), ownerToken = text(original.ownerToken);
    return Object.freeze({ scope, pinId, ownerToken, hash: tokenHash(ownerToken), leafId: managedLeafUuid(original.leafId) });
  } catch {
    // An accessor can throw a secret; never propagate its raw exception.
    throw new FirstManagedBindingOwnerError('FIRST_MANAGED_INPUT_INVALID');
  }
}

/** Server configuration only: no RPC registration, caller observation, injected
 * collector callback, live qualification or public authority/lease is exposed. */
export function createFirstManagedBindingOwner(pool: Pool, original: FirstManagedBindingOwnerConfig,
  dependencies?: ManagedLeafCollectorDependencies): Readonly<{
    verifyFirstBinding(input: FirstManagedBindingInput, signal: AbortSignal): Promise<FirstManagedBindingResult>;
    releaseFailedPreparation(input: Readonly<{ pinId: string; ownerToken: string }>): Promise<FirstManagedBindingResult>;
  }> {
  const accepted = captureFirstManagedBindingProfile(original.acceptedProfileBytes, original.expectedProfileDigest);
  const profile = accepted.record;
  const connect = pool.connect.bind(pool);
  const borrowed: Pool = Object.create(pool, { connect: { value: connect } });
  const sourceCredential = original.credential;
  const credential: ManagedLeafCredentialConfig = Object.freeze({ apiOrigin: sourceCredential.apiOrigin,
    ca: Buffer.from(sourceCredential.ca), namespace: sourceCredential.namespace,
    serviceAccountName: sourceCredential.serviceAccountName, serviceAccountUid: sourceCredential.serviceAccountUid,
    timeoutMs: sourceCredential.timeoutMs, readIssuerBearer: sourceCredential.readIssuerBearer.bind(sourceCredential) });
  const reader = createManagedLeafCredentialReader(credential, dependencies?.https);
  const collectorConfig = captureManagedLeafConfig({ ...original.collector, ca: Buffer.from(original.collector.ca),
    readReviewerBearer: reader.readReviewerBearer });
  requireProfileCollectorIdentity(profile, collectorConfig, credential);
  const collector = createManagedLeafCollector(collectorConfig, dependencies);
  const collect = collector.collect.bind(collector), acquire = acquireNamespaceHold,
    recordObservation = recordPreparedDirectoryObservation, verify = verifyBindingWithPreparedPin,
    release = releaseNamespaceHold;
  const operations = new Map<string, Operation>();

  function result(operation: Operation, phase: FirstManagedBindingResult['phase'],
    outcome: FirstManagedBindingResult['outcome'], errorCode: string | null = null): FirstManagedBindingResult {
    return Object.freeze({ phase, outcome, hold: operation.hold, audit: operation.audit, binding: operation.binding,
      release: operation.release, qualificationRef: profile.qualificationRef, observationRef: operation.observationRef,
      evidenceRef: operation.evidenceRef, pin: Object.freeze({ pinId: operation.holdInput.pinId, state: operation.pinState,
        handedOff: operation.handedOff, failedPreparationReleaseEligible: operation.releaseEligible }), errorCode,
      namespacePin: false, physicalPinIssued: false, writerGrantActivated: false });
  }

  async function releaseOwned(operation: Operation): Promise<void> {
    if (operation.releaseAttempted) throw new FirstManagedBindingOwnerError('FIRST_MANAGED_RELEASE_ALREADY_ATTEMPTED');
    operation.releaseAttempted = true;
    operation.releaseEligible = false;
    let released;
    try { released = await release(borrowed, operation.holdInput); }
    catch {
      operation.pinState = 'UNKNOWN'; operation.reconciliation = true;
      throw new FirstManagedBindingOwnerError('FIRST_MANAGED_RELEASE_ENGINE_REJECTED');
    }
    operation.release = released;
    if (confirmed(released.database) &&
        (released.disposition?.status === 'RELEASED' || released.disposition?.status === 'ALREADY_RELEASED')) {
      operation.pinState = 'RELEASED';
      // A known release COMMIT stays known even if client cleanup failed.
      operation.reconciliation ||= released.database.cleanupFailed;
      return;
    }
    operation.pinState = definiteFailure(released.database) ? 'HELD' : 'UNKNOWN';
    operation.reconciliation = true;
    throw new FirstManagedBindingOwnerError('FIRST_MANAGED_RELEASE_NOT_CONFIRMED');
  }

  function checkObservation(observation: AuthenticatedManagedLeafObservation, leafId: string): void {
    const candidate = observation.candidate, storage = observation.storage;
    if (observation.kind !== 'AUTHENTICATED_MANAGED_LEAF_OBSERVATION' || observation.namespacePin !== false ||
        observation.dataset !== profile.profile.datasetName || observation.leafId !== leafId ||
        observation.clusterIdentityRef !== profile.collector.clusterIdentityRef || observation.namespace !== profile.collector.namespace ||
        observation.reference !== `managed-leaf-observation:sha256:${observation.evidenceDigest}` ||
        !/^[a-f0-9]{64}$/u.test(observation.evidenceDigest) ||
        candidate.canonicalDirectory !== `/${profile.profile.datasetName}/${leafId}` ||
        candidate.domain.backendId !== profile.profile.backendId || candidate.domain.exportId !== profile.profile.exportId ||
        candidate.domain.pvUid !== profile.storage.pvUid ||
        storage.pvc.name !== profile.storage.pvcName || storage.pvc.uid !== profile.storage.pvcUid ||
        storage.pv.name !== profile.storage.pvName || storage.pv.uid !== profile.storage.pvUid ||
        storage.pv.csiDriver !== profile.storage.csiDriver || storage.pv.volumeHandle !== profile.storage.volumeHandle ||
        storage.helper.name !== profile.collector.helperConfigMapName || storage.helper.uid !== profile.collector.helperConfigMapUid ||
        storage.helper.sha256 !== profile.collector.helperSha256) {
      throw new FirstManagedBindingOwnerError('FIRST_MANAGED_OBSERVATION_SCOPE');
    }
  }

  async function run(operation: Operation, leafId: string, signal: AbortSignal): Promise<FirstManagedBindingResult> {
    try { operation.hold = await acquire(borrowed, operation.holdInput); }
    catch {
      operation.pinState = 'UNKNOWN'; operation.reconciliation = true;
      return result(operation, 'HOLD', 'RECONCILIATION_REQUIRED', 'FIRST_MANAGED_HOLD_ENGINE_REJECTED');
    }
    const acquired = operation.hold;
    if (!confirmed(acquired.database) || acquired.disposition?.status !== 'ACQUIRED' || acquired.database.cleanupFailed) {
      operation.pinState = confirmed(acquired.database) && acquired.disposition?.status === 'ACQUIRED' ? 'HELD' :
        acquired.disposition?.status === 'ALREADY_HELD' || acquired.disposition?.status === 'ALREADY_RELEASED' ? 'PREEXISTING' :
          definiteFailure(acquired.database) ? 'NOT_ACQUIRED' : 'UNKNOWN';
      operation.reconciliation = true;
      return result(operation, 'HOLD', 'RECONCILIATION_REQUIRED', 'FIRST_MANAGED_HOLD_NOT_NEWLY_CONFIRMED');
    }
    operation.pinState = 'HELD';
    let observation: AuthenticatedManagedLeafObservation;
    try {
      observation = await collect(leafId, signal);
      operation.observationRef = observation.reference;
      checkObservation(observation, leafId);
    } catch (error) {
      operation.releaseEligible = error instanceof ManagedLeafCollectorError || error instanceof FirstManagedBindingOwnerError;
      operation.reconciliation = !operation.releaseEligible;
      const code = error instanceof ManagedLeafCollectorError || error instanceof FirstManagedBindingOwnerError ? error.code : 'FIRST_MANAGED_COLLECTOR_REJECTED';
      return result(operation, 'COLLECT', operation.reconciliation ? 'RECONCILIATION_REQUIRED' : 'FAILED', code);
    }
    const evidenceRef = `first-managed-binding:sha256:${createHash('sha256').update(JSON.stringify({
      profileDigest: accepted.digest, profileId: profile.profile.profileId, generation: profile.profile.generation,
      pinId: operation.holdInput.pinId, scope: operation.scope, leafId, observationRef: observation.reference,
      qualificationRef: profile.qualificationRef })).digest('hex')}`;
    operation.evidenceRef = evidenceRef;
    const auditInput: PreparedDirectoryObservationInput = Object.freeze({ hold: operation.holdInput, scope: operation.scope,
      qualificationRef: profile.qualificationRef, observation, evidenceRef });
    try { operation.audit = await recordObservation(borrowed, auditInput); }
    catch {
      operation.reconciliation = true;
      return result(operation, 'AUDIT', 'RECONCILIATION_REQUIRED', 'FIRST_MANAGED_AUDIT_ENGINE_REJECTED');
    }
    if (!confirmed(operation.audit) || operation.audit.cleanupFailed) {
      operation.releaseEligible = definiteFailure(operation.audit);
      operation.reconciliation = !operation.releaseEligible;
      return result(operation, 'AUDIT', operation.reconciliation ? 'RECONCILIATION_REQUIRED' : 'FAILED', 'FIRST_MANAGED_AUDIT_NOT_CONFIRMED');
    }
    if (operation.audit.value.evidenceRef !== evidenceRef || !operation.audit.value.auditId) {
      operation.reconciliation = true;
      return result(operation, 'AUDIT', 'RECONCILIATION_REQUIRED', 'FIRST_MANAGED_AUDIT_REFERENCE_MISMATCH');
    }
    // Only this Root-accepted configuration + fresh confirmed hold + original
    // collector + confirmed audit boundary constructs the internal brand.
    // The original Pod/generation/device/inode are copied without rewriting.
    const candidate = Object.freeze({ ...observation.candidate, domain: Object.freeze({ ...observation.candidate.domain }) });
    const evidence = Object.freeze({ evidenceRef, topologyPinId: operation.holdInput.pinId, candidate }) as VerifiedDirectoryEvidence;
    const authority: StorageEvidenceAuthority = Object.freeze({
      directory: (reference: string) => reference === evidenceRef && operation.pinState === 'HELD' ? evidence : null,
      directoryPinValid: (held: VerifiedDirectoryEvidence) => held === evidence && operation.pinState === 'HELD',
      mount: () => null, mountPinValid: () => false,
      executionTarget: () => null, executionTargetPinValid: () => false,
      permanentComputeStop: () => null, computeStopPinValid: () => false,
    });
    const owner: PreparedBindingPinOwner = Object.freeze({ takePreparedPin(held: VerifiedDirectoryEvidence) {
      if (held !== evidence || operation.handedOff || operation.pinState !== 'HELD') {
        throw new FirstManagedBindingOwnerError('FIRST_MANAGED_EXCLUSIVE_HANDOFF');
      }
      const lease = Object.freeze({ evidence, release: () => releaseOwned(operation) });
      operation.handedOff = true;
      return lease;
    } });
    operation.preparedOwner = owner;
    let verified;
    try { verified = await verify(borrowed, { ...operation.scope, directoryEvidenceRef: evidenceRef }, authority, owner); }
    catch {
      operation.reconciliation = true;
      return result(operation, 'VERIFY', 'RECONCILIATION_REQUIRED', 'FIRST_MANAGED_VERIFIER_REJECTED');
    }
    operation.binding = safeBinding(verified);
    if (verified.pin.disposition === 'RETAINED') {
      operation.preparedOwner = verified.pin.retainedOwner;
      operation.retainedLease = verified.pin.retainedLease;
    } else {
      operation.preparedOwner = null;
      operation.retainedLease = null;
    }
    const succeeded = verified.database && confirmed(verified.database) && !verified.database.cleanupFailed &&
      verified.pin.disposition === 'RELEASED' && pinReleased(operation) && !operation.reconciliation;
    if (succeeded) return result(operation, 'VERIFY', 'VERIFIED');
    operation.reconciliation ||= verified.pin.disposition === 'RETAINED' || verified.engineError !== null ||
      verified.database === null || verified.database.cleanupFailed || verified.database.settlement === 'UNCONFIRMED' ||
      verified.database.commitOutcome === 'UNKNOWN';
    return result(operation, 'VERIFY', operation.reconciliation ? 'RECONCILIATION_REQUIRED' : 'FAILED', 'FIRST_MANAGED_BINDING_NOT_VERIFIED');
  }

  return Object.freeze({
    verifyFirstBinding(originalInput: FirstManagedBindingInput, signal: AbortSignal): Promise<FirstManagedBindingResult> {
      const { scope, pinId, ownerToken, hash, leafId } = captureCall(originalInput);
      if (leafId !== profile.leafId || !signal || typeof signal.addEventListener !== 'function') {
        throw new FirstManagedBindingOwnerError('FIRST_MANAGED_INPUT_SCOPE');
      }
      const existing = operations.get(pinId);
      if (existing) {
        if (existing.tokenHash !== hash) throw new FirstManagedBindingOwnerError('FIRST_MANAGED_OWNER_MISMATCH');
        return Promise.resolve(result(existing, 'HOLD', 'RECONCILIATION_REQUIRED', 'FIRST_MANAGED_PIN_ALREADY_ATTEMPTED'));
      }
      const operation: Operation = { holdInput: Object.freeze({ ...profile.profile, digest: accepted.digest,
        actorId: scope.actorId, pinId, ownerToken }), scope, tokenHash: hash,
        hold: null, audit: null, binding: null, release: null, observationRef: null, evidenceRef: null,
        pinState: 'NOT_ACQUIRED', handedOff: false, releaseEligible: false, releaseAttempted: false, reconciliation: false,
        preparedOwner: null, retainedLease: null };
      operations.set(pinId, operation);
      return run(operation, leafId, signal);
    },
    async releaseFailedPreparation(originalInput: Readonly<{ pinId: string; ownerToken: string }>): Promise<FirstManagedBindingResult> {
      let pinId: string, hash: string;
      try { pinId = logicalId('storage-namespace-pin', originalInput.pinId); hash = tokenHash(originalInput.ownerToken); }
      catch { throw new FirstManagedBindingOwnerError('FIRST_MANAGED_INPUT_INVALID'); }
      const operation = operations.get(pinId);
      if (!operation || operation.tokenHash !== hash) throw new FirstManagedBindingOwnerError('FIRST_MANAGED_OWNER_MISMATCH');
      if (!operation.releaseEligible || operation.handedOff || operation.releaseAttempted || operation.pinState !== 'HELD') {
        return result(operation, 'RELEASE', 'RECONCILIATION_REQUIRED', 'FIRST_MANAGED_RELEASE_NOT_ELIGIBLE');
      }
      try { await releaseOwned(operation); }
      catch { return result(operation, 'RELEASE', 'RECONCILIATION_REQUIRED', 'FIRST_MANAGED_RELEASE_NOT_CONFIRMED'); }
      return result(operation, 'RELEASE', operation.reconciliation ? 'RECONCILIATION_REQUIRED' : 'FAILED');
    },
  });
}
