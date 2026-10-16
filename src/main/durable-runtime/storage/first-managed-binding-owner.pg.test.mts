import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from '../db/connection.ts';
import { readMigrations } from '../db/migrate.ts';
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts';
import { acquireNamespaceHold, registerNamespaceProfile, releaseNamespaceHold } from './namespace-holds.ts';
import { createFirstManagedBindingOwner, type FirstManagedBindingInput } from './first-managed-binding-owner.ts';
import { firstManagedFixture } from './first-managed-binding-owner-fixtures.mts';
import { deferred } from './managed-leaf-collector-fixtures.mts';

// Root supplies an existing isolated database and exact ledger inputs later.
// No schema apply/reset/live collector or live qualification is performed here.
const database = process.env.ORCA_FIRST_MANAGED_BINDING_DATABASE;
const oid = process.env.ORCA_FIRST_MANAGED_BINDING_DATABASE_OID;
const system = process.env.ORCA_FIRST_MANAGED_BINDING_SYSTEM;
const migrationsPath = process.env.ORCA_FIRST_MANAGED_BINDING_MIGRATIONS;
if (process.env.ORCA_FIRST_MANAGED_BINDING_APPROVED !== 'root-first-verification' ||
    !database || !/^orca_[a-z0-9_]+$/u.test(database) || database === 'orca_dev' || database !== process.env.PGDATABASE ||
    !oid || !/^[1-9][0-9]*$/u.test(oid) || !system || !/^[1-9][0-9]*$/u.test(system) || !migrationsPath) {
  throw new Error('Root-approved existing isolated database/system/OID/ledger required');
}
const pool = createDurablePool({ database, max: 4, application_name: 'first-managed-binding-owner-first' });
type Mode = 'normal' | 'hold-unknown' | 'hold-cleanup' | 'audit-unknown' | 'audit-rollback';

function observedPool(mode: Mode, barrier?: { reached: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> }) {
  const active = new Set<number>(), events: string[] = [];
  let connects = 0, ends = 0;
  const facade = new Proxy(pool, { get(target, key) {
    if (key === 'end') return () => { ends++; throw new Error('Borrowed pool must not end'); };
    if (key !== 'connect') return Reflect.get(target, key, target);
    return async () => {
      const ordinal = ++connects, client = await pool.connect(); active.add(ordinal); events.push(`CONNECT${ordinal}`);
      let unknown = false;
      return new Proxy(client, { get(original, property) {
        if (property === 'query') return async (...args: unknown[]) => {
          const sql = args[0];
          if (mode === 'audit-rollback' && ordinal === 2 && typeof sql === 'string' && sql.includes('FROM durable_runtime.storage_namespace_profiles')) {
            throw new DurableDatabaseError('FIXTURE_AUDIT_ROLLBACK');
          }
          if (sql === 'COMMIT' && ordinal === 3 && barrier) {
            events.push('BINDING_BEFORE_COMMIT'); barrier.reached.resolve(undefined); await barrier.release.promise;
          }
          const value = await Reflect.apply(original.query, original, args);
          if (sql === 'COMMIT') events.push(`COMMIT${ordinal}`);
          if (sql === 'COMMIT' && (mode === 'hold-unknown' && ordinal === 1 || mode === 'audit-unknown' && ordinal === 2)) {
            unknown = true; return { ...value, command: 'UNCONFIRMED' };
          }
          if (sql === 'ROLLBACK' && unknown) return { ...value, command: 'UNCONFIRMED' };
          return value;
        };
        if (property === 'release') return (...args: unknown[]) => {
          Reflect.apply(original.release, original, args); active.delete(ordinal); events.push(`CLEANUP${ordinal}`);
          if (mode === 'hold-cleanup' && ordinal === 1) throw new Error('Synthetic cleanup failure');
        };
        return Reflect.get(original, property, original);
      });
    };
  });
  return { pool: facade, active, events, get connects() { return connects; }, get ends() { return ends; } };
}

async function seed(f: ReturnType<typeof firstManagedFixture>): Promise<FirstManagedBindingInput> {
  const agent = randomUUID(), workspace = randomUUID();
  const input: FirstManagedBindingInput = { sessionId: logicalId('session', randomUUID()),
    unitId: logicalId('runtime-unit', randomUUID()), bindingId: logicalId('storage-binding', randomUUID()),
    expectedUnitRevision: counter('row:runtime-unit', '0'), expectedBindingRevision: counter('row:storage-binding', '0'),
    actorId: 'fixture-first-managed-binding-owner', pinId: randomUUID(), ownerToken: `fixture-private-owner:${randomUUID()}`, leafId: f.leafId };
  await withDurableTransaction(pool, async tx => {
    await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'synthetic')", [agent]);
    await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'first owner fixture','READY')", [workspace, `fixture-first-owner:${workspace}`]);
    await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT')", [input.unitId]);
    await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [input.sessionId, agent, workspace]);
    await tx.query('INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2)', [f.record.profile.backendId, f.record.profile.exportId]);
    await tx.query("INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state) VALUES($1,$2,$3,$4,'UNVERIFIED')",
      [input.bindingId, f.record.profile.backendId, f.record.profile.exportId, `/${f.record.profile.datasetName}/${f.leafId}`]);
    await tx.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)', [input.unitId, input.sessionId, input.bindingId]);
  });
  const registered = await registerNamespaceProfile(pool, { ...f.record.profile, digest: f.settings.expectedProfileDigest, actorId: input.actorId });
  assert.equal(registered.database.ok, true); assert.equal(registered.database.cleanupFailed, false);
  assert.equal(registered.disposition?.status, 'REGISTERED');
  return input;
}
async function held(pinId: string) {
  return (await pool.query('SELECT state FROM durable_runtime.storage_namespace_holds WHERE id=$1', [pinId])).rows[0]?.state;
}
async function binding(bindingId: string) {
  return (await pool.query('SELECT access_state,identity_proof_ref,epoch::text,writer_attempt_id FROM durable_runtime.storage_bindings WHERE id=$1', [bindingId])).rows[0];
}
async function audit(pinId: string) {
  return (await pool.query("SELECT id,next_state FROM durable_runtime.runtime_audit_events WHERE producer_id=$1 AND kind='STORAGE_DIRECTORY_OBSERVATION_PREPARED'", [pinId])).rows;
}

