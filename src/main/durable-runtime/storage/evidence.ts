import type { ComputeStoppedProof, PodUid, NodeUid, Incarnation, RuntimeReference } from '../runtime/runtime-evidence.ts';
import type { AttemptId, ExecutionEpoch } from '../../../shared/durable-runtime/identity.ts';
import type { CanonicalCandidate } from './canonical.ts';

declare const directoryEvidenceBrand: unique symbol;
declare const mountEvidenceBrand: unique symbol;
declare const stopEvidenceBrand: unique symbol;
export interface VerifiedDirectoryEvidence {
  readonly [directoryEvidenceBrand]: true;
  readonly evidenceRef: string;
  readonly topologyPinId: string;
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
// External collection/authentication/pinning finishes BEFORE entering a DB tx.
// This accessor reads only immutable prepared local evidence; it cannot return a
// Promise or perform cloud, K8s, filesystem or network I/O. Proof refs identify the
// immutable original observation, never a mutable latest alias. The owner keeps
// its topology/lifetime pin live until tx completion and releases it outside tx.
// Actual authenticated verifier/pin implementations are not supplied. Fixture
// evidence belongs only to tests and cannot qualify production fencing.
export interface StorageEvidenceAuthority {
  directory(reference: string): VerifiedDirectoryEvidence | null;
  directoryPinValid(held: VerifiedDirectoryEvidence): boolean;
  mount(reference: string): VerifiedMountEvidence | null;
  mountPinValid(held: VerifiedMountEvidence): boolean;
  executionTarget(attemptId: AttemptId, podUid: string, incarnation: string, epoch: string): ExecutionTarget | null;
  executionTargetPinValid(held: ExecutionTarget): boolean;
  permanentComputeStop(reference: string): VerifiedPermanentComputeStop | null;
  computeStopPinValid(held: VerifiedPermanentComputeStop): boolean;
}
