import { logicalId } from '../../../shared/durable-runtime/identity.ts';
import { canonicalizeObservation, containsPath, StorageError } from './canonical.ts';
import type { CanonicalCandidate, DirectoryObservation, DomainAuthority } from './canonical.ts';

// Both observations are raw server-namespace inputs, not authenticated evidence or a namespace pin.
export function canonicalizeManagedLeaf(
  observation: DirectoryObservation,
  leafObservation: DirectoryObservation,
  authority: DomainAuthority,
  managed: Readonly<{ dataset: string; leafId: string }>,
): CanonicalCandidate {
  const dataset = managed?.dataset;
  const leafId = managed?.leafId;
  if (typeof dataset !== 'string' ||
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.exec(dataset)?.[0] !== dataset ||
      typeof leafId !== 'string' || leafId.length !== 36) {
    throw new StorageError('MANAGED_DESCRIPTOR_INVALID');
  }
  try {
    logicalId('managed-leaf', leafId);
  } catch {
    throw new StorageError('MANAGED_DESCRIPTOR_INVALID');
  }

  const requested = canonicalizeObservation(observation, authority);
  const leaf = canonicalizeObservation(leafObservation, authority);
  if (leaf.canonicalDirectory !== `/${dataset}/${leafId}`) {
    throw new StorageError('MANAGED_LEAF_MISMATCH');
  }
  if (!containsPath(leaf.canonicalDirectory, requested.canonicalDirectory)) {
    throw new StorageError('MANAGED_LEAF_OUTSIDE');
  }
  if (requested.podUid !== leaf.podUid || requested.generation !== leaf.generation ||
      requested.domain.backendId !== leaf.domain.backendId ||
      requested.domain.exportId !== leaf.domain.exportId || requested.domain.pvUid !== leaf.domain.pvUid) {
    throw new StorageError('OBSERVATION_IDENTITY');
  }
  if (requested.device !== leaf.device ||
      (requested.canonicalDirectory === leaf.canonicalDirectory && requested.inode !== leaf.inode)) {
    throw new StorageError('BACKING_IDENTITY_MISMATCH');
  }
  return leaf;
}
