import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import type { Pool } from "pg";
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from "../db/connection.ts";
import { applyMigrations, readMigrations } from "../db/migrate.ts";
import { acquireNamespaceHold, beginNamespaceManagement, claimNamespaceManagement,
  completeNamespaceManagement, readNamespaceHold, readNamespaceManagement,
  registerNamespaceProfile, releaseNamespaceHold } from "./namespace-holds.ts";
import type { NamespaceHoldInput, NamespaceManagementInput, NamespaceProfileInput,
  NamespaceTransactionResult } from "./namespace-holds.ts";

// Only the later Root dispatch supplies these existing isolated DB inputs.
// This fixture does not create/reset/select a database or touch live NFS.
const database = process.env.ORCA_NAMESPACE_HOLDS_DATABASE;
const oid = process.env.ORCA_NAMESPACE_HOLDS_DATABASE_OID;
const migrationsPath = process.env.ORCA_NAMESPACE_HOLDS_MIGRATIONS;
if (process.env.ORCA_NAMESPACE_HOLDS_APPROVED !== "root-first-verification" ||
    !database || !/^orca_[a-z0-9_]+$/.test(database) || database === "orca_dev" ||
    process.env.PGDATABASE !== database || !oid || !/^[1-9][0-9]*$/.test(oid) || !migrationsPath) {
  throw new Error("Root-approved existing isolated DB/OID and migrations required");
}
const pool = createDurablePool({ database, max: 6, application_name: "namespace-holds-first" });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
function committed(result: NamespaceTransactionResult, status: string) {
  assert.equal(result.database.ok, true);
  assert.equal(result.database.settlement, "COMMITTED");
  assert.equal(result.database.commitOutcome, "ACKNOWLEDGED");
  assert.equal(result.disposition?.status, status);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.disposition));
  return result.disposition!;
}
function failed(result: NamespaceTransactionResult, code: string) {
  assert.equal(result.disposition, null);
  assert.equal(result.database.ok, false);
  if (result.database.ok) { throw new Error("Expected failure"); }
  assert.equal(result.database.error.code, code);
}
async function identity() {
  const value = (await pool.query<{ database: string; oid: string; system: string; backend_pid: number }>(
    `SELECT current_database() AS database,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
      (SELECT system_identifier::text FROM pg_control_system()) AS system,pg_backend_pid() AS backend_pid`)).rows[0];
  assert.equal(value.database, database);
  assert.equal(value.oid, oid);
  assert.equal(value.system, "7696101282789175327");
  assert.deepEqual((await pool.query("SELECT dataset_name FROM durable_runtime.dataset_metadata")).rows,
    [{ dataset_name: "orca-1012-dev-v1" }]);
  return value;
}
// Existing affected rows are hashed privately, never printed as payloads.
const originalTables = ["dataset_metadata", "storage_domains", "storage_bindings", "storage_write_grants",
  "storage_mounts", "runtime_member_storage_bindings", "runtime_units", "attempts", "execution_grants",
  "operations", "runtime_audit_events", "outbox_events"] as const;
async function rowHashes() {
  const result: Record<string, string[]> = {};
  for (const table of originalTables) {
    result[table] = (await pool.query<{ body: string }>(
      `SELECT to_jsonb(t)::text AS body FROM durable_runtime.${table} t`)).rows.map(row => hash(row.body)).sort();
  }
  return result;
}
function retained(before: Record<string, string[]>, after: Record<string, string[]>) {
  for (const table of originalTables) {
    const counts = new Map<string, number>();
    for (const item of after[table]) { counts.set(item, (counts.get(item) ?? 0) + 1); }
    for (const item of before[table]) {
      assert.ok((counts.get(item) ?? 0) > 0, `Original row missing in ${table}`);
      counts.set(item, (counts.get(item) ?? 0) - 1);
    }
  }
}
const profile = (suffix: string): NamespaceProfileInput => ({
  profileId: randomUUID(), datasetName: "orca-1012-dev-v1", backendId: "synthetic-namespace-backend",
  exportId: `synthetic-namespace:${suffix}:${randomUUID()}`, generation: "0", digest: hash(`profile:${suffix}`),
  actorId: "synthetic-namespace-management-actor"
});
const hold = (value: NamespaceProfileInput): NamespaceHoldInput => ({
  ...value, pinId: randomUUID(), ownerToken: `synthetic-secret:${randomUUID()}`
});
const management = (value: NamespaceProfileInput): NamespaceManagementInput => ({
  ...value, operationId: randomUUID(), ownerToken: `synthetic-secret:${randomUUID()}`,
  targetGeneration: (BigInt(value.generation) + 1n).toString(), targetDigest: hash(`next:${randomUUID()}`)
});
async function history(id: string) {
  return (await pool.query<{ audit: string; outbox: string }>(`SELECT
    (SELECT count(*)::text FROM durable_runtime.runtime_audit_events WHERE next_state->>'profileId'=$1) AS audit,
    (SELECT count(*)::text FROM durable_runtime.outbox_events WHERE aggregate_id=$1::uuid) AS outbox`, [id])).rows[0];
}
async function blocked(waiter: number, blocker: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await pool.query<{ blocked: boolean }>(
      "SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked", [blocker, waiter])).rows[0].blocked) { return; }
    await pause(50);
  }
  throw new DurableDatabaseError("NAMESPACE_FIXTURE_LOCK_WAIT_NOT_OBSERVED");
}

