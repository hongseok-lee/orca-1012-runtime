import { DurableDatabaseError } from '../db/connection.ts'
import type { UnitIntentRequest } from './types.ts'

// Copy the existing authenticated authority, not an arbitrary string-to-proof
// conversion. This snapshot does not perform or claim new authentication.
export function snapshotIntentRequest(input: UnitIntentRequest): UnitIntentRequest {
  if (!input || !input.authority || !input.policy) {
    throw new DurableDatabaseError('LIFECYCLE_REQUEST')
  }
  const authority = Object.freeze({ ...input.authority })
  const policy = Object.freeze({
    operationDeadlineMs: input.policy.operationDeadlineMs,
    idleDurationMs: input.policy.idleDurationMs
  })
  return Object.freeze({
    authority, policy, operationKey: input.operationKey, desired: input.desired,
    expectedRevision: input.expectedRevision, expectedIntentRevision: input.expectedIntentRevision
  })
}
