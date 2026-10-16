import type { AuthenticatedManagedLeafObservation } from './managed-leaf-collector-types.ts';
import { FirstManagedBindingOwnerError, type FirstManagedBindingProfileRecord } from './first-managed-binding-owner-profile.ts';

export function requireFirstManagedObservation(profile: FirstManagedBindingProfileRecord,
  observation: AuthenticatedManagedLeafObservation, leafId: string): void {
  const candidate = observation.candidate, storage = observation.storage;
  if (observation.kind !== 'AUTHENTICATED_MANAGED_LEAF_OBSERVATION' || observation.namespacePin !== false ||
      observation.dataset !== profile.profile.datasetName || observation.leafId !== leafId ||
      observation.clusterIdentityRef !== profile.collector.clusterIdentityRef || observation.namespace !== profile.collector.namespace ||
      observation.reference !== `managed-leaf-observation:sha256:${observation.evidenceDigest}` ||
      !/^[a-f0-9]{64}$/u.test(observation.evidenceDigest) ||
      candidate.canonicalDirectory !== `/${profile.profile.datasetName}/${leafId}` ||
      candidate.domain.backendId !== profile.profile.backendId || candidate.domain.exportId !== profile.profile.exportId ||
      candidate.domain.pvUid !== profile.storage.pvUid ||
      storage.pvc.name !== profile.storage.pvcName || storage.pvc.uid !== profile.storage.pvcUid ||
      storage.pv.name !== profile.storage.pvName || storage.pv.uid !== profile.storage.pvUid ||
      storage.pv.csiDriver !== profile.storage.csiDriver || storage.pv.volumeHandle !== profile.storage.volumeHandle ||
      storage.helper.name !== profile.collector.helperConfigMapName || storage.helper.uid !== profile.collector.helperConfigMapUid ||
      storage.helper.sha256 !== profile.collector.helperSha256) {
    throw new FirstManagedBindingOwnerError('FIRST_MANAGED_OBSERVATION_SCOPE');
  }
}
