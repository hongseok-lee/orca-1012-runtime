import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { createDurablePool, withDurableTransaction, type DurableTransactionResult } from '../db/connection.ts';
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts';
import { acquireNamespaceHold, beginNamespaceManagement, claimNamespaceManagement,
  registerNamespaceProfile, releaseNamespaceHold } from './namespace-holds.ts';
import type { NamespaceHoldInput, NamespaceManagementInput, NamespaceTransactionResult } from './namespace-holds.ts';
import { recordPreparedDirectoryObservation } from './prepared-directory-observation.ts';
import type { PreparedDirectoryObservationInput, PreparedDirectoryObservationRecord } from './prepared-directory-observation.ts';
import type { AuthenticatedManagedLeafObservation } from './managed-leaf-collector-types.ts';

// Source-only until Root assigns the existing isolated ledger23 DB/OID.
// Synthetic observation metadata is never a live authenticated collector result.
const database = process.env.ORCA_PREPARED_DIRECTORY_DATABASE;
const oid = process.env.ORCA_PREPARED_DIRECTORY_DATABASE_OID;
if (process.env.ORCA_PREPARED_DIRECTORY_APPROVED !== 'root-first-verification' ||
    !database || !/^orca_[a-z0-9_]+$/.test(database) || database === 'orca_dev' ||
    process.env.PGDATABASE !== database || !oid || !/^[1-9][0-9]*$/.test(oid)) {
  throw new Error('Root-approved existing isolated DB/OID required');
}
const pool = createDurablePool({ database, max: 4, application_name: 'prepared-directory-observation-first',
  connectionTimeoutMillis: 5000, query_timeout: 15000, options: '-c statement_timeout=15000 -c lock_timeout=5000' });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
