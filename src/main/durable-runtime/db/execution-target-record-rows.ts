import type { AttemptId, ExecutionEpoch, RuntimeUnitId } from '../../../shared/durable-runtime/identity.ts'
import type { EvidenceRef, Incarnation, NodeUid, PayloadHash, PodUid, RuntimeReference } from '../runtime/runtime-evidence.ts'

// PostgreSQL projection, not a verified workload identity or physical stop proof.
export type ExecutionTargetRecordRow = {
  attempt_id: AttemptId
  runtime_unit_id: RuntimeUnitId
  execution_epoch: ExecutionEpoch
  pod_uid: PodUid
  incarnation: Incarnation
  cluster_identity_ref: RuntimeReference<'cluster-identity'>
  namespace: string
  pod_name: string
  pod_resource_version: string
  node_name: string
  node_uid: NodeUid
  node_resource_version: string
  project_id: string
  project_number: string
  zone: string
  instance_name: string
  numeric_instance_id: string
  compute_identity_ref: RuntimeReference<'compute-identity'>
  observed_at: Date
  kubernetes_evidence_ref: EvidenceRef
  compute_identity_evidence_ref: EvidenceRef
  observation_digest: PayloadHash
  recorded_at: Date
}
