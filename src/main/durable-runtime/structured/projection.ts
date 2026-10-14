import type { AgentJournalCursor, AgentJournalDispatchState } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationResult, AgentSessionCancelResult,
  AgentSessionHistoryRequest, AgentSessionHistoryPage, AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import type { ProviderAdmissionProof } from '../runtime/runtime-evidence.ts'
import { structuredCounterToNumber, structuredFenceToNumber } from './counters.ts'
import type { SessionFence } from '../../../shared/durable-runtime/identity.ts'
import { snapshotStructuredJson, StructuredPreparationError } from './snapshot.ts'
import { JournalCursor } from '../../../shared/rpc-contract/structured-agent-session-params'

declare const projectionBrand: unique symbol
declare const committedBrand: unique symbol
declare const cancellationBrand: unique symbol

/** The upper PG/native mapper verifies the original tuple. No string-to-evidence factory. */
export type VerifiedStructuredSubmissionFacts = Readonly<{
  [projectionBrand]: true
  state: 'PENDING' | 'ACCEPTED' | 'UNKNOWN' | 'REJECTED'
  original: Pick<ProviderAdmissionProof, 'messageId' | 'deliveryAttemptId' | 'attemptId' | 'podUid' | 'executionEpoch'>
  nativeAdmission: ProviderAdmissionProof | null
}>

export function projectStructuredDispatchState(facts: VerifiedStructuredSubmissionFacts): AgentJournalDispatchState {
  const state = snapshotStructuredJson(facts) as unknown as VerifiedStructuredSubmissionFacts
  switch (state.state) {
    case 'PENDING': return 'pending'
    case 'UNKNOWN': return 'unknown'
    case 'REJECTED': return 'rejected'
    case 'ACCEPTED': {
      const proof = state.nativeAdmission
      if (!proof || proof.kind !== 'PROVIDER_ADMISSION' ||
        (proof.source !== 'PROVIDER_PROTOCOL' && proof.source !== 'PROVIDER_NATIVE_RECORD') ||
        !proof.evidenceRef || !proof.providerRef.nativeSessionRef ||
        proof.messageId !== state.original.messageId ||
        proof.deliveryAttemptId !== state.original.deliveryAttemptId ||
        proof.attemptId !== state.original.attemptId ||
        proof.podUid !== state.original.podUid ||
        proof.executionEpoch !== state.original.executionEpoch) {
        throw new StructuredPreparationError('STRUCTURED_ADMISSION_UNVERIFIED')
      }
      return 'accepted'
    }
    default: throw new StructuredPreparationError('STRUCTURED_PROJECTION_UNVERIFIED')
  }
}

/** Upper observed COMMIT only; transaction-local return values cannot construct this brand. */
export type CommittedStructuredMutation<TValue> = Readonly<{
  [committedBrand]: true
  replayed: boolean
  fence: SessionFence
  epoch: string
  sequence: string
  value: TValue
}>

export function projectStructuredMutationResult<TValue>(
  committed: CommittedStructuredMutation<TValue>
): AgentSessionMutationResult<TValue> {
  // The generic wire value must also be JSON; Date/getters cannot cross this snapshot.
  const snapshot = snapshotStructuredJson(committed) as unknown as CommittedStructuredMutation<TValue>
  const cursor: AgentJournalCursor = Object.freeze(JournalCursor.parse({
    epoch: snapshot.epoch, sequence: structuredCounterToNumber(snapshot.sequence)
  }))
  return Object.freeze({
    ok: true, replayed: snapshot.replayed, fence: structuredFenceToNumber(snapshot.fence),
    cursor, value: snapshot.value
  })
}

export type VerifiedStructuredCancellation = Readonly<{
  [cancellationBrand]: true
  requestedTurnId: string
  observedTurnId: string | null
  outcome: 'REQUESTED' | 'UNKNOWN' | 'CONFIRMED' | 'ALREADY_SETTLED'
  confirmedScope: 'root-turn' | 'background-task'
}>

export function projectStructuredCancellation(
  facts: VerifiedStructuredCancellation,
  requestedScope: 'root-turn' | 'background-task'
): AgentSessionCancelResult {
  const snapshot = snapshotStructuredJson(facts) as unknown as VerifiedStructuredCancellation
  if (snapshot.confirmedScope !== requestedScope ||
    (snapshot.observedTurnId !== null && snapshot.observedTurnId !== snapshot.requestedTurnId)) {
    throw new StructuredPreparationError('STRUCTURED_CANCEL_TARGET_MISMATCH')
  }
  return Object.freeze({
    turnId: snapshot.requestedTurnId,
    cancelled: snapshot.outcome === 'CONFIRMED' && snapshot.observedTurnId === snapshot.requestedTurnId
  })
}

// Existing read wire contracts only. Durable epoch/snapshot/replay construction is not implemented.
export type StructuredHistoryWire = AgentSessionHistoryRequest
export type StructuredHistoryProjection = AgentSessionHistoryPage
export type StructuredSubscriptionProjection = AgentSessionSubscribeEvent
