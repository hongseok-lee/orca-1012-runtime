import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import { inputDigest } from '../runtime/gateway/input.ts'
import { snapshotObservationTarget } from './snapshot.ts'
import type { EpisodeMutationRequest } from './types.ts'

// Captures the values of the existing authenticated scope; does not issue one.
export function snapshotEpisodeRequest<T extends EpisodeMutationRequest>(caller: T): T {
  const authority = Object.freeze({ ...caller.authority })
  const value = Object.freeze({ ...caller, authority, target: snapshotObservationTarget(caller.target) })
  for (const text of [authority.principalId, authority.scope, value.operationKey]) {
    if (typeof text !== 'string' || !text) { throw new DurableDatabaseError('OBSERVATION_INPUT') }
  }
  logicalId('observation-episode', value.episodeId)
  counter('row:observation-episode', value.expectedEpisodeRevision)
  return value
}
export function episodeReceipt(request: EpisodeMutationRequest, method: string, payload: Parameters<typeof inputDigest>[0]) {
  return { key: { principalId: request.authority.principalId, sessionScope: request.authority.scope,
    method, operationKey: request.operationKey }, payloadHash: inputDigest(payload) }
}
