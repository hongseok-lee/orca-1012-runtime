import { createHash, randomUUID } from 'node:crypto';
import { fixture, config, pod, pvc, pv, helper, rawOutput, finish, leafId, reviewerToken } from './managed-leaf-collector-fixtures.mts';
import type { FirstManagedBindingOwnerConfig } from './first-managed-binding-owner.ts';
import type { FirstManagedBindingProfileRecord } from './first-managed-binding-owner-profile.ts';

/** Entirely synthetic qualification/config/credential bytes. Never use this
 * record as a live Root acceptance or a filesystem qualification. */
export function firstManagedFixture() {
  const c = config();
  Object.assign(c, { dataset: 'orca-1012-dev-v1', backendId: `fixture-first-managed:${randomUUID()}`,
    exportId: `fixture-first-export:${randomUUID()}` });
  const serviceAccountName = 'fixture-collector', serviceAccountUid = randomUUID();
  const subject = `system:serviceaccount:${c.namespace}:${serviceAccountName}`;
  const payload = { sub: subject, exp: Math.floor(Date.now() / 1000) + 600,
    'kubernetes.io': { serviceaccount: { uid: serviceAccountUid } } };
  const issued = `${Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${Buffer.from('fixture-signature').toString('base64url')}`;
  const tokenResponse = { apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest',
    metadata: { name: serviceAccountName, namespace: c.namespace, uid: serviceAccountUid },
    status: { token: issued, expirationTimestamp: new Date(Date.now() + 600000).toISOString() } };
  const wire = fixture([{ status: 201, body: tokenResponse }, { body: pod(c) }, { body: pvc(c) },
    { body: pv(c) }, { body: helper(c) }, { body: pod(c) }], socket => finish(socket, rawOutput(c)));
  Object.assign(wire.configuration, c);
  const reference = (kind: string) => [{ reference: `fixture-only:${kind}:${randomUUID()}`,
    sha256: createHash('sha256').update(kind).digest('hex') }];
  const record: FirstManagedBindingProfileRecord = {
    schemaVersion: 1, qualificationRef: `fixture-only:first-managed-qualification:${randomUUID()}`,
    profile: { profileId: randomUUID(), datasetName: c.dataset, backendId: c.backendId, exportId: c.exportId, generation: '0' },
    leafId, apiOrigin: c.apiOrigin, caSha256: createHash('sha256').update(c.ca).digest('hex'),
    credential: { serviceAccountName, serviceAccountUid },
    storage: { pvcName: c.pvcName, pvcUid: c.pvcUid, pvName: c.pvName, pvUid: c.pvUid,
      csiDriver: c.csiDriver, volumeHandle: c.volumeHandle },
    collector: { clusterIdentityRef: c.clusterIdentityRef, namespace: c.namespace, containerName: c.containerName,
      imageDigest: c.imageDigest, helperConfigMapName: c.helperConfigMapName, helperConfigMapUid: c.helperConfigMapUid,
      helperSha256: c.helperSha256, exportsSha256: c.exportsSha256 },
    references: { policies: reference('policies'), permissions: reference('permissions'),
      accessChecks: reference('access'), settledMutations: reference('mutation-termination') },
  };
  const bytes = Buffer.from(JSON.stringify(record));
  const credential = { apiOrigin: c.apiOrigin, ca: Buffer.from(c.ca), namespace: c.namespace,
    serviceAccountName, serviceAccountUid, timeoutMs: 5000,
    readIssuerBearer() { return reviewerToken; } };
  const settings: FirstManagedBindingOwnerConfig = { acceptedProfileBytes: bytes,
    expectedProfileDigest: createHash('sha256').update(bytes).digest('hex'), credential, collector: wire.configuration };
  return { wire, settings, record, bytes, issued, reviewerToken, leafId };
}
