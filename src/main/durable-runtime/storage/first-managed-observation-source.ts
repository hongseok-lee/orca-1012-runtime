import { createManagedLeafCredentialReader, type ManagedLeafCredentialConfig } from './managed-leaf-credential.ts';
import { createManagedLeafCollector } from './managed-leaf-collector.ts';
import { createManagedLeafPinHolder } from './managed-leaf-pin.ts';
import { captureManagedLeafConfig } from './managed-leaf-collector-config.ts';
import type { ManagedLeafCollectorConfig, ManagedLeafCollectorDependencies } from './managed-leaf-collector-types.ts';
import { type captureFirstManagedBindingProfile, requireProfileCollectorIdentity } from './first-managed-binding-owner-profile.ts';

export type FirstManagedBindingOwnerConfig = Readonly<{
  acceptedProfileBytes: Uint8Array;
  expectedProfileDigest: string;
  credential: ManagedLeafCredentialConfig;
  collector: Omit<ManagedLeafCollectorConfig, 'readReviewerBearer'>;
}>;
/** The same accepted-profile/credential/collector capture as the original owner.
 * No caller observation, collector callback or authority factory is accepted. */
export function createFirstManagedObservationSource(original: FirstManagedBindingOwnerConfig,
  accepted: ReturnType<typeof captureFirstManagedBindingProfile>, dependencies?: ManagedLeafCollectorDependencies) {
  const profile = accepted.record;
  const sourceCredential = original.credential;
  const credential: ManagedLeafCredentialConfig = Object.freeze({ apiOrigin: sourceCredential.apiOrigin,
    ca: Buffer.from(sourceCredential.ca), namespace: sourceCredential.namespace,
    serviceAccountName: sourceCredential.serviceAccountName, serviceAccountUid: sourceCredential.serviceAccountUid,
    timeoutMs: sourceCredential.timeoutMs, readIssuerBearer: sourceCredential.readIssuerBearer.bind(sourceCredential) });
  const reader = createManagedLeafCredentialReader(credential, dependencies?.https);
  const collectorConfig = captureManagedLeafConfig({ ...original.collector, ca: Buffer.from(original.collector.ca),
    readReviewerBearer: reader.readReviewerBearer });
  requireProfileCollectorIdentity(profile, collectorConfig, credential);
  const collector = createManagedLeafCollector(collectorConfig, dependencies);
  const holder = createManagedLeafPinHolder(collectorConfig, dependencies);
  return Object.freeze({ accepted, collect: collector.collect.bind(collector), acquireHeld: holder.acquire.bind(holder) });
}

export { requireFirstManagedObservation } from './first-managed-observation-identity.ts';
