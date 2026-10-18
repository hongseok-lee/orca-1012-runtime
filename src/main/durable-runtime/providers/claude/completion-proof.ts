import type { ProviderCompletedProof } from '../../input/observation-types.ts'
import type { ProviderRef } from '../../runtime/runtime-evidence.ts'
import type { ProviderSubmissionIdentity, ReadyProviderBinding } from '../shared/contracts.ts'
import { immutableSnapshot } from '../shared/recovery-renderer.ts'

/** Completion of one admitted request, from its exact native result frame. */
export function claudeCompletedProof(binding: ReadyProviderBinding, identity: ProviderSubmissionIdentity, providerRef: ProviderRef,
  resultUuid: string, observedAt: string): ProviderCompletedProof {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the caller matched this result to the admitted request on its own session/connection.
  return immutableSnapshot({ kind: 'PROVIDER_TARGET_COMPLETED', source: 'PROVIDER_PROTOCOL',
    evidenceRef: `claude-result:${binding.connectionInstanceId}:${resultUuid}`, observedAt, attemptId: binding.attemptId,
    podUid: binding.podUid, executionEpoch: binding.executionEpoch, messageId: identity.messageId,
    deliveryAttemptId: identity.deliveryAttemptId, providerRef }) as ProviderCompletedProof
}
