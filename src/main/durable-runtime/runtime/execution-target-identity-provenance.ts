import { createHash } from 'node:crypto'
import type { ComputeCreationScope } from './compute-creation-identity-types.ts'

/** Identity observations carry no physical-stop or storage-revocation authority. */
export type ExecutionTargetIdentityObservation = Readonly<{
  kind: 'AUTHENTICATED_KUBERNETES_NODE' | 'CLOUD_AUDIT_CREATION_COMPLETED'
  evidenceDigest: string
}>
export type ExecutionTargetIdentityProvenance = ExecutionTargetIdentityObservation['kind'] |
  'LEGACY_SYNTHETIC_NODE_IDENTITY' | 'LEGACY_AMBIGUOUS' | 'UNCLASSIFIED'

export function identityEvidenceRef(value: ExecutionTargetIdentityObservation): string {
  const prefix = value.kind === 'AUTHENTICATED_KUBERNETES_NODE'
    ? 'kubernetes-node-identity' : 'compute-creation-cloud-audit-v1'
  return `${prefix}:sha256:${value.evidenceDigest}`
}

/** Exact fingerprint emitted by the retired nodeIdentityCreationObserver.
 * This identifies its synthetic format, not a recovered Google audit receipt. */
export function legacyNodeIdentityDigest(scope: Pick<ComputeCreationScope,
  'projectNumber' | 'zone' | 'instanceName' | 'numericInstanceId'>): string {
  return createHash('sha256').update(JSON.stringify(['node-identity', scope.projectNumber,
    scope.zone, scope.instanceName, scope.numericInstanceId])).digest('hex')
}

/** Read-time classification preserves the immutable original ref and digest.
 * Old audit-prefixed hashes lack their source receipts: nonmatching hashes are
 * ambiguous, even if they may originally have come from the genuine parser. */
export function executionTargetIdentityProvenance(value: Pick<ComputeCreationScope,
  'projectNumber' | 'zone' | 'instanceName' | 'numericInstanceId'> & Readonly<{
    computeIdentityEvidenceRef: string; kubernetesEvidenceRef: string
  }>): ExecutionTargetIdentityProvenance {
  const ref = value.computeIdentityEvidenceRef
  const node = /^kubernetes-node-identity:sha256:([0-9a-f]{64})$/.exec(ref)
  if (node && value.kubernetesEvidenceRef === `kubernetes-pod-auth:sha256:${node[1]}`) {
    return 'AUTHENTICATED_KUBERNETES_NODE'
  }
  if (/^compute-creation-cloud-audit-v1:sha256:[0-9a-f]{64}$/.test(ref)) {
    return 'CLOUD_AUDIT_CREATION_COMPLETED'
  }
  if (/^compute-creation-audit:sha256:[0-9a-f]{64}$/.test(ref)) {
    return ref === `compute-creation-audit:sha256:${legacyNodeIdentityDigest(value)}`
      ? 'LEGACY_SYNTHETIC_NODE_IDENTITY' : 'LEGACY_AMBIGUOUS'
  }
  return 'UNCLASSIFIED'
}
