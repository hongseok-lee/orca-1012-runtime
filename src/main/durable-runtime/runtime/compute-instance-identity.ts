import {
  computeInstancePath, snapshotComputeIdentityConfiguration, snapshotComputeIdentityInput
} from './compute-instance-identity-input'
import { readComputeInstanceIdentity } from './compute-instance-identity-transport'
import type {
  ComputeInstanceIdentityClient, ComputeInstanceIdentityConfiguration, ComputeInstanceIdentityInput,
  ComputeInstanceIdentityResult
} from './compute-instance-identity-types'
import { identityFailure } from './compute-instance-identity-types'

export type {
  ComputeInstanceIdentityClient, ComputeInstanceIdentityConfiguration, ComputeInstanceIdentityInput,
  ComputeInstanceIdentityResult, ComputeInstanceIdentityObservation, ComputeInstanceIdentityErrorCode
} from './compute-instance-identity-types'

/** Only trusted server composition owns project, credential supplier and optional fixture seam. */
export function createComputeInstanceIdentityClient(
  config: ComputeInstanceIdentityConfiguration
): ComputeInstanceIdentityClient {
  const captured = snapshotComputeIdentityConfiguration(config)
  return Object.freeze({
    async observe(input: ComputeInstanceIdentityInput, signal?: AbortSignal):
      Promise<ComputeInstanceIdentityResult> {
      if (signal?.aborted) {
        return identityFailure('ABORTED')
      }
      if (!captured) {
        return identityFailure('INVALID_CONFIGURATION')
      }
      const copied = snapshotComputeIdentityInput(input)
      if (!copied) {
        return identityFailure('INVALID_INPUT')
      }
      // Capture all fields and the exact path synchronously before token/request await.
      const path = `/${computeInstancePath(captured.projectId, copied)}`
      return readComputeInstanceIdentity(captured, copied, path, signal)
    }
  })
}
