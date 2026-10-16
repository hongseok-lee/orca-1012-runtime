import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts';
import { inventoryName, inventoryNamespace, inventoryOpaque } from '../lifecycle/kubernetes-identity.ts';
import type { ManagedLeafCollectorConfig } from './managed-leaf-collector-types.ts';
import { managedLeafUuid } from './managed-leaf-collector-config.ts';

export type FirstManagedBindingReference = Readonly<{ reference: string; sha256: string }>;
/** Deployment input, accepted by Root outside this module. Shape/hash checking
 * does not qualify a filesystem or turn arbitrary references into proof. */
export type FirstManagedBindingProfileRecord = Readonly<{
  schemaVersion: 1;
  qualificationRef: string;
  profile: Readonly<{ profileId: string; datasetName: string; backendId: string; exportId: string; generation: string }>;
  leafId: string;
  apiOrigin: string;
  caSha256: string;
  credential: Readonly<{ serviceAccountName: string; serviceAccountUid: string }>;
  storage: Readonly<{ pvcName: string; pvcUid: string; pvName: string; pvUid: string; csiDriver: string; volumeHandle: string }>;
  collector: Readonly<{ clusterIdentityRef: string; namespace: string; containerName: string;
    imageDigest: string; helperConfigMapName: string; helperConfigMapUid: string;
    helperSha256: string; exportsSha256: string }>;
  references: Readonly<{ policies: readonly FirstManagedBindingReference[];
    permissions: readonly FirstManagedBindingReference[]; accessChecks: readonly FirstManagedBindingReference[];
    settledMutations: readonly FirstManagedBindingReference[] }>;
}>;

export class FirstManagedBindingOwnerError extends Error {
  constructor(readonly code: string) {
    super(`First managed binding operation failed (${code})`);
    this.name = 'FirstManagedBindingOwnerError';
  }
}
function invalid(): never { throw new FirstManagedBindingOwnerError('FIRST_MANAGED_PROFILE_INVALID'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512 || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) invalid();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) invalid();
  return value;
}
function refs(value: unknown): readonly FirstManagedBindingReference[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) invalid();
  return Object.freeze(value.map(raw => {
    const input = record(raw);
    return Object.freeze({ reference: text(input.reference), sha256: digest(input.sha256) });
  }));
}

export function captureFirstManagedBindingProfile(bytes: Uint8Array, expectedDigest: string): Readonly<{
  record: FirstManagedBindingProfileRecord; digest: string;
}> {
  try {
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 131072) invalid();
    const copy = Buffer.from(bytes), hash = digest(expectedDigest);
    if (createHash('sha256').update(copy).digest('hex') !== hash) invalid();
    const input = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(copy)));
    if (input.schemaVersion !== 1) invalid();
    const profile = record(input.profile), storage = record(input.storage), source = record(input.collector);
    const credential = record(input.credential), references = record(input.references);
    const origin = new URL(text(input.apiOrigin));
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') invalid();
    const value: FirstManagedBindingProfileRecord = Object.freeze({
      schemaVersion: 1, qualificationRef: text(input.qualificationRef), leafId: managedLeafUuid(text(input.leafId)),
      apiOrigin: origin.origin, caSha256: digest(input.caSha256),
      profile: Object.freeze({ profileId: logicalId('storage-namespace-profile', text(profile.profileId)),
        datasetName: inventoryNamespace(text(profile.datasetName)), backendId: inventoryOpaque(text(profile.backendId)),
        exportId: inventoryOpaque(text(profile.exportId)), generation: counter('namespace-generation', text(profile.generation)) }),
      credential: Object.freeze({ serviceAccountName: inventoryName(text(credential.serviceAccountName)),
        serviceAccountUid: managedLeafUuid(text(credential.serviceAccountUid)) }),
      storage: Object.freeze({ pvcName: inventoryName(text(storage.pvcName)), pvcUid: inventoryOpaque(text(storage.pvcUid)),
        pvName: inventoryName(text(storage.pvName)), pvUid: inventoryOpaque(text(storage.pvUid)),
        csiDriver: inventoryName(text(storage.csiDriver)), volumeHandle: inventoryOpaque(text(storage.volumeHandle)) }),
      collector: Object.freeze({ clusterIdentityRef: inventoryOpaque(text(source.clusterIdentityRef)),
        namespace: inventoryNamespace(text(source.namespace)), containerName: inventoryNamespace(text(source.containerName)),
        imageDigest: text(source.imageDigest), helperConfigMapName: inventoryName(text(source.helperConfigMapName)),
        helperConfigMapUid: inventoryOpaque(text(source.helperConfigMapUid)), helperSha256: digest(source.helperSha256),
        exportsSha256: digest(source.exportsSha256) }),
      references: Object.freeze({ policies: refs(references.policies), permissions: refs(references.permissions),
        accessChecks: refs(references.accessChecks), settledMutations: refs(references.settledMutations) }),
    });
    if (!/^sha256:[a-f0-9]{64}$/u.test(value.collector.imageDigest)) invalid();
    return Object.freeze({ record: value, digest: hash });
  } catch (error) {
    if (error instanceof FirstManagedBindingOwnerError) throw error;
    return invalid();
  }
}

export function requireProfileCollectorIdentity(profile: FirstManagedBindingProfileRecord,
  collector: ManagedLeafCollectorConfig, credential: Readonly<{
    apiOrigin: string; ca: Uint8Array; namespace: string; serviceAccountName: string; serviceAccountUid: string;
  }>): void {
  const stable = { ...profile.storage, ...profile.collector, dataset: profile.profile.datasetName,
    backendId: profile.profile.backendId, exportId: profile.profile.exportId, apiOrigin: profile.apiOrigin };
  for (const [key, value] of Object.entries(stable)) {
    if (Reflect.get(collector, key) !== value) invalid();
  }
  if (credential.apiOrigin.replace(/\/$/u, '') !== profile.apiOrigin || credential.namespace !== profile.collector.namespace ||
      credential.serviceAccountName !== profile.credential.serviceAccountName || credential.serviceAccountUid !== profile.credential.serviceAccountUid ||
      createHash('sha256').update(collector.ca).digest('hex') !== profile.caSha256 ||
      createHash('sha256').update(credential.ca).digest('hex') !== profile.caSha256) invalid();
}
