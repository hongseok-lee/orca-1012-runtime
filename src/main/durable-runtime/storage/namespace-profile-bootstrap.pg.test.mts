import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createDurablePool } from '../db/connection.ts';
import { registerNamespaceProfile } from './namespace-holds.ts';
import type { NamespaceProfileInput, NamespaceTransactionResult } from './namespace-holds.ts';

// Root later assigns the existing isolated ledger23 DB. No new DB, DDL, live
// profile, hold, binding, collector or physical qualification is created here.
const database = process.env.ORCA_NAMESPACE_BOOTSTRAP_DATABASE;
const oid = process.env.ORCA_NAMESPACE_BOOTSTRAP_DATABASE_OID;
if (process.env.ORCA_NAMESPACE_BOOTSTRAP_APPROVED !== 'root-first-verification' ||
    !database || !/^orca_[a-z0-9_]+$/.test(database) || database === 'orca_dev' ||
    process.env.PGDATABASE !== database || !oid || !/^[1-9][0-9]*$/.test(oid)) {
  throw new Error('Root-approved existing isolated DB/OID required');
}
const pool = createDurablePool({ database, max: 2, application_name: 'namespace-profile-bootstrap-first',
  connectionTimeoutMillis: 5000, query_timeout: 15000, options: '-c statement_timeout=15000 -c lock_timeout=5000' });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function committed(result: NamespaceTransactionResult, status: string) {
  assert.equal(result.database.ok, true);
  assert.equal(result.database.settlement, 'COMMITTED');
  assert.equal(result.database.commitOutcome, 'ACKNOWLEDGED');
  assert.equal(result.database.cleanupFailed, false);
  assert.equal(result.disposition?.status, status);
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
const tables = ['storage_domains', 'storage_namespace_profiles', 'storage_namespace_profile_versions',
  'runtime_audit_events', 'outbox_events'] as const;
async function originalHashes() {
  const rows: Record<string, string[]> = {};
  for (const table of tables) {
    rows[table] = (await pool.query<{ body: string }>(
      `SELECT to_jsonb(t)::text AS body FROM durable_runtime.${table} t`)).rows.map(row => hash(row.body)).sort();
  }
  return rows;
}
async function domainCount(input: NamespaceProfileInput) {
  return (await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM durable_runtime.storage_domains WHERE backend_id=$1 AND export_id=$2',
    [input.backendId, input.exportId])).rows[0].count;
}
async function snapshot(input: NamespaceProfileInput) {
  return (await pool.query(`SELECT
    (SELECT to_jsonb(p) FROM durable_runtime.storage_namespace_profiles p WHERE id=$1) AS profile,
    (SELECT jsonb_agg(to_jsonb(v) ORDER BY generation) FROM durable_runtime.storage_namespace_profile_versions v WHERE profile_id=$1) AS versions,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM durable_runtime.runtime_audit_events a WHERE next_state->>'profileId'=$1::text) AS audit,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM durable_runtime.outbox_events o WHERE aggregate_id=$1) AS outbox`,
  [input.profileId])).rows[0];
}

await test('Namespace profile bootstrap: first domain, immutable replay and conflict rollback', async t => {
  t.after(async () => { await pool.end(); });
  const firstIdentity = await identity(); // Actual system/OID/dataset on the same Pool before registration.
  const ledger = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows;
  assert.equal(ledger.length, 23);
  const before = await originalHashes();
  const input: NamespaceProfileInput = { profileId: randomUUID(), datasetName: 'orca-1012-dev-v1',
    backendId: `synthetic-bootstrap:${randomUUID()}`, exportId: `synthetic-export:${randomUUID()}`,
    generation: '0', digest: hash(`synthetic-profile:${randomUUID()}`), actorId: 'synthetic-bootstrap-actor' };
  assert.equal(await domainCount(input), '0');
  // The product function alone creates the logical domain in its transaction.
  // No fixture INSERT seeds the domain or bypasses registerNamespaceProfile.
  committed(await registerNamespaceProfile(pool, input), 'REGISTERED');
  assert.equal(await domainCount(input), '1');
  const registered = await snapshot(input);
  assert.equal(registered.profile.id, input.profileId);
  assert.equal(registered.profile.dataset_name, input.datasetName);
  assert.equal(registered.profile.backend_id, input.backendId);
  assert.equal(registered.profile.export_id, input.exportId);
  assert.equal(registered.profile.generation, input.generation);
  assert.equal(registered.profile.digest, input.digest);
  assert.equal(registered.profile.state, 'ACTIVE');
  assert.equal(registered.profile.revision, 0);
  assert.equal(registered.versions.length, 1);
  assert.equal(registered.versions[0].generation, 0);
  assert.equal(registered.versions[0].digest, input.digest);
  assert.equal(registered.audit.length, 1);
  assert.equal(registered.audit[0].next_state.status, 'REGISTERED');
  assert.equal(registered.outbox.length, 1);
  committed(await registerNamespaceProfile(pool, { ...input }), 'ALREADY_REGISTERED');
  assert.equal(await domainCount(input), '1');
  assert.deepEqual(await snapshot(input), registered);

  const conflicting = { ...input, backendId: `synthetic-conflict:${randomUUID()}`, exportId: `synthetic-conflict:${randomUUID()}` };
  assert.equal(await domainCount(conflicting), '0');
  const conflict = await registerNamespaceProfile(pool, conflicting);
  assert.equal(conflict.database.ok, false);
  if (conflict.database.ok) { throw new Error('Expected scope conflict'); }
  assert.equal(conflict.database.settlement, 'ROLLED_BACK');
  assert.equal(conflict.database.commitOutcome, 'NOT_ATTEMPTED');
  assert.equal(conflict.database.cleanupFailed, false);
  assert.equal(conflict.database.error.code, 'NAMESPACE_PROFILE_SCOPE');
  assert.equal(conflict.disposition, null);
  assert.equal(await domainCount(conflicting), '0'); // Its new domain INSERT rolled back with the conflict.
  assert.deepEqual(await snapshot(input), registered);
  const after = await originalHashes();
  for (const table of tables) {
    const remaining = new Map<string, number>();
    for (const value of after[table]) { remaining.set(value, (remaining.get(value) ?? 0) + 1); }
    for (const value of before[table]) {
      assert.ok((remaining.get(value) ?? 0) > 0, `Original row lost in ${table}`);
      remaining.set(value, (remaining.get(value) ?? 0) - 1);
    }
  }
  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger);
  const finalIdentity = await identity();
  console.log(JSON.stringify({ firstIdentity, finalIdentity, callbackCount: 1, schemaApplied: false,
    ledgerCount: ledger.length, originalRowsRetained: true, syntheticProfileOnly: true,
    physicalQualification: false, bindingCreated: false, holdCreated: false }));
});
