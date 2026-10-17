import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { DurableDatabaseError, DurableTransactionResult } from '../db/connection.ts'
import type { GatewayContext } from '../runtime/gateway/types.ts'
import type { InitialAgentAttemptInput } from '../runtime/initial-agent-attempt.ts'
import { reserveFirstManagedInitialAgentAttemptWithPreparedPins } from '../runtime/initial-agent-attempt-transaction.ts'
import type { InitialAgentAttemptTransactionResult, PreparedInitialAgentPinsOwner,
  PreparedInitialAgentPinsLease } from '../runtime/initial-agent-attempt-transaction.ts'
import { captureInitialAgentAttemptContext } from './initial-agent-directory-context.ts'
import { acquireNamespaceHold, releaseNamespaceHold } from './namespace-holds.ts'
import type { NamespaceHoldInput, NamespaceTransactionResult } from './namespace-holds.ts'
import { ManagedLeafCollectorError } from './managed-leaf-collector.ts'
import type { AuthenticatedManagedLeafObservation, ManagedLeafCollectorDependencies } from './managed-leaf-collector-types.ts'
import { captureFirstManagedBindingProfile, FirstManagedBindingOwnerError } from './first-managed-binding-owner-profile.ts'
import { createFirstManagedObservationSource, requireFirstManagedObservation } from './first-managed-observation-source.ts'
import type { FirstManagedBindingOwnerConfig } from './first-managed-observation-source.ts'
import { recordInitialDirectoryRevalidation } from './initial-directory-revalidation-guard.ts'
import type { InitialDirectoryRevalidationRecord, InitialDirectoryRevalidationGuard } from './initial-directory-revalidation-guard.ts'
import type { StorageEvidenceAuthority, VerifiedDirectoryEvidence } from './evidence.ts'

export type FirstManagedInitialInput = Readonly<{
  sessionId: string; actorId: string; originalAuditId: string; pinId: string; ownerToken: string;
  context: GatewayContext; attempt: InitialAgentAttemptInput;
}>
type SafeReservation = Readonly<{
  database: InitialAgentAttemptTransactionResult['database']; engineError: DurableDatabaseError | null;
  pins: Readonly<{ disposition: 'RELEASED' | 'RETAINED'; reason: string | null; releaseError: DurableDatabaseError | null }>;
}>
export type FirstManagedInitialResult = Readonly<{
  phase: 'HOLD' | 'COLLECT' | 'AUDIT' | 'RESERVATION' | 'RELEASE';
  outcome: 'RESERVED' | 'FAILED' | 'RECONCILIATION_REQUIRED';
  hold: NamespaceTransactionResult | null;
  audit: DurableTransactionResult<InitialDirectoryRevalidationRecord> | null;
  reservation: SafeReservation | null; release: NamespaceTransactionResult | null;
  observation: AuthenticatedManagedLeafObservation | null;
  originalAuditId: string; originalIdentityRef: string | null;
  qualificationRef: string; errorCode: string | null;
  pin: Readonly<{ pinId: string; state: 'NOT_ACQUIRED' | 'PREEXISTING' | 'HELD' | 'RELEASED' | 'UNKNOWN';
    handedOff: boolean; failedPreparationReleaseEligible: boolean }>;
  gate: 'CLOSED'; namespacePin: false; physicalPinIssued: false;
  providerReady: false; writerGrantActivated: false; kubernetesExecutionAuthorized: false;
}>
type Captured = ReturnType<typeof captureCall>
type Operation = {
  call: Captured; holdInput: NamespaceHoldInput; tokenHash: string;
  hold: NamespaceTransactionResult | null; audit: FirstManagedInitialResult['audit'];
  reservation: SafeReservation | null; release: NamespaceTransactionResult | null;
  observation: AuthenticatedManagedLeafObservation | null; evidenceRef: string | null;
  state: FirstManagedInitialResult['pin']['state'];
  handedOff: boolean; releaseEligible: boolean; releaseAttempted: boolean; reconciliation: boolean;
  preparedOwner: PreparedInitialAgentPinsOwner | null; retainedLease: PreparedInitialAgentPinsLease | null;
}
const fail = (code: string): never => { throw new FirstManagedBindingOwnerError(`FIRST_MANAGED_INITIAL_${code}`) }
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512 || [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
    return fail('INPUT')
  }
  return value
}
function tokenHash(value: unknown): string {
  const token = text(value)
  if (token.length < 32) { return fail('TOKEN') }
  return createHash('sha256').update(token).digest('hex')
}
function captureCall(original: FirstManagedInitialInput) {
  try {
    const captured = captureInitialAgentAttemptContext(original.context, original.attempt)
    if (captured.expected.length !== 1) { return fail('EXACT_ONE_BINDING') }
    return Object.freeze({ sessionId: logicalId('session', original.sessionId), actorId: text(original.actorId),
      originalAuditId: logicalId('event', original.originalAuditId), pinId: logicalId('storage-namespace-pin', original.pinId),
      ownerToken: text(original.ownerToken), tokenHash: tokenHash(original.ownerToken),
      context: captured.context, attempt: captured.input })
  } catch { return fail('INPUT') }
}
function confirmed<T>(r: DurableTransactionResult<T>): r is Extract<DurableTransactionResult<T>, { ok: true }> {
  return r.ok && r.settlement === 'COMMITTED' && r.commitOutcome === 'ACKNOWLEDGED'
}
function pinReleased(op: Operation): boolean { return op.state === 'RELEASED' }
function definiteFailure<T>(r: DurableTransactionResult<T>): boolean {
  return !r.ok && r.settlement !== 'UNCONFIRMED' && r.commitOutcome === 'NOT_ATTEMPTED' && !r.cleanupFailed
}

