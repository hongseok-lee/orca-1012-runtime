import type { Pool } from 'pg'
import { DurableDatabaseError, runDurableTransaction, type DurableTransactionResult } from '../db/connection.ts'
import type { StorageEvidenceAuthority, VerifiedDirectoryEvidence } from '../storage/evidence.ts'
import type { GatewayContext } from './gateway/types.ts'
import { reserveInitialAgentAttempt, type InitialAgentAttemptInput, type InitialAgentAttemptReservation } from './initial-agent-attempt.ts'

/** Externally prepared pins only. A lease represents the WHOLE group, including
 * protected RO bindings. This interface does not implement a physical issuer. */
export type PreparedInitialAgentPinsLease = Readonly<{
  evidence: readonly VerifiedDirectoryEvidence[]
  release(): void | Promise<void>
}>
export type PreparedInitialAgentPinsOwner = Readonly<{
  /** Synchronous atomic exclusive transfer. A throw leaves ALL pins here; a
   * success transfers ALL of them to one frozen lease through DB settlement. */
  takePreparedPins(evidence: readonly VerifiedDirectoryEvidence[]): PreparedInitialAgentPinsLease
}>
export type InitialAgentPinsDisposition = Readonly<{
  disposition: 'RELEASED'; releaseError: null; retainedOwner: null; retainedLease: null
}> | Readonly<{
  disposition: 'RETAINED'
  reason: 'TAKE_FAILED' | 'INVALID_HANDOFF' | 'UNCONFIRMED' | 'ENGINE_REJECTED' | 'RELEASE_FAILED'
  releaseError: DurableDatabaseError | null
  retainedOwner: PreparedInitialAgentPinsOwner
  retainedLease: PreparedInitialAgentPinsLease | null
}>
export type InitialAgentAttemptTransactionResult = Readonly<{
  database: DurableTransactionResult<InitialAgentAttemptReservation> | null
  engineError: DurableDatabaseError | null
  pins: InitialAgentPinsDisposition
  kubernetesExecutionAuthorized: false
  physicalPinIssuerImplemented: false
}>

function reference(value: string): string {
  if (typeof value !== 'string' || !value || Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new DurableDatabaseError('INITIAL_AGENT_EVIDENCE_REF')
  }
  return value
}

/** Captures original claim/revisions before checkout and consumes only prepared
 * synchronous evidence. Caller owns pins on pre-handoff rejection. No provider,
 * filesystem, K8s, background retry, grant activation or physical pin issuance. */
