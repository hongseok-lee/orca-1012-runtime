import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import type { JsonValue, ReceiptIdentity } from '../db/atomic.ts'
import type { ProducerStream } from '../events/types.ts'
import { canonicalInput, inputDigest } from '../runtime/gateway/input.ts'
import type {
  ObservationAuthority, ObservationLossRequest, ObservationSource, ObservationTarget,
  ObservationRecoveryRequest, PreparedRecoveryRequest, RecoverySnapshot
} from './types.ts'

function text(value: string): void {
  if (typeof value !== 'string' || !value) { throw new DurableDatabaseError('OBSERVATION_INPUT') }
}
function authority(source: ObservationAuthority): Pick<ObservationAuthority, 'principalId' | 'scope'> {
  const result = Object.freeze({ principalId: source.principalId, scope: source.scope })
  text(result.principalId); text(result.scope)
  return result
}
export function snapshotObservationTarget(source: ObservationTarget): ObservationTarget {
  const result = Object.freeze({ runtimeUnitId: source.runtimeUnitId, attemptId: source.attemptId,
    podUid: source.podUid, executionEpoch: source.executionEpoch })
  logicalId('runtime-unit', result.runtimeUnitId); logicalId('attempt', result.attemptId)
  text(result.podUid); counter('execution-epoch', result.executionEpoch)
  return result
}
function stream(source: ProducerStream | null): ProducerStream | null {
  if (source === null) { return null }
  const result = Object.freeze({ producerId: source.producerId, incarnation: source.incarnation })
  logicalId('producer', result.producerId); text(result.incarnation)
  return result
}
function sourceSnapshot(source: ObservationSource): ObservationSource {
  const result = Object.freeze({ kind: source.kind, reference: source.reference,
    stream: stream(source.stream), watermark: source.watermark })
  if (!['K8S_LIST', 'K8S_WATCH', 'TRUSTED_RUNTIME'].includes(result.kind)) {
    throw new DurableDatabaseError('OBSERVATION_INPUT')
  }
  text(result.reference)
  if (result.watermark !== null) { counter('sequence:observation', result.watermark) }
  return result
}
function immutableJson(value: JsonValue): JsonValue {
  const copy: JsonValue = JSON.parse(canonicalInput(value))
  function freeze(item: JsonValue): void {
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) { freeze(child) }
      Object.freeze(item)
    }
  }
  freeze(copy)
  return copy
}
export function snapshotObservationLoss(source: ObservationLossRequest): {
  readonly input: Pick<ObservationLossRequest, 'operationKey' | 'target' | 'source'>
  readonly identity: ReceiptIdentity
} {
  const actor = authority(source.authority)
  const input = Object.freeze({ operationKey: source.operationKey,
    target: snapshotObservationTarget(source.target), source: sourceSnapshot(source.source) })
  text(input.operationKey)
  return Object.freeze({ input, identity: Object.freeze({ key: Object.freeze({ principalId: actor.principalId,
    sessionScope: actor.scope, method: 'observation.record-loss', operationKey: input.operationKey }),
    payloadHash: inputDigest({ target: input.target, source: input.source }) }) })
}
export function snapshotObservationRecovery(source: ObservationRecoveryRequest): PreparedRecoveryRequest {
  const actor = authority(source.authority), operationKey = source.operationKey
  text(operationKey)
  const prepared = source.prepared
  if (!Object.isFrozen(prepared) || !Object.isFrozen(prepared.target)) {
    throw new DurableDatabaseError('OBSERVATION_PREPARATION_REQUIRED')
  }
  const target = snapshotObservationTarget(prepared.target)
  const workload = prepared.workload
  if (workload.attemptId !== target.attemptId || workload.podUid !== target.podUid ||
      workload.executionEpoch !== target.executionEpoch) {
    throw new DurableDatabaseError('OBSERVATION_PREPARED_BINDING')
  }
  logicalId('observation-episode', prepared.episodeId)
  counter('row:observation-episode', prepared.expectedEpisodeRevision)
  text(prepared.challengeId); text(prepared.requestSourceRef); text(prepared.responseSourceRef)
  if (!['RUNNING', 'IDLE', 'WAITING_INPUT'].includes(prepared.state)) {
    throw new DurableDatabaseError('OBSERVATION_PREPARED_STATE')
  }
  if (!(prepared.observedAt instanceof Date) || !Number.isFinite(prepared.observedAt.getTime())) {
    throw new DurableDatabaseError('OBSERVATION_PREPARED_TIME')
  }
  const value: RecoverySnapshot = Object.freeze({ target, episodeId: prepared.episodeId,
    expectedEpisodeRevision: prepared.expectedEpisodeRevision, challengeId: prepared.challengeId,
    requestSourceRef: prepared.requestSourceRef, responseSourceRef: prepared.responseSourceRef,
    state: prepared.state, observedAtISO: prepared.observedAt.toISOString(), stream: stream(prepared.stream),
    watermark: prepared.watermark, body: immutableJson(prepared.body) })
  if (value.watermark !== null) { counter('sequence:observation', value.watermark) }
  if ((value.stream === null) !== (value.watermark === null)) {
    throw new DurableDatabaseError('OBSERVATION_PREPARED_STREAM')
  }
  const payloadHash = inputDigest({ ...value })
  const owner = source.pin, isCurrent = owner.isCurrent.bind(owner)
  const assertCurrentPin = (): void => {
    let current = false
    try { current = isCurrent(prepared, payloadHash) === true } catch { /* Owner failure remains unknown. */ }
    if (!current) { throw new DurableDatabaseError('OBSERVATION_PIN_STALE') }
  }
  return Object.freeze({ authority: actor, operationKey, value,
    identity: Object.freeze({ key: Object.freeze({ principalId: actor.principalId, sessionScope: actor.scope,
      method: 'observation.accept-fresh', operationKey }), payloadHash }), assertCurrentPin })
}
