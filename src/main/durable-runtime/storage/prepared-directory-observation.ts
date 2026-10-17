import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { DurableDatabaseError, runDurableTransaction, type DurableTransactionResult } from '../db/connection.ts';
import { lockAggregates } from '../db/locks.ts';
import { appendAudit } from '../journal/store.ts';
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts';
import type { BindingVerificationInput } from './binding-verification.ts';
import type { AuthenticatedManagedLeafObservation } from './managed-leaf-collector-types.ts';
import type { NamespaceHoldInput } from './namespace-holds.ts';

export type PreparedDirectoryObservationInput = Readonly<{
  hold: NamespaceHoldInput;
  scope: Omit<BindingVerificationInput, 'directoryEvidenceRef'>;
  qualificationRef: string;
  qualificationDigest?: string;
  observation: AuthenticatedManagedLeafObservation;
  evidenceRef: string;
}>;
export type PreparedDirectoryObservationRecord = Readonly<{ auditId: string; evidenceRef: string }>;
type ProfileRow = { dataset_name: string; backend_id: string; export_id: string;
  generation: string; digest: string; state: string };
type HoldRow = { profile_id: string; generation: string; digest: string; owner_token_hash: string; state: string };

function deny(code: string): never { throw new DurableDatabaseError(code); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) { deny('DIRECTORY_OBSERVATION_INPUT'); }
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512 || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    deny('DIRECTORY_OBSERVATION_INPUT');
  }
  return value;
}
function digest(value: unknown): string {
  const result = text(value);
  if (!/^[0-9a-f]{64}$/.test(result)) { deny('DIRECTORY_OBSERVATION_INPUT'); }
  return result;
}
function decimal(value: unknown, positive = false): string {
  const result = text(value);
  if (!(positive ? /^[1-9][0-9]*$/ : /^(0|[1-9][0-9]*)$/).test(result)) { deny('DIRECTORY_OBSERVATION_INPUT'); }
  return result;
}
// Fixed field projection only: no raw response, credential, arbitrary properties,
// toJSON hook, or mutable caller object is retained. This does not authenticate it.
export function captureAuthenticatedManagedLeafObservation(value: unknown): AuthenticatedManagedLeafObservation {
  const raw = record(value), candidate = record(raw.candidate), domain = record(candidate.domain);
  const pod = record(raw.pod), storage = record(raw.storage);
  const pvc = record(storage.pvc), pv = record(storage.pv), helper = record(storage.helper);
  if (raw.kind !== 'AUTHENTICATED_MANAGED_LEAF_OBSERVATION' || raw.namespacePin !== false ||
      typeof pod.restartCount !== 'number' || !Number.isSafeInteger(pod.restartCount) || pod.restartCount < 0) {
    deny('DIRECTORY_OBSERVATION_INPUT');
  }
  const observation: AuthenticatedManagedLeafObservation = Object.freeze({
    kind: 'AUTHENTICATED_MANAGED_LEAF_OBSERVATION', namespacePin: false,
    clusterIdentityRef: text(raw.clusterIdentityRef), namespace: text(raw.namespace), dataset: text(raw.dataset),
    leafId: logicalId('managed-leaf', text(raw.leafId)),
    candidate: Object.freeze({ domain: Object.freeze({ backendId: text(domain.backendId),
      exportId: text(domain.exportId), pvUid: text(domain.pvUid) }),
    canonicalDirectory: text(candidate.canonicalDirectory), podUid: text(candidate.podUid),
    generation: digest(candidate.generation), device: decimal(candidate.device), inode: decimal(candidate.inode, true) }),
    pod: Object.freeze({ name: text(pod.name), uid: text(pod.uid), nodeName: text(pod.nodeName),
      resourceVersion: text(pod.resourceVersion), containerId: text(pod.containerId), imageId: text(pod.imageId),
      restartCount: pod.restartCount, dataVolume: text(pod.dataVolume), helperVolume: text(pod.helperVolume),
      exportsVolume: text(pod.exportsVolume), exportsConfigMapName: text(pod.exportsConfigMapName) }),
    finalPodResourceVersion: text(raw.finalPodResourceVersion),
    storage: Object.freeze({
      pvc: Object.freeze({ name: text(pvc.name), uid: text(pvc.uid), resourceVersion: text(pvc.resourceVersion) }),
      pv: Object.freeze({ name: text(pv.name), uid: text(pv.uid), resourceVersion: text(pv.resourceVersion),
        csiDriver: text(pv.csiDriver), volumeHandle: text(pv.volumeHandle) }),
      helper: Object.freeze({ name: text(helper.name), uid: text(helper.uid), resourceVersion: text(helper.resourceVersion),
        sha256: digest(helper.sha256) }),
    }),
    observedAt: text(raw.observedAt), evidenceDigest: digest(raw.evidenceDigest), reference: text(raw.reference),
  });
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(observation.dataset) ||
      !Number.isFinite(Date.parse(observation.observedAt)) ||
      new Date(observation.observedAt).toISOString() !== observation.observedAt ||
      observation.reference !== `managed-leaf-observation:sha256:${observation.evidenceDigest}` ||
      observation.candidate.podUid !== observation.pod.uid ||
      observation.candidate.domain.pvUid !== observation.storage.pv.uid) { deny('DIRECTORY_OBSERVATION_INPUT'); }
  return observation;
}
function capture(original: PreparedDirectoryObservationInput) {
  try {
    const hold = original.hold, scope = original.scope;
    const token = text(hold.ownerToken);
    if (token.length < 32) { deny('DIRECTORY_OBSERVATION_INPUT'); }
    return Object.freeze({
      hold: Object.freeze({ profileId: logicalId('storage-namespace-profile', hold.profileId),
        datasetName: text(hold.datasetName), backendId: text(hold.backendId), exportId: text(hold.exportId),
        generation: counter('namespace-generation', hold.generation), digest: digest(hold.digest),
        actorId: text(hold.actorId), pinId: logicalId('storage-namespace-pin', hold.pinId) }),
      tokenHash: createHash('sha256').update(token).digest('hex'),
      scope: Object.freeze({ sessionId: logicalId('session', scope.sessionId), unitId: logicalId('runtime-unit', scope.unitId),
        bindingId: logicalId('storage-binding', scope.bindingId),
        expectedUnitRevision: counter('row:runtime-unit', scope.expectedUnitRevision),
        expectedBindingRevision: counter('row:storage-binding', scope.expectedBindingRevision), actorId: text(scope.actorId) }),
      qualificationRef: text(original.qualificationRef), evidenceRef: text(original.evidenceRef),
      ...(original.qualificationDigest === undefined ? {} : { qualificationDigest: digest(original.qualificationDigest) }),
      observation: captureAuthenticatedManagedLeafObservation(original.observation),
    });
  } catch (error) {
    if (error instanceof DurableDatabaseError) { throw error; }
    deny('DIRECTORY_OBSERVATION_INPUT');
  }
}