await test('first managed owner integrates held original collection, prepared audit, exclusive binding settlement and explicit failed-preparation release', async t => {
  t.after(() => pool.end());
  const identity = (await pool.query(`SELECT current_database() AS database,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system`)).rows[0];
  assert.deepEqual(identity, { database, oid, system });
  const ledger = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows;
  const migrations = await readMigrations(migrationsPath);
  assert.deepEqual(ledger.map(row => [row.version, row.checksum]), migrations.map(row => [row.version, row.checksum]));
  const originalBindings = (await pool.query('SELECT id,to_jsonb(b) AS body FROM durable_runtime.storage_bindings b')).rows;
  const originalAudits = (await pool.query('SELECT id,to_jsonb(a) AS body FROM durable_runtime.runtime_audit_events a')).rows;

  await t.test('hold cleanup precedes external I/O; original tuple is audited before binding and pin release follows actual COMMIT', async () => {
    const f = firstManagedFixture(), input = await seed(f);
    const barrier = { reached: deferred<void>(), release: deferred<void>() }, observer = observedPool('normal', barrier);
    const originalRequest = f.wire.dependencies.https.request.bind(f.wire.dependencies.https);
    const originalOpen = f.wire.dependencies.openWebSocket.bind(f.wire.dependencies);
    const dependencies = { https: { request(...args: Parameters<typeof originalRequest>) {
      assert.equal(observer.active.size, 0); assert.ok(observer.events.includes('CLEANUP1')); observer.events.push('HTTP'); return originalRequest(...args);
    } }, openWebSocket(...args: Parameters<typeof originalOpen>) {
      assert.equal(observer.active.size, 0); observer.events.push('WS'); return originalOpen(...args);
    } };
    const owner = createFirstManagedBindingOwner(observer.pool, f.settings, dependencies);
    const pending = owner.verifyFirstBinding(input, new AbortController().signal);
    await barrier.reached.promise;
    assert.equal(await held(input.pinId), 'HELD'); assert.equal((await binding(input.bindingId)).access_state, 'UNVERIFIED');
    const prepared = await audit(input.pinId); assert.equal(prepared.length, 1);
    assert.equal(prepared[0].next_state.qualificationRef, f.record.qualificationRef);
    assert.equal(prepared[0].next_state.digest, f.settings.expectedProfileDigest);
    const observedCandidate = prepared[0].next_state.observation.candidate;
    assert.equal(observedCandidate.podUid, f.wire.configuration.podUid);
    assert.match(observedCandidate.generation, /^[a-f0-9]{64}$/u);
    assert.equal(observedCandidate.device, '66317'); assert.equal(observedCandidate.inode, '400');
    assert.equal(observer.connects, 3);
    barrier.release.resolve(undefined);
    const result = await pending;
    assert.equal(result.outcome, 'VERIFIED'); assert.equal(result.pin.state, 'RELEASED'); assert.equal(result.pin.handedOff, true);
    assert.equal(result.binding?.database?.settlement, 'COMMITTED'); assert.equal(result.release?.database.commitOutcome, 'ACKNOWLEDGED');
    assert.equal(await held(input.pinId), 'RELEASED');
    assert.deepEqual(await binding(input.bindingId), { access_state: 'VERIFIED', identity_proof_ref: result.evidenceRef, epoch: '0', writer_attempt_id: null });
    assert.equal(observer.connects, 4); assert.equal(observer.ends, 0); assert.equal(observer.active.size, 0);
    assert.ok(observer.events.indexOf('COMMIT3') < observer.events.indexOf('CONNECT4'));
    assert.equal(f.wire.api.requests.length, 6); assert.equal(f.wire.opened.length, 1);
    const requests = f.wire.api.requests.length, connects = observer.connects;
    const repeated = await owner.verifyFirstBinding(input, new AbortController().signal);
    assert.equal(repeated.errorCode, 'FIRST_MANAGED_PIN_ALREADY_ATTEMPTED');
    assert.equal(f.wire.api.requests.length, requests); assert.equal(observer.connects, connects);
    for (const secret of [input.ownerToken, f.issued, f.reviewerToken]) assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal('retainedOwner' in result.binding!.pin, false); assert.equal('retainedLease' in result.binding!.pin, false);
    await f.wire.assertCleanup();
  });

  for (const mode of ['hold-unknown', 'hold-cleanup', 'audit-unknown'] as const) {
    await t.test(`${mode} retains the pin and prevents the next stage without reacquisition`, async () => {
      const f = firstManagedFixture(), input = await seed(f), observer = observedPool(mode);
      const owner = createFirstManagedBindingOwner(observer.pool, f.settings, f.wire.dependencies);
      const result = await owner.verifyFirstBinding(input, new AbortController().signal);
      assert.equal(result.outcome, 'RECONCILIATION_REQUIRED'); assert.equal(result.binding, null);
      assert.equal(result.pin.failedPreparationReleaseEligible, false); assert.equal(await held(input.pinId), 'HELD');
      assert.equal((await binding(input.bindingId)).access_state, 'UNVERIFIED');
      assert.equal(f.wire.api.requests.length, mode === 'audit-unknown' ? 6 : 0);
      assert.equal((await audit(input.pinId)).length, mode === 'audit-unknown' ? 1 : 0);
      const before = observer.connects;
      assert.equal((await owner.releaseFailedPreparation(input)).errorCode, 'FIRST_MANAGED_RELEASE_NOT_ELIGIBLE');
      assert.equal(observer.connects, before); assert.equal(observer.ends, 0); assert.equal(observer.active.size, 0);
      await f.wire.assertCleanup();
    });
  }

  await t.test('a definite audit rollback allows only explicit same-owner release before any binding transaction', async () => {
    const f = firstManagedFixture(), input = await seed(f), observer = observedPool('audit-rollback');
    const owner = createFirstManagedBindingOwner(observer.pool, f.settings, f.wire.dependencies);
    const result = await owner.verifyFirstBinding(input, new AbortController().signal);
    assert.equal(result.phase, 'AUDIT'); assert.equal(result.outcome, 'FAILED'); assert.equal(result.pin.failedPreparationReleaseEligible, true);
    assert.equal(await held(input.pinId), 'HELD'); assert.equal((await audit(input.pinId)).length, 0); assert.equal(observer.connects, 2);
    await assert.rejects(owner.releaseFailedPreparation({ pinId: input.pinId, ownerToken: 'fixture-private-other-owner-token' }));
    assert.equal(observer.connects, 2);
    const released = await owner.releaseFailedPreparation(input);
    assert.equal(released.pin.state, 'RELEASED'); assert.equal(released.release?.database.settlement, 'COMMITTED');
    assert.equal(await held(input.pinId), 'RELEASED'); assert.equal((await binding(input.bindingId)).access_state, 'UNVERIFIED');
    const count = observer.connects;
    assert.equal((await owner.releaseFailedPreparation(input)).errorCode, 'FIRST_MANAGED_RELEASE_NOT_ELIGIBLE');
    assert.equal(observer.connects, count); assert.equal(observer.ends, 0);
    await f.wire.assertCleanup();
  });

  await t.test('a pre-existing hold is never treated as a fresh owner and never starts collection', async () => {
    const f = firstManagedFixture(), input = await seed(f), hold = { ...f.record.profile, digest: f.settings.expectedProfileDigest,
      actorId: input.actorId, pinId: input.pinId, ownerToken: input.ownerToken };
    assert.equal((await acquireNamespaceHold(pool, hold)).disposition?.status, 'ACQUIRED');
    const owner = createFirstManagedBindingOwner(pool, f.settings, f.wire.dependencies);
    const result = await owner.verifyFirstBinding(input, new AbortController().signal);
    assert.equal(result.hold?.disposition?.status, 'ALREADY_HELD'); assert.equal(result.pin.state, 'PREEXISTING');
    assert.equal(result.outcome, 'RECONCILIATION_REQUIRED'); assert.equal(f.wire.api.requests.length, 0);
    assert.equal((await owner.releaseFailedPreparation(input)).errorCode, 'FIRST_MANAGED_RELEASE_NOT_ELIGIBLE');
    // This fixture itself acquired this separate seed hold; the new owner did not.
    assert.equal((await releaseNamespaceHold(pool, hold)).disposition?.status, 'RELEASED');
    await f.wire.assertCleanup();
  });

  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger);
  for (const row of originalBindings) assert.deepEqual((await pool.query('SELECT to_jsonb(b) AS body FROM durable_runtime.storage_bindings b WHERE id=$1', [row.id])).rows[0].body, row.body);
  for (const row of originalAudits) assert.deepEqual((await pool.query('SELECT to_jsonb(a) AS body FROM durable_runtime.runtime_audit_events a WHERE id=$1', [row.id])).rows[0].body, row.body);
  assert.deepEqual((await pool.query('SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows, [{ dataset_name: 'orca-1012-dev-v1' }]);
});