function committed(result: NamespaceTransactionResult, status: string) {
  assert.equal(result.database.ok, true);
  assert.equal(result.database.settlement, 'COMMITTED');
  assert.equal(result.database.commitOutcome, 'ACKNOWLEDGED');
  assert.equal(result.database.cleanupFailed, false);
  assert.equal(result.disposition?.status, status);
}
function recorded(result: DurableTransactionResult<PreparedDirectoryObservationRecord>) {
  assert.equal(result.ok, true);
  if (!result.ok) { throw new Error('Expected prepared audit COMMIT'); }
  assert.equal(result.settlement, 'COMMITTED');
  assert.equal(result.commitOutcome, 'ACKNOWLEDGED');
  assert.equal(result.cleanupFailed, false);
  assert.ok(Object.isFrozen(result.value));
  return result.value;
}
function failed(result: DurableTransactionResult<PreparedDirectoryObservationRecord>, code: string) {
  assert.equal(result.ok, false);
  if (result.ok) { throw new Error('Expected prepared audit rejection'); }
  assert.equal(result.settlement, 'ROLLED_BACK');
  assert.equal(result.error.code, code);
  assert.equal(result.cleanupFailed, false);
}
async function identity() {
  const client = await pool.connect();
  try {
    const value = (await client.query<{ database: string; oid: string; system: string; backend_pid: number }>(
      `SELECT current_database() AS database,
        (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
        (SELECT system_identifier::text FROM pg_control_system()) AS system,pg_backend_pid() AS backend_pid`)).rows[0];
    assert.equal(value.database, database);
    assert.equal(value.oid, oid);
    assert.equal(value.system, '7696101282789175327');
    assert.deepEqual((await client.query('SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows,
      [{ dataset_name: 'orca-1012-dev-v1' }]);
    return value;
  } finally { client.release(); }
}
const tables = ['dataset_metadata', 'storage_domains', 'storage_bindings', 'storage_write_grants', 'storage_mounts',
  'runtime_member_storage_bindings', 'runtime_units', 'runtime_audit_events', 'outbox_events',
  'storage_namespace_profiles', 'storage_namespace_profile_versions', 'storage_namespace_holds',
  'storage_namespace_management_operations'] as const;
async function originalHashes() {
  const result: Record<string, string[]> = {};
  for (const table of tables) {
    result[table] = (await pool.query<{ body: string }>(
      `SELECT to_jsonb(t)::text AS body FROM durable_runtime.${table} t`)).rows.map(row => hash(row.body)).sort();
  }
  return result;
}
function retained(before: Record<string, string[]>, after: Record<string, string[]>) {
  for (const table of tables) {
    const remaining = new Map<string, number>();
    for (const value of after[table]) { remaining.set(value, (remaining.get(value) ?? 0) + 1); }
    for (const value of before[table]) {
      assert.ok((remaining.get(value) ?? 0) > 0, `Original row lost in ${table}`);
      remaining.set(value, (remaining.get(value) ?? 0) - 1);
    }
  }
}
function input(): PreparedDirectoryObservationInput {
  const hold: NamespaceHoldInput = { profileId: randomUUID(), pinId: randomUUID(),
    ownerToken: `synthetic-prepared-secret:${randomUUID()}`, datasetName: 'orca-1012-dev-v1',
    backendId: 'synthetic-prepared-backend', exportId: `synthetic-prepared:${randomUUID()}`,
    generation: '0', digest: hash(`profile:${randomUUID()}`), actorId: 'synthetic-prepared-actor' };
  const leafId = randomUUID(), podUid = randomUUID(), pvUid = randomUUID(), evidenceDigest = hash(randomUUID());
  const observation: AuthenticatedManagedLeafObservation = {
    kind: 'AUTHENTICATED_MANAGED_LEAF_OBSERVATION', namespacePin: false,
    clusterIdentityRef: 'synthetic-cluster-reference', namespace: 'synthetic-namespace', dataset: hold.datasetName, leafId,
    candidate: { domain: { backendId: hold.backendId, exportId: hold.exportId, pvUid },
      canonicalDirectory: `/${hold.datasetName}/${leafId}`, podUid, generation: hash('synthetic-incarnation'),
      device: '2049', inode: '12345' },
    pod: { name: 'synthetic-nfs', uid: podUid, nodeName: 'synthetic-node', resourceVersion: '11',
      containerId: 'containerd://synthetic-container', imageId: `synthetic-image@sha256:${hash('image')}`,
      restartCount: 0, dataVolume: 'data', helperVolume: 'helper', exportsVolume: 'exports',
      exportsConfigMapName: 'synthetic-exports' },
    finalPodResourceVersion: '12',
    storage: { pvc: { name: 'synthetic-pvc', uid: randomUUID(), resourceVersion: '21' },
      pv: { name: 'synthetic-pv', uid: pvUid, resourceVersion: '22', csiDriver: 'synthetic.csi', volumeHandle: 'synthetic-volume' },
      helper: { name: 'synthetic-helper', uid: randomUUID(), resourceVersion: '23', sha256: hash('helper') } },
    observedAt: '2026-10-16T00:00:00.000Z', evidenceDigest,
    reference: `managed-leaf-observation:sha256:${evidenceDigest}`,
  };
  return { hold, scope: { sessionId: logicalId('session', randomUUID()), unitId: logicalId('runtime-unit', randomUUID()),
    bindingId: logicalId('storage-binding', randomUUID()), expectedUnitRevision: counter('row:runtime-unit', '0'),
    expectedBindingRevision: counter('row:storage-binding', '0'), actorId: hold.actorId }, observation,
  qualificationRef: `synthetic-qualification:${randomUUID()}`, evidenceRef: `synthetic-directory-evidence:${randomUUID()}` };
}
async function seed(value: PreparedDirectoryObservationInput) {
  await withDurableTransaction(pool, tx => tx.query(
    'INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2)', [value.hold.backendId, value.hold.exportId]));
  committed(await registerNamespaceProfile(pool, value.hold), 'REGISTERED');
  committed(await acquireNamespaceHold(pool, value.hold), 'ACQUIRED');
}
function management(value: PreparedDirectoryObservationInput): NamespaceManagementInput {
  return { ...value.hold, operationId: randomUUID(), targetGeneration: '1', targetDigest: hash(randomUUID()) };
}
async function namespaceSnapshot(value: PreparedDirectoryObservationInput) {
  const result = await pool.query(`SELECT
    (SELECT to_jsonb(p) FROM durable_runtime.storage_namespace_profiles p WHERE id=$1) AS profile,
    (SELECT to_jsonb(h) FROM durable_runtime.storage_namespace_holds h WHERE id=$2) AS hold,
    (SELECT jsonb_agg(to_jsonb(v) ORDER BY generation) FROM durable_runtime.storage_namespace_profile_versions v WHERE profile_id=$1) AS versions,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM durable_runtime.outbox_events o WHERE aggregate_id=$1) AS outbox`,
  [value.hold.profileId, value.hold.pinId]);
  return result.rows[0];
}
async function auditCount(pinId: string) {
  return (await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM durable_runtime.runtime_audit_events WHERE producer_id=$1', [pinId])).rows[0].count;
}

await test('Prepared directory observation: held ownership, immutable audit and captured input', async t => {
  const gate = deferred();
  t.after(async () => { gate.resolve(); await pool.end(); });
  const firstIdentity = await identity(); // Same Pool actual DB/system/dataset/OID before seed.
  const ledger = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows;
  assert.equal(ledger.length, 23);
  const originals = await originalHashes();
  const a = input(), b = input(), released = input(), applying = input(), captured = input();
  for (const value of [a, b, released, applying, captured]) { await seed(value); }

  const before = await namespaceSnapshot(a);
  const result = recorded(await recordPreparedDirectoryObservation(pool, a));
  assert.equal(result.evidenceRef, a.evidenceRef);
  const audit = (await pool.query(`SELECT kind,actor_id,producer_id,producer_seq,next_state,evidence_refs,
    session_id,runtime_unit_id,operation_id,attempt_id,pod_uid,node_uid,resource_profile_revision
    FROM durable_runtime.runtime_audit_events WHERE id=$1`, [result.auditId])).rows[0];
  assert.equal(audit.kind, 'STORAGE_DIRECTORY_OBSERVATION_PREPARED');
  assert.equal(audit.actor_id, a.scope.actorId);
  assert.equal(audit.producer_id, a.hold.pinId);
  assert.equal(audit.producer_seq, '1');
  assert.deepEqual(audit.next_state.observation, a.observation);
  assert.deepEqual(audit.next_state.scope, a.scope);
  assert.equal(audit.next_state.qualificationRef, a.qualificationRef);
  assert.equal(audit.next_state.evidenceRef, a.evidenceRef);
  assert.equal(audit.next_state.profileId, a.hold.profileId);
  assert.equal(audit.next_state.generation, a.hold.generation);
  assert.equal(audit.next_state.digest, a.hold.digest);
  assert.equal(audit.next_state.pinId, a.hold.pinId);
  assert.deepEqual(audit.evidence_refs, [a.observation.reference, a.qualificationRef, a.evidenceRef]);
  for (const key of ['session_id', 'runtime_unit_id', 'operation_id', 'attempt_id', 'pod_uid', 'node_uid', 'resource_profile_revision']) {
    assert.equal(audit[key], null);
  }
  assert.equal(JSON.stringify(audit).includes(a.hold.ownerToken), false);
  assert.equal(JSON.stringify(audit).includes(hash(a.hold.ownerToken)), false);
  assert.deepEqual(await namespaceSnapshot(a), before);
  failed(await recordPreparedDirectoryObservation(pool, a), '23505');
  assert.equal(await auditCount(a.hold.pinId), '1');
  // Exercise existing immutable trigger only against this fixture's new audit.
  for (const sql of ['UPDATE durable_runtime.runtime_audit_events SET kind=kind WHERE id=$1',
    'DELETE FROM durable_runtime.runtime_audit_events WHERE id=$1']) {
    await assert.rejects(withDurableTransaction(pool, tx => tx.query(sql, [result.auditId])), { code: '23514' });
  }

  failed(await recordPreparedDirectoryObservation(pool, { ...b, hold: { ...b.hold, ownerToken: `wrong-owner:${randomUUID()}` } }),
    'DIRECTORY_OBSERVATION_HOLD');
  failed(await recordPreparedDirectoryObservation(pool, { ...b, hold: { ...b.hold, pinId: randomUUID() } }),
    'DIRECTORY_OBSERVATION_HOLD');
  failed(await recordPreparedDirectoryObservation(pool, { ...b, hold: { ...b.hold, generation: '1' } }),
    'DIRECTORY_OBSERVATION_PROFILE');
  failed(await recordPreparedDirectoryObservation(pool, { ...b, hold: { ...b.hold, digest: hash('other-profile') } }),
    'DIRECTORY_OBSERVATION_PROFILE');
  const changedPath = { ...b.observation, candidate: { ...b.observation.candidate,
    canonicalDirectory: `${b.observation.candidate.canonicalDirectory}/child` } };
  assert.throws(() => recordPreparedDirectoryObservation(pool, { ...b, observation: changedPath }),
    { code: 'DIRECTORY_OBSERVATION_SCOPE' });
  assert.equal(await auditCount(b.hold.pinId), '0');
  committed(await beginNamespaceManagement(pool, management(b)), 'WAITING');
  const drainingBefore = await namespaceSnapshot(b);
  recorded(await recordPreparedDirectoryObservation(pool, b)); // Original HELD remains valid in DRAINING.
  assert.deepEqual(await namespaceSnapshot(b), drainingBefore);
  committed(await releaseNamespaceHold(pool, released.hold), 'RELEASED');
  failed(await recordPreparedDirectoryObservation(pool, released), 'DIRECTORY_OBSERVATION_HOLD');
  committed(await releaseNamespaceHold(pool, applying.hold), 'RELEASED');
  const operation = management(applying);
  committed(await beginNamespaceManagement(pool, operation), 'READY_TO_CLAIM');
  committed(await claimNamespaceManagement(pool, operation), 'EXECUTE');
  failed(await recordPreparedDirectoryObservation(pool, applying), 'DIRECTORY_OBSERVATION_PROFILE_STATE');

  // Gate the borrowed Pool checkout. Mutating the caller DTO/method after the
  // first await must not change the audit, use another receiver or end the Pool.
  const originalInput = JSON.parse(JSON.stringify(captured));
  const entered = deferred(), connect = pool.connect.bind(pool);
  let endCalls = 0;
  const pids: number[] = [];
  const borrowed: Pool = Object.create(pool, {
    connect: { writable: true, value: async () => {
      entered.resolve(); await gate.promise;
      const client = await connect();
      pids.push((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      return client;
    } }, end: { value: () => { endCalls += 1; throw new Error('Borrowed Pool ended'); } },
  });
  const pending = recordPreparedDirectoryObservation(borrowed, captured);
  await entered.promise;
  Object.assign(captured.hold, { ownerToken: 'mutated-owner', digest: hash('mutated') });
  Object.assign(captured.scope, { actorId: 'mutated-actor', bindingId: randomUUID() });
  Object.assign(captured.observation.candidate, { inode: '99999' });
  Object.assign(captured.observation, { reference: 'mutated-reference', rawRequest: 'excluded-private-request' });
  Object.assign(captured, { evidenceRef: 'mutated-evidence', qualificationRef: 'mutated-qualification' });
  Object.assign(borrowed, { connect: () => { throw new Error('Mutated connect used'); } });
  gate.resolve();
  const capturedResult = recorded(await pending);
  assert.equal(endCalls, 0);
  const capturedAudit = (await pool.query('SELECT next_state FROM durable_runtime.runtime_audit_events WHERE id=$1',
    [capturedResult.auditId])).rows[0].next_state;
  assert.deepEqual(capturedAudit.observation, originalInput.observation);
  assert.deepEqual(capturedAudit.scope, originalInput.scope);
  assert.equal(capturedAudit.qualificationRef, originalInput.qualificationRef);
  assert.equal(capturedResult.evidenceRef, originalInput.evidenceRef);
  assert.equal(JSON.stringify(capturedAudit).includes('excluded-private-request'), false);

  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger);
  retained(originals, await originalHashes());
  const finalIdentity = await identity();
  console.log(JSON.stringify({ firstIdentity, finalIdentity, callbackCount: 1, schemaApplied: false,
    ledgerCount: ledger.length, originalRowsRetained: true, borrowedBackendPids: pids,
    syntheticObservationOnly: true, physicalQualification: false, bindingVerifierCalled: false }));
});