export async function reserveInitialAgentAttemptWithPreparedPins(
  pool: Pool, originalContext: GatewayContext, original: InitialAgentAttemptInput,
  authority: StorageEvidenceAuthority, originalReferences: readonly string[], owner: PreparedInitialAgentPinsOwner,
): Promise<InitialAgentAttemptTransactionResult> {
  const context: GatewayContext = Object.freeze({ runtimeUnitId: originalContext.runtimeUnitId,
    operationId: originalContext.operationId, controller: Object.freeze({ ...originalContext.controller }) })
  const supplied = original.claim
  const input: InitialAgentAttemptInput = Object.freeze({ planDigest: original.planDigest,
    expectedUnitRevision: original.expectedUnitRevision,
    bindings: Object.freeze(original.bindings.map(b => Object.freeze({ bindingId: b.bindingId,
      expectedRevision: b.expectedRevision, storageEpoch: b.storageEpoch }))),
    claim: Object.freeze({ visibility: supplied.visibility, commandId: supplied.commandId,
      executorId: supplied.executorId, executionToken: supplied.executionToken, controllerTerm: supplied.controllerTerm,
      identity: Object.freeze({ command: supplied.identity.command, inputHash: supplied.identity.inputHash,
        originalEnvelope: Object.freeze({ ...supplied.identity.originalEnvelope }) }) }) })
  const references = Object.freeze(originalReferences.map(reference))
  if (!Object.isFrozen(authority) || !Object.isFrozen(owner) || new Set(references).size !== references.length) {
    throw new DurableDatabaseError('INITIAL_AGENT_PREPARED_OWNER_REQUIRED')
  }
  const directory = authority.directory.bind(authority), pinValid = authority.directoryPinValid.bind(authority)
  const take = owner.takePreparedPins.bind(owner), connect = pool.connect.bind(pool)
  const prepared = Object.freeze(references.map(ref => {
    let evidence
    try { evidence = directory(ref) } catch { throw new DurableDatabaseError('INITIAL_AGENT_DIRECTORY_UNVERIFIED') }
    if (!evidence || evidence.evidenceRef !== ref || !evidence.topologyPinId ||
        !Object.isFrozen(evidence) || !Object.isFrozen(evidence.candidate) || !Object.isFrozen(evidence.candidate.domain)) {
      throw new DurableDatabaseError('INITIAL_AGENT_DIRECTORY_UNVERIFIED')
    }
    return evidence
  }))
  const byReference = new Map(prepared.map(e => [e.evidenceRef, e])), evidenceSet = new Set(prepared)
  const capturedAuthority: StorageEvidenceAuthority = Object.freeze({
    directory(ref: string) {
      const evidence = byReference.get(ref)
      if (!evidence) { throw new DurableDatabaseError('INITIAL_AGENT_DIRECTORY_UNPREPARED') }
      return evidence
    },
    directoryPinValid: (held: VerifiedDirectoryEvidence) => evidenceSet.has(held) && pinValid(held),
    mount() { return null }, mountPinValid() { return false }, executionTarget() { return null },
    executionTargetPinValid() { return false }, permanentComputeStop() { return null }, computeStopPinValid() { return false },
  })
  // Complete all borrowed-pool setup before transferring any pin ownership.
  const borrowed: Pool = Object.create(pool, { connect: { value: connect } })
  const result = (database: DurableTransactionResult<InitialAgentAttemptReservation> | null,
    engineError: DurableDatabaseError | null, pins: InitialAgentPinsDisposition): InitialAgentAttemptTransactionResult => Object.freeze({
    database, engineError, pins, kubernetesExecutionAuthorized: false, physicalPinIssuerImplemented: false,
  })
  const notStarted = (reason: 'TAKE_FAILED' | 'INVALID_HANDOFF', lease: PreparedInitialAgentPinsLease | null) => result(
    Object.freeze({ ok: false, settlement: 'NOT_STARTED', commitOutcome: 'NOT_ATTEMPTED', cleanupFailed: false,
      error: new DurableDatabaseError(reason === 'TAKE_FAILED' ? 'INITIAL_AGENT_PIN_HANDOFF_FAILED' : 'INITIAL_AGENT_PIN_HANDOFF_INVALID') }),
    null, Object.freeze({ disposition: 'RETAINED', reason, releaseError: null, retainedOwner: owner, retainedLease: lease }))
  let lease: PreparedInitialAgentPinsLease
  try { lease = take(prepared) } catch { return notStarted('TAKE_FAILED', null) }
  let release: unknown
  try {
    if (!lease || !Object.isFrozen(lease)) { return notStarted('INVALID_HANDOFF', lease ?? null) }
    const evidenceProperty = Object.getOwnPropertyDescriptor(lease, 'evidence')
    const releaseProperty = Object.getOwnPropertyDescriptor(lease, 'release')
    if (!evidenceProperty || !('value' in evidenceProperty) || !releaseProperty || !('value' in releaseProperty)) {
      return notStarted('INVALID_HANDOFF', lease)
    }
    const group: unknown = evidenceProperty.value
    if (!Array.isArray(group) || !Object.isFrozen(group) || group.length !== prepared.length) {
      return notStarted('INVALID_HANDOFF', lease)
    }
    const seen = new Set<VerifiedDirectoryEvidence>()
    for (let i = 0; i < group.length; i++) {
      const item = Object.getOwnPropertyDescriptor(group, String(i))
      if (!item || !('value' in item) || !evidenceSet.has(item.value) || seen.has(item.value)) {
        return notStarted('INVALID_HANDOFF', lease)
      }
      seen.add(item.value)
    }
    release = releaseProperty.value
    if (typeof release !== 'function') { return notStarted('INVALID_HANDOFF', lease) }
  } catch { return notStarted('INVALID_HANDOFF', lease ?? null) }
  const retained = (reason: 'UNCONFIRMED' | 'ENGINE_REJECTED' | 'RELEASE_FAILED',
    releaseError: DurableDatabaseError | null = null): InitialAgentPinsDisposition => Object.freeze({
    disposition: 'RETAINED', reason, releaseError, retainedOwner: owner, retainedLease: lease,
  })
  let database: DurableTransactionResult<InitialAgentAttemptReservation>
  try {
    database = await runDurableTransaction(borrowed, tx => reserveInitialAgentAttempt(tx, context, input, capturedAuthority))
  } catch {
    return result(null, new DurableDatabaseError('INITIAL_AGENT_TRANSACTION_ENGINE_REJECTED'), retained('ENGINE_REJECTED'))
  }
  if (database.settlement === 'UNCONFIRMED') { return result(database, null, retained('UNCONFIRMED')) }
  // Only the real engine's NOT_STARTED/COMMITTED/ROLLED_BACK result authorizes
  // this single group-release attempt. Cleanup failure is a separate DB fact.
  try { await Reflect.apply(release, lease, []) } catch {
    return result(database, null, retained('RELEASE_FAILED', new DurableDatabaseError('INITIAL_AGENT_PINS_RELEASE_FAILED')))
  }
  return result(database, null, Object.freeze({ disposition: 'RELEASED', releaseError: null, retainedOwner: null, retainedLease: null }))
}
