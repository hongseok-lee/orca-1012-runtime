import { createHash } from 'node:crypto'
import {
  computeCanonicalUrl, computeInstancePath, isComputeNumericInstanceId
} from './compute-instance-identity-input'
import type {
  ComputeInstanceIdentityInput, ComputeInstanceIdentityObservation, ComputeInstanceIdentityResult
} from './compute-instance-identity-types'
import { identityFailure } from './compute-instance-identity-types'

/** Immediately project a parsed 200 response; unknown/sensitive API fields are never copied. */
export function projectComputeInstanceIdentity(
  projectId: string,
  input: ComputeInstanceIdentityInput,
  value: unknown
): ComputeInstanceIdentityResult {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return identityFailure('INVALID_RESPONSE')
    }
    const raw = value as Record<string, unknown>
    const kind = raw.kind
    const name = raw.name
    const id = raw.id
    const zone = raw.zone
    const selfLink = raw.selfLink
    if (typeof kind !== 'string' || typeof name !== 'string' ||
        typeof zone !== 'string' || typeof selfLink !== 'string' || !Object.hasOwn(raw, 'id')) {
      return identityFailure('INVALID_RESPONSE')
    }
    if (kind !== 'compute#instance') {
      return identityFailure('INVALID_INSTANCE_KIND')
    }
    if (!isComputeNumericInstanceId(id)) {
      return identityFailure('INVALID_NUMERIC_ID')
    }
    const zonePath = `compute/v1/projects/${projectId}/zones/${input.zone}`
    if (name !== input.instanceName || !computeCanonicalUrl(zone, zonePath) ||
        !computeCanonicalUrl(selfLink, computeInstancePath(projectId, input))) {
      return identityFailure('IDENTITY_MISMATCH')
    }
    if (id !== input.expectedNumericInstanceId) {
      return identityFailure('INSTANCE_REPLACED')
    }
    const fields = { source: 'COMPUTE_CONTROL_PLANE' as const,
      projectId, zone: input.zone, instanceName: input.instanceName, numericInstanceId: id, selfLink }
    const observation: ComputeInstanceIdentityObservation = Object.freeze({
      status: 'COMPUTE_INSTANCE_IDENTITY_OBSERVED', ...fields,
      evidenceDigest: createHash('sha256').update(JSON.stringify(fields)).digest('hex')
    })
    return Object.freeze({ ok: true, observation })
  } catch {
    return identityFailure('INVALID_RESPONSE')
  }
}