// Fixture-only wire decorator over actual PG clients. SQL bodies are unchanged.
// The ACK fault hides an actual COMMIT response, then fails cleanup, without
// claiming a production transport failure or fabricating an engine outcome.
function wire(options: { gate?: ReturnType<typeof deferred>; entered?: ReturnType<typeof deferred>; started?: ReturnType<typeof deferred>;
  rollback?: boolean; unknown?: boolean; pids: number[] }): Pool {
  const connect = pool.connect.bind(pool);
  return new Proxy(pool, { get(target, key, receiver) {
    if (key !== "connect") { return Reflect.get(target, key, receiver); }
    return async () => {
      const client = await connect();
      const query = client.query.bind(client);
      options.pids.push((await query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      return new Proxy(client, { get(owner, method, originalReceiver) {
        if (method === "release") { return client.release.bind(client); }
        if (method !== "query") { return Reflect.get(owner, method, originalReceiver); }
        return async (sql: string, values: unknown[] = []) => {
          if (sql.includes("storage_domains") && sql.includes("FOR UPDATE")) { options.started?.resolve(); }
          if (options.rollback && sql.startsWith("INSERT INTO durable_runtime.outbox_events")) {
            throw new DurableDatabaseError("NAMESPACE_SYNTHETIC_ROLLBACK");
          }
          if (options.unknown && sql === "ROLLBACK") { throw new Error("synthetic cleanup response loss"); }
          const result = await query(sql, values);
          if (options.gate && sql.includes("storage_domains") && sql.includes("FOR UPDATE")) {
            options.entered?.resolve();
            await options.gate.promise;
          }
          if (options.unknown && sql === "COMMIT") { throw new Error("synthetic commit response loss"); }
          return result;
        };
      } });
    };
  } });
}

await test("Namespace holds: first migration022 and focused durable management boundaries", async t => {
  const gates: ReturnType<typeof deferred>[] = [];
  t.after(async () => { for (const gate of gates) { gate.resolve(); } await pool.end(); });
  const firstIdentity = await identity(); // Actual system/OID/dataset before DDL or seed.
  const migrations = await readMigrations(migrationsPath);
  assert.equal(migrations.length, 22);
  assert.equal(migrations[21].version, "022-storage-namespace-holds.sql");
  const ledgerBefore = (await pool.query("SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version")).rows;
  assert.equal(ledgerBefore.length, 21, "First 022 run requires the existing ledger001–021");
  assert.deepEqual(ledgerBefore.map(row => [row.version, row.checksum]),
    migrations.slice(0, 21).map(row => [row.version, row.checksum]));
  const originals = await rowHashes();
  const absent = (await pool.query<{ absent: boolean }>(
    "SELECT to_regclass('durable_runtime.storage_namespace_profiles') IS NULL AS absent")).rows[0].absent;
  assert.equal(absent, true);
  const applied = await applyMigrations(pool, migrations);
  assert.equal(applied.length, 22);
  assert.deepEqual(applied.slice(0, 21), ledgerBefore);
  const seedIdentity = await identity();
  const a = profile("acquire-first"), b = profile("drain-first"), c = profile("independent"), d = profile("rollback");
  await withDurableTransaction(pool, async tx => {
    for (const item of [a, b, c, d]) {
      await tx.query("INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2)", [item.backendId, item.exportId]);
    }
  });
  for (const item of [a, b, c, d]) { committed(await registerNamespaceProfile(pool, item), "REGISTERED"); }
  const pids: number[] = [];

  // Acquire owns the domain lock first; drain must wait and then observe HELD.
  const aHold = hold(a), aChange = management(a);
  const acquiredGate = deferred(), acquiredEntered = deferred();
  gates.push(acquiredGate);
  const acquiringPids: number[] = [], drainingPids: number[] = [], drainingStarted = deferred();
  const acquiring = acquireNamespaceHold(wire({ gate: acquiredGate, entered: acquiredEntered, pids: acquiringPids }), aHold);
  await acquiredEntered.promise;
  const draining = beginNamespaceManagement(wire({ started: drainingStarted, pids: drainingPids }), aChange);
  await drainingStarted.promise;
  await blocked(drainingPids[0], acquiringPids[0]);
  // Another profile/domain proceeds while the first transaction is held.
  const cHold = hold(c);
  committed(await acquireNamespaceHold(pool, cHold), "ACQUIRED");
  acquiredGate.resolve();
  committed(await acquiring, "ACQUIRED");
  committed(await draining, "WAITING");
  pids.push(...acquiringPids, ...drainingPids);
  committed(await claimNamespaceManagement(pool, aChange), "WAITING");
  const beforeReplay = await history(a.profileId);
  committed(await acquireNamespaceHold(pool, aHold), "ALREADY_HELD");
  // Reconstructed caller retains only the durable ID/input, no memory owner map.
  committed(await readNamespaceHold(pool, { ...aHold }), "ALREADY_HELD");
  assert.deepEqual(await history(a.profileId), beforeReplay);
  failed(await acquireNamespaceHold(pool, { ...aHold, ownerToken: `synthetic-secret:${randomUUID()}` }), "NAMESPACE_PIN_CONFLICT");
  failed(await acquireNamespaceHold(pool, hold(a)), "NAMESPACE_PROFILE_NOT_ACTIVE");
  const releaseGate = deferred(), releaseEntered = deferred(), claimStarted = deferred();
  const releasePids: number[] = [], claimPids: number[] = [];
  gates.push(releaseGate);
  const releasing = releaseNamespaceHold(wire({ gate: releaseGate, entered: releaseEntered, pids: releasePids }), aHold);
  await releaseEntered.promise;
  const claiming = claimNamespaceManagement(wire({ started: claimStarted, pids: claimPids }), aChange);
  await claimStarted.promise;
  await blocked(claimPids[0], releasePids[0]);
  releaseGate.resolve();
  committed(await releasing, "RELEASED");
  committed(await claiming, "EXECUTE");
  pids.push(...releasePids, ...claimPids);
  committed(await releaseNamespaceHold(pool, aHold), "ALREADY_RELEASED");
  const beforeClaimReplay = await history(a.profileId);
  committed(await claimNamespaceManagement(pool, { ...aChange }), "LOOKUP_REQUIRED");
  committed(await readNamespaceManagement(pool, aChange), "LOOKUP_REQUIRED");
  assert.deepEqual(await history(a.profileId), beforeClaimReplay);
  const appliedResult = { status: "APPLIED", profileId: a.profileId, operationId: aChange.operationId,
    generation: a.generation, targetGeneration: aChange.targetGeneration, targetDigest: aChange.targetDigest } as const;
  const firstCompleted = committed(await completeNamespaceManagement(pool, aChange, appliedResult), "COMPLETED");
  assert.equal(firstCompleted.generation, aChange.targetGeneration);
  assert.equal(firstCompleted.digest, aChange.targetDigest);
  const checkCompletedReplay = async () => {
    for (const replay of [readNamespaceManagement, beginNamespaceManagement, claimNamespaceManagement]) {
      const value = committed(await replay(pool, aChange), "ALREADY_COMPLETED");
      assert.equal(value.generation, aChange.targetGeneration);
      assert.equal(value.digest, aChange.targetDigest);
    }
    const value = committed(await completeNamespaceManagement(pool, aChange, appliedResult), "ALREADY_COMPLETED");
    assert.equal(value.generation, aChange.targetGeneration);
    assert.equal(value.digest, aChange.targetDigest);
  };
  await checkCompletedReplay();
  committed(await readNamespaceHold(pool, aHold), "ALREADY_RELEASED");
  failed(await acquireNamespaceHold(pool, hold(a)), "NAMESPACE_PROFILE_STALE");
  const nextProfile = { ...a, generation: "1", digest: aChange.targetDigest }, nextHold = hold(nextProfile);
  committed(await acquireNamespaceHold(pool, nextHold), "ACQUIRED");
  committed(await releaseNamespaceHold(pool, nextHold), "RELEASED");
  const nextChange = management(nextProfile);
  committed(await beginNamespaceManagement(pool, nextChange), "READY_TO_CLAIM");
  committed(await claimNamespaceManagement(pool, nextChange), "EXECUTE");
  const secondCompleted = committed(await completeNamespaceManagement(pool, nextChange, {
    status: "APPLIED", profileId: a.profileId, operationId: nextChange.operationId,
    generation: nextProfile.generation, targetGeneration: nextChange.targetGeneration, targetDigest: nextChange.targetDigest
  }), "COMPLETED");
  assert.equal(secondCompleted.generation, "2");
  await checkCompletedReplay(); // Original operation remains generation1, never current generation2.
  committed(await readNamespaceHold(pool, aHold), "ALREADY_RELEASED");

  // Drain owns the lock first; the new acquisition must fail without a row.
  const bChange = management(b), bHold = hold(b), drainedGate = deferred(), drainedEntered = deferred();
  gates.push(drainedGate);
  const drainFirstPids: number[] = [], acquireSecondPids: number[] = [], acquireSecondStarted = deferred();
  const drainFirst = beginNamespaceManagement(wire({ gate: drainedGate, entered: drainedEntered, pids: drainFirstPids }), bChange);
  await drainedEntered.promise;
  const acquireSecond = acquireNamespaceHold(wire({ started: acquireSecondStarted, pids: acquireSecondPids }), bHold);
  await acquireSecondStarted.promise;
  await blocked(acquireSecondPids[0], drainFirstPids[0]);
  drainedGate.resolve();
  committed(await drainFirst, "READY_TO_CLAIM");
  failed(await acquireSecond, "NAMESPACE_PROFILE_NOT_ACTIVE");
  pids.push(...drainFirstPids, ...acquireSecondPids);
  assert.equal((await pool.query("SELECT id FROM durable_runtime.storage_namespace_holds WHERE id=$1", [bHold.pinId])).rowCount, 0);

  // Actual PG rollback must retain no hold, audit or outbox from that call.
  const dHold = hold(d), beforeRollback = await history(d.profileId);
  const rolledBack = await acquireNamespaceHold(wire({ rollback: true, pids }), dHold);
  failed(rolledBack, "NAMESPACE_SYNTHETIC_ROLLBACK");
  assert.equal(rolledBack.database.settlement, "ROLLED_BACK");
  assert.equal(rolledBack.database.commitOutcome, "NOT_ATTEMPTED");
  assert.deepEqual(await history(d.profileId), beforeRollback);
  failed(await readNamespaceHold(pool, dHold), "NAMESPACE_PIN_MISSING");

  // Actual COMMIT occurs, but the synthetic wire loses ACK and cleanup reply.
  const uncertain = await acquireNamespaceHold(wire({ unknown: true, pids }), dHold);
  assert.equal(uncertain.disposition, null);
  assert.equal(uncertain.database.ok, false);
  assert.equal(uncertain.database.settlement, "UNCONFIRMED");
  assert.equal(uncertain.database.commitOutcome, "UNKNOWN");
  committed(await readNamespaceHold(pool, dHold), "ALREADY_HELD");
  committed(await acquireNamespaceHold(pool, dHold), "ALREADY_HELD");
  committed(await releaseNamespaceHold(pool, dHold), "RELEASED");
  const dChange = management(d);
  committed(await beginNamespaceManagement(pool, dChange), "READY_TO_CLAIM");
  const uncertainClaim = await claimNamespaceManagement(wire({ unknown: true, pids }), dChange);
  assert.equal(uncertainClaim.disposition, null);
  assert.equal(uncertainClaim.database.commitOutcome, "UNKNOWN");
  committed(await readNamespaceManagement(pool, dChange), "LOOKUP_REQUIRED");
  committed(await claimNamespaceManagement(pool, dChange), "LOOKUP_REQUIRED");

  const finalIdentity = await identity();
  const ledgerAfter = (await pool.query("SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version")).rows;
  assert.deepEqual(ledgerAfter, applied);
  retained(originals, await rowHashes());
  const summaries = (await pool.query<{ body: string }>(`SELECT next_state::text AS body
    FROM durable_runtime.runtime_audit_events WHERE next_state->>'profileId'=ANY($1::text[])`,
  [[a.profileId, b.profileId, c.profileId, d.profileId]])).rows;
  for (const row of summaries) {
    assert.equal(row.body.includes("ownerToken"), false);
    assert.equal(row.body.includes("owner_token_hash"), false);
    assert.equal(row.body.includes("synthetic-secret"), false);
  }
  t.diagnostic(JSON.stringify({ firstIdentity, seedIdentity, finalIdentity, backendPids: [...new Set(pids)],
    ledgerBefore: ledgerBefore.length, ledgerAfter: ledgerAfter.length,
    originalRowsRetained: true, physicalNamespacePinVerified: false, liveManagementMutation: false,
    unknownFault: "synthetic ACK/cleanup loss over actual PG COMMIT", callbackCount: 1 }));
});