/** Records the caller's authenticated observation under an already-held namespace
 * pin. No qualification, directory evidence, binding permission or release is issued. */
export function recordPreparedDirectoryObservation(
  pool: Pool, original: PreparedDirectoryObservationInput,
): Promise<DurableTransactionResult<PreparedDirectoryObservationRecord>> {
  const input = capture(original), connect = pool.connect.bind(pool);
  const { hold, observation } = input, candidate = observation.candidate;
  if (observation.dataset !== hold.datasetName || candidate.domain.backendId !== hold.backendId ||
      candidate.domain.exportId !== hold.exportId ||
      candidate.canonicalDirectory !== `/${hold.datasetName}/${observation.leafId}`) { deny('DIRECTORY_OBSERVATION_SCOPE'); }
  const nextState = Object.freeze({ kind: 'STORAGE_DIRECTORY_OBSERVATION_PREPARED',
    profileId: hold.profileId, datasetName: hold.datasetName, backendId: hold.backendId, exportId: hold.exportId,
    generation: hold.generation, digest: hold.digest, pinId: hold.pinId, scope: input.scope,
    observation, qualificationRef: input.qualificationRef, evidenceRef: input.evidenceRef,
    ...(input.qualificationDigest === undefined ? {} : { qualificationDigest: input.qualificationDigest }) });
  const borrowed: Pool = Object.create(pool, { connect: { value: connect } });
  return runDurableTransaction(borrowed, async tx => {
    const query = tx.query.bind(tx);
    await lockAggregates(tx, { storageDomains: [{ backendId: hold.backendId, exportId: hold.exportId }] });
    const profiles = await query<ProfileRow>(`SELECT dataset_name,backend_id,export_id,generation,digest,state
      FROM durable_runtime.storage_namespace_profiles WHERE id=$1 FOR UPDATE`, [hold.profileId]);
    const profile = profiles.rows[0];
    if (!profile || profile.dataset_name !== hold.datasetName || profile.backend_id !== hold.backendId ||
        profile.export_id !== hold.exportId || profile.generation !== hold.generation || profile.digest !== hold.digest) {
      deny('DIRECTORY_OBSERVATION_PROFILE');
    }
    if (profile.state !== 'ACTIVE' && profile.state !== 'DRAINING') { deny('DIRECTORY_OBSERVATION_PROFILE_STATE'); }
    const holds = await query<HoldRow>(`SELECT profile_id,generation,digest,owner_token_hash,state
      FROM durable_runtime.storage_namespace_holds WHERE id=$1 FOR UPDATE`, [hold.pinId]);
    const held = holds.rows[0];
    if (!held || held.profile_id !== hold.profileId || held.generation !== hold.generation || held.digest !== hold.digest ||
        held.owner_token_hash !== input.tokenHash || held.state !== 'HELD') { deny('DIRECTORY_OBSERVATION_HOLD'); }
    const now = new Date();
    // Scope IDs stay in nextState: taking scoped FK locks here would invert the
    // Session/Unit -> domain ordering. The final binding verifier owns that check.
    const auditId = await appendAudit(tx, { actorId: input.scope.actorId, kind: nextState.kind, nextState,
      occurredAt: new Date(observation.observedAt), receivedAt: now,
      producerId: hold.pinId, producerSeq: counter('sequence:producer', '1'),
      evidenceRefs: [observation.reference, input.qualificationRef, input.evidenceRef] });
    return Object.freeze({ auditId, evidenceRef: input.evidenceRef });
  });
}
