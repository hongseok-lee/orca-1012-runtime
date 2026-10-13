import type { ComputeStoppedProof, PodUid, NodeUid, Incarnation, RuntimeReference } from '../runtime/runtime-evidence.ts';
import type { AttemptId, ExecutionEpoch } from '../../../shared/durable-runtime/identity.ts';
import type { CanonicalCandidate } from './canonical.ts';

declare const directoryEvidenceBrand: unique symbol;
declare const mountEvidenceBrand: unique symbol;
declare const stopEvidenceBrand: unique symbol;
export interface VerifiedDirectoryEvidence {
  readonly [directoryEvidenceBrand]: true;
  readonly evidenceRef: string;
  readonly candidate: CanonicalCandidate;
}
export interface ExecutionTarget {
  readonly attemptId: AttemptId; readonly podUid: PodUid; readonly incarnation: Incarnation;
  readonly executionEpoch: ExecutionEpoch; readonly nodeUid: NodeUid;
  readonly computeIdentityRef: RuntimeReference<'compute-identity'>;
  readonly numericInstanceId: string;
}
export interface VerifiedMountEvidence {
  readonly [mountEvidenceBrand]: true;
  readonly evidenceRef: string; readonly directory: CanonicalCandidate;
  readonly target: ExecutionTarget; readonly mode: 'RO' | 'RW';
  // Actual VFS mount observation, not merely a desired Pod spec flag.
  readonly actualReadOnly: boolean;
}
export interface VerifiedPermanentComputeStop {
  readonly [stopEvidenceBrand]: true;
  readonly proof: ComputeStoppedProof;
  readonly numericInstanceId: string;
  // Phase 1 requires a verified no-reentry boundary. STOPPED is insufficient.
  readonly disposition: 'DELETED_NO_REENTRY';
}
// This privileged dependency must be supplied by the authenticated observer / PV
// authority. No production implementation or public string-to-proof constructor
// is supplied here. Null/unavailable results fail closed. Fixture implementations
// live exclusively in tests; injecting one into production is not authentication.
export interface StorageEvidenceAuthority {
  directory(reference: string): Promise<VerifiedDirectoryEvidence | null>;
  revalidateDirectory(held: VerifiedDirectoryEvidence): Promise<VerifiedDirectoryEvidence | null>;
  mount(reference: string): Promise<VerifiedMountEvidence | null>;
  executionTarget(attemptId: AttemptId, podUid: string, incarnation: string, epoch: string): Promise<ExecutionTarget | null>;
  permanentComputeStop(reference: string): Promise<VerifiedPermanentComputeStop | null>;
}