/** Dedicated trusted server composition. The credential reader and collector
 * are the real original path, not caller observations/booleans or a tx callback.
 * Its fresh hold protects this reservation settlement, never later Pod mounts. */
export function createFirstManagedInitialReservationOwner(pool: Pool, original: FirstManagedBindingOwnerConfig,
  dependencies?: ManagedLeafCollectorDependencies) {
  const accepted = captureFirstManagedBindingProfile(original.acceptedProfileBytes, original.expectedProfileDigest)
  const profile = accepted.record, connect = pool.connect.bind(pool)
  const borrowed: Pool = Object.create(pool, { connect: { value: connect, configurable: true } })
  const source = createFirstManagedObservationSource(original, accepted, dependencies)
  const collect = source.collect, acquire = acquireNamespaceHold, release = releaseNamespaceHold
  const operations = new Map<string, Operation>()

  function result(op: Operation, phase: FirstManagedInitialResult['phase'], outcome: FirstManagedInitialResult['outcome'],
    errorCode: string | null = null): FirstManagedInitialResult {
    return Object.freeze({ phase, outcome, hold: op.hold, audit: op.audit, reservation: op.reservation,
      release: op.release, observation: op.observation, originalAuditId: op.call.originalAuditId,
      originalIdentityRef: op.evidenceRef, qualificationRef: profile.qualificationRef, errorCode,
      pin: Object.freeze({ pinId: op.holdInput.pinId, state: op.state, handedOff: op.handedOff,
        failedPreparationReleaseEligible: op.releaseEligible }), gate: 'CLOSED', namespacePin: false,
      physicalPinIssued: false, providerReady: false, writerGrantActivated: false, kubernetesExecutionAuthorized: false })
  }
  async function releaseOwned(op: Operation): Promise<void> {
    if (op.releaseAttempted) { return fail('RELEASE_ALREADY_ATTEMPTED') }
    op.releaseAttempted = true; op.releaseEligible = false
    let released
    try { released = await release(borrowed, op.holdInput) }
    catch { op.state = 'UNKNOWN'; op.reconciliation = true; return fail('RELEASE_ENGINE_REJECTED') }
    op.release = released
    if (confirmed(released.database) && ['RELEASED', 'ALREADY_RELEASED'].includes(released.disposition?.status ?? '')) {
      op.state = 'RELEASED'; op.reconciliation ||= released.database.cleanupFailed
      return
    }
    op.state = definiteFailure(released.database) ? 'HELD' : 'UNKNOWN'; op.reconciliation = true
    return fail('RELEASE_NOT_CONFIRMED')
  }
  async function run(op: Operation, signal: AbortSignal): Promise<FirstManagedInitialResult> {
    try { op.hold = await acquire(borrowed, op.holdInput) }
    catch { op.state = 'UNKNOWN'; op.reconciliation = true; return result(op, 'HOLD', 'RECONCILIATION_REQUIRED', 'FIRST_MANAGED_INITIAL_HOLD_ENGINE_REJECTED') }
    const acquired = op.hold
    if (!confirmed(acquired.database) || acquired.disposition?.status !== 'ACQUIRED' || acquired.database.cleanupFailed) {
      op.state = confirmed(acquired.database) && acquired.disposition?.status === 'ACQUIRED' ? 'HELD' :
        acquired.disposition?.status === 'ALREADY_HELD' || acquired.disposition?.status === 'ALREADY_RELEASED' ? 'PREEXISTING' :
          definiteFailure(acquired.database) ? 'NOT_ACQUIRED' : 'UNKNOWN'
      op.reconciliation = true
      return result(op, 'HOLD', 'RECONCILIATION_REQUIRED', 'FIRST_MANAGED_INITIAL_HOLD_NOT_NEW')
    }
    op.state = 'HELD'
    try {
      op.observation = await collect(profile.leafId, signal)
      requireFirstManagedObservation(profile, op.observation, profile.leafId)
    } catch (error) {
      op.releaseEligible = error instanceof ManagedLeafCollectorError || error instanceof FirstManagedBindingOwnerError
      op.reconciliation = !op.releaseEligible
      return result(op, 'COLLECT', op.reconciliation ? 'RECONCILIATION_REQUIRED' : 'FAILED',
        error instanceof ManagedLeafCollectorError || error instanceof FirstManagedBindingOwnerError ? error.code : 'FIRST_MANAGED_INITIAL_COLLECTOR_REJECTED')
    }
    try { op.audit = await recordInitialDirectoryRevalidation(borrowed, { accepted, hold: op.holdInput,
      sessionId: op.call.sessionId, actorId: op.call.actorId, context: op.call.context, attempt: op.call.attempt,
      originalAuditId: op.call.originalAuditId, observation: op.observation }) }
    catch { op.reconciliation = true; return result(op, 'AUDIT', 'RECONCILIATION_REQUIRED', 'FIRST_MANAGED_INITIAL_AUDIT_ENGINE_REJECTED') }
    if (!confirmed(op.audit) || op.audit.cleanupFailed) {
      op.releaseEligible = definiteFailure(op.audit); op.reconciliation = !op.releaseEligible
      return result(op, 'AUDIT', op.reconciliation ? 'RECONCILIATION_REQUIRED' : 'FAILED', 'FIRST_MANAGED_INITIAL_AUDIT_NOT_CONFIRMED')
    }
    const receipt = op.audit.value
    if (receipt.originalAuditId !== op.call.originalAuditId || receipt.pinId !== op.holdInput.pinId || !receipt.auditId) {
      op.reconciliation = true
      return result(op, 'AUDIT', 'RECONCILIATION_REQUIRED', 'FIRST_MANAGED_INITIAL_AUDIT_SCOPE')
    }
    op.evidenceRef = receipt.evidenceRef
    // Only the accepted config + new ACQUIRED/ACK hold + real authenticated
    // observation + full original tuple + confirmed dedicated audit reaches here.
    const candidate = Object.freeze({ ...receipt.originalCandidate, domain: Object.freeze({ ...receipt.originalCandidate.domain }) })
    const evidence = Object.freeze({ evidenceRef: receipt.evidenceRef, topologyPinId: op.holdInput.pinId, candidate }) as VerifiedDirectoryEvidence
    const authority: StorageEvidenceAuthority = Object.freeze({
      directory: (ref: string) => ref === evidence.evidenceRef && op.state === 'HELD' ? evidence : null,
      directoryPinValid: (held: VerifiedDirectoryEvidence) => held === evidence && op.state === 'HELD',
      mount: () => null, mountPinValid: () => false, executionTarget: () => null, executionTargetPinValid: () => false,
      permanentComputeStop: () => null, computeStopPinValid: () => false,
    })
    const prepared: PreparedInitialAgentPinsOwner = Object.freeze({ takePreparedPins(group: readonly VerifiedDirectoryEvidence[]) {
      if (group.length !== 1 || group[0] !== evidence || op.handedOff || op.state !== 'HELD') { return fail('EXCLUSIVE_HANDOFF') }
      const lease = Object.freeze({ evidence: Object.freeze([evidence]), release: () => releaseOwned(op) })
      op.handedOff = true
      return lease
    } })
    op.preparedOwner = prepared
    const guard: InitialDirectoryRevalidationGuard = Object.freeze({ ...receipt, accepted, ownerTokenHash: op.tokenHash })
    let reservation
    try { reservation = await reserveFirstManagedInitialAgentAttemptWithPreparedPins(borrowed,
      op.call.context, op.call.attempt, authority, receipt.evidenceRef, prepared, guard) }
    catch { op.reconciliation = true; return result(op, 'RESERVATION', 'RECONCILIATION_REQUIRED', 'FIRST_MANAGED_INITIAL_RESERVATION_REJECTED') }
    op.reservation = Object.freeze({ database: reservation.database, engineError: reservation.engineError,
      pins: Object.freeze({ disposition: reservation.pins.disposition,
        reason: reservation.pins.disposition === 'RETAINED' ? reservation.pins.reason : null,
        releaseError: reservation.pins.releaseError }) })
    if (reservation.pins.disposition === 'RETAINED') {
      op.preparedOwner = reservation.pins.retainedOwner; op.retainedLease = reservation.pins.retainedLease
    } else { op.preparedOwner = null; op.retainedLease = null }
    const db = reservation.database
    if (db && confirmed(db) && !db.cleanupFailed && db.value.disposition === 'RESERVED' &&
        reservation.pins.disposition === 'RELEASED' && pinReleased(op) && !op.reconciliation) {
      return result(op, 'RESERVATION', 'RESERVED')
    }
    op.reconciliation ||= reservation.pins.disposition === 'RETAINED' || reservation.engineError !== null || db === null ||
      db.cleanupFailed || db.settlement === 'UNCONFIRMED' || db.commitOutcome === 'UNKNOWN'
    return result(op, 'RESERVATION', op.reconciliation ? 'RECONCILIATION_REQUIRED' : 'FAILED', 'FIRST_MANAGED_INITIAL_NOT_RESERVED')
  }
  return Object.freeze({
    reserveInitialAttempt(originalInput: FirstManagedInitialInput, signal: AbortSignal): Promise<FirstManagedInitialResult> {
      const call = captureCall(originalInput)
      if (!signal || typeof signal.addEventListener !== 'function') { return fail('SIGNAL') }
      const old = operations.get(call.pinId)
      if (old) {
        if (old.tokenHash !== call.tokenHash) { return fail('OWNER_MISMATCH') }
        return Promise.resolve(result(old, 'HOLD', 'RECONCILIATION_REQUIRED', 'FIRST_MANAGED_INITIAL_ALREADY_ATTEMPTED'))
      }
      const op: Operation = { call, holdInput: Object.freeze({ ...profile.profile, digest: accepted.namespaceDigest,
        actorId: call.actorId, pinId: call.pinId, ownerToken: call.ownerToken }), tokenHash: call.tokenHash,
        hold: null, audit: null, reservation: null, release: null, observation: null, evidenceRef: null,
        state: 'NOT_ACQUIRED', handedOff: false, releaseEligible: false, releaseAttempted: false,
        reconciliation: false, preparedOwner: null, retainedLease: null }
      operations.set(call.pinId, op)
      return run(op, signal)
    },
    async releaseFailedPreparation(input: Readonly<{ pinId: string; ownerToken: string }>): Promise<FirstManagedInitialResult> {
      let pinId: string, hash: string
      try { pinId = logicalId('storage-namespace-pin', input.pinId); hash = tokenHash(input.ownerToken) }
      catch { return fail('INPUT') }
      const op = operations.get(pinId)
      if (!op || op.tokenHash !== hash) { return fail('OWNER_MISMATCH') }
      if (!op.releaseEligible || op.handedOff || op.releaseAttempted || op.state !== 'HELD') {
        return result(op, 'RELEASE', 'RECONCILIATION_REQUIRED', 'FIRST_MANAGED_INITIAL_RELEASE_NOT_ELIGIBLE')
      }
      try { await releaseOwned(op) }
      catch { return result(op, 'RELEASE', 'RECONCILIATION_REQUIRED', 'FIRST_MANAGED_INITIAL_RELEASE_NOT_CONFIRMED') }
      return result(op, 'RELEASE', op.reconciliation ? 'RECONCILIATION_REQUIRED' : 'FAILED')
    },
  })
}
