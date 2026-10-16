import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Pool } from "pg";
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from "../db/connection.ts";
import { readMigrations } from "../db/migrate.ts";
import { acquireNamespaceHold, readNamespaceManagement,
  registerNamespaceProfile, releaseNamespaceHold } from "./namespace-holds.ts";
import type { NamespaceManagementInput, NamespaceProfileInput, NamespaceTransactionResult } from "./namespace-holds.ts";
import { executeNamespaceManagement } from "./namespace-management-execution.ts";
import type { NamespaceManagementExecutionResult, NamespaceManagementTarget,
  TrustedNamespaceManagementPort } from "./namespace-management-execution.ts";

// Root later supplies an existing isolated ledger23 DB. No migration/DDL/reset,
// actual NFS adapter, physical evidence issuer, provider, or live mutation here.
const database = process.env.ORCA_NAMESPACE_MANAGEMENT_DATABASE;
const oid = process.env.ORCA_NAMESPACE_MANAGEMENT_DATABASE_OID;
const migrationsPath = process.env.ORCA_NAMESPACE_MANAGEMENT_MIGRATIONS;
if (process.env.ORCA_NAMESPACE_MANAGEMENT_APPROVED !== "root-first-verification" ||
    !database || !/^orca_[a-z0-9_]+$/.test(database) || database === "orca_dev" ||
    process.env.PGDATABASE !== database || !oid || !/^[1-9][0-9]*$/.test(oid) || !migrationsPath) {
  throw new Error("Root-approved existing isolated DB/OID and migrations required");
}
const pool = createDurablePool({ database, max: 6, application_name: "namespace-management-execution-first",
  connectionTimeoutMillis: 5000, query_timeout: 15000, options: "-c statement_timeout=15000 -c lock_timeout=5000" });
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
  assert.equal(result.database.cleanupFailed, false);
  assert.equal(result.disposition?.status, status);
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
const originalTables = ["dataset_metadata", "storage_domains", "storage_bindings", "storage_write_grants",
  "storage_mounts", "runtime_member_storage_bindings", "runtime_units", "attempts", "execution_grants",
  "operations", "runtime_audit_events", "outbox_events", "storage_namespace_profiles",
  "storage_namespace_profile_versions", "storage_namespace_holds", "storage_namespace_management_operations",
  "agent_pod_plans"] as const;
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
  profileId: randomUUID(), datasetName: "orca-1012-dev-v1", backendId: "synthetic-management-execution-backend",
  exportId: `synthetic-management-execution:${suffix}:${randomUUID()}`, generation: "0",
  digest: hash(`synthetic-profile:${suffix}`), actorId: "synthetic-management-execution-actor",
});
const management = (value: NamespaceProfileInput): NamespaceManagementInput => ({
  ...value, operationId: randomUUID(), ownerToken: `synthetic-owner-secret:${randomUUID()}`,
  targetGeneration: "1", targetDigest: hash(`synthetic-next:${randomUUID()}`),
});
const target = (input: NamespaceManagementInput): NamespaceManagementTarget => ({
  profileId: input.profileId, datasetName: input.datasetName, backendId: input.backendId,
  exportId: input.exportId, operationId: input.operationId, generation: input.generation,
  digest: input.digest, targetGeneration: input.targetGeneration, targetDigest: input.targetDigest,
});
function exactTarget(value: NamespaceManagementTarget, input: NamespaceManagementInput) {
  assert.deepEqual(value, target(input));
  assert.ok(Object.isFrozen(value));
  assert.equal("ownerToken" in value, false);
  assert.equal("actorId" in value, false);
}
function exactResult(result: NamespaceManagementExecutionResult, input: NamespaceManagementInput) {
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.transactions));
  assert.equal(result.database, result.transactions.at(-1)?.result ?? null);
  assert.equal(JSON.stringify(result).includes(input.ownerToken), false);
  assert.equal(JSON.stringify(result).includes("owner_token_hash"), false);
}
async function history(id: string) {
  return (await pool.query(`SELECT
    (SELECT count(*)::text FROM durable_runtime.runtime_audit_events WHERE next_state->>'profileId'=$1::text) AS audit,
    (SELECT count(*)::text FROM durable_runtime.outbox_events WHERE aggregate_id=$1::uuid) AS outbox`, [id])).rows[0];
}
// Only synthetic faults over real PG clients; transaction SQL is never replaced.
// A hidden ACK follows a real COMMIT, then ROLLBACK response loss is simulated.
function wire(options: { hideCommitAt?: number; failReleaseAt?: number; failOutboxAt?: number;
  observations: { checkout: number; backendPid: number; command: string; hidden: boolean }[] }): Pool {
  let checkout = 0;
  const connect = pool.connect.bind(pool);
  return new Proxy(pool, { get(owner, key, receiver) {
    if (key !== "connect") { return Reflect.get(owner, key, receiver); }
    return async () => {
      const ordinal = ++checkout, client = await connect(), query = client.query.bind(client);
      const backendPid = (await query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      return new Proxy(client, { get(source, method, originalReceiver) {
        if (method === "release") {
          return (destroy?: boolean) => {
            client.release(destroy);
            if (ordinal === options.failReleaseAt) { throw new Error("synthetic release failure"); }
          };
        }
        if (method !== "query") { return Reflect.get(source, method, originalReceiver); }
        return async (sql: string, values: unknown[] = []) => {
          if (ordinal === options.failOutboxAt && sql.startsWith("INSERT INTO durable_runtime.outbox_events")) {
            throw new DurableDatabaseError("NAMESPACE_SYNTHETIC_COMPLETE_ROLLBACK");
          }
          if (ordinal === options.hideCommitAt && sql === "ROLLBACK") { throw new Error("synthetic cleanup ACK loss"); }
          const result = await query(sql, values);
          if (sql === "COMMIT") {
            options.observations.push({ checkout: ordinal, backendPid, command: result.command,
              hidden: ordinal === options.hideCommitAt });
            if (ordinal === options.hideCommitAt) { throw new Error("synthetic COMMIT ACK loss"); }
          }
          return result;
        };
      } });
    };
  } });
}

await test("Namespace management execution: focused post-COMMIT adapter boundaries", async t => {
  const gates: ReturnType<typeof deferred>[] = [];
  t.after(async () => { for (const gate of gates) { gate.resolve(); } await pool.end(); });
  const firstIdentity = await identity(); // Same Pool actual system/OID/dataset before seed.
  const migrations = await readMigrations(migrationsPath);
  assert.equal(migrations.length, 23);
  const ledgerBefore = (await pool.query("SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version")).rows;
  assert.equal(ledgerBefore.length, 23);
  assert.deepEqual(ledgerBefore.map(row => [row.version, row.checksum]), migrations.map(row => [row.version, row.checksum]));
  const originals = await rowHashes();
  const profiles = ["held", "concurrent", "mismatch", "throw", "begin-ack", "claim-ack", "complete-ack",
    "cleanup", "complete-rollback", "capture", "invalid"].map(profile);
  const seedIdentity = await identity();
  await withDurableTransaction(pool, async tx => {
    for (const item of profiles) {
      await tx.query("INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2)", [item.backendId, item.exportId]);
    }
  });
  for (const item of profiles) { committed(await registerNamespaceProfile(pool, item), "REGISTERED"); }
  const inputs = profiles.map(management);
  const [heldInput, concurrentInput, mismatchInput, throwInput, beginAckInput, claimAckInput,
    completeAckInput, cleanupInput, rollbackInput, captureInput, invalidInput] = inputs;
  const observations: { checkout: number; backendPid: number; command: string; hidden: boolean }[] = [];
  let applyCalls = 0, lookupCalls = 0;
  const appliedPort: TrustedNamespaceManagementPort = {
    async apply(value) {
      assert.equal(this, appliedPort);
      applyCalls++;
      return { status: "APPLIED", ...value };
    },
    async lookup(value) {
      assert.equal(this, appliedPort);
      lookupCalls++;
      return { status: "APPLIED", ...value };
    },
  };

  const pin = { ...profiles[0], pinId: randomUUID(), ownerToken: `synthetic-owner-secret:${randomUUID()}` };
  committed(await acquireNamespaceHold(pool, pin), "ACQUIRED");
  const waiting = await executeNamespaceManagement(pool, heldInput, appliedPort);
  committed(waiting.database!, "WAITING");
  assert.equal(waiting.effectAttempted, false);
  assert.equal(waiting.lookupAttempted, false);
  assert.equal(applyCalls + lookupCalls, 0);
  committed(await releaseNamespaceHold(pool, pin), "RELEASED");
  const completed = await executeNamespaceManagement(pool, heldInput, appliedPort);
  committed(completed.database!, "COMPLETED");
  assert.equal(completed.rereadRequired, false);
  assert.deepEqual(completed.transactions.map(step => step.phase), ["BEGIN", "CLAIM", "COMPLETE"]);
  assert.equal(applyCalls, 1);
  assert.deepEqual(completed.observation, { status: "APPLIED", ...target(heldInput) });
  assert.ok(Object.isFrozen(completed.observation));
  exactResult(completed, heldInput);
  const replayHistory = await history(heldInput.profileId);
  committed((await executeNamespaceManagement(pool, heldInput, appliedPort)).database!, "ALREADY_COMPLETED");
  assert.equal(applyCalls + lookupCalls, 1);
  assert.deepEqual(await history(heldInput.profileId), replayHistory);

  // Competing invocations share no memory owner map. One actual DB claim wins;
  // the loser finishes lookup while the first external apply is still pending.
  const entered = deferred(), gate = deferred();
  gates.push(gate);
  let concurrentApply = 0, concurrentLookup = 0;
  const concurrentPort: TrustedNamespaceManagementPort = {
    async apply(value) {
      exactTarget(value, concurrentInput);
      concurrentApply++;
      // This original API takes the domain lock: it succeeds because the claim
      // transaction has already committed/released before the external callback.
      committed(await readNamespaceManagement(pool, concurrentInput), "LOOKUP_REQUIRED");
      entered.resolve();
      await gate.promise;
      return { status: "APPLIED", ...value };
    },
    async lookup(value) {
      exactTarget(value, concurrentInput);
      concurrentLookup++;
      return { status: "PENDING" };
    },
  };
  const competitors = [executeNamespaceManagement(pool, concurrentInput, concurrentPort),
    executeNamespaceManagement(pool, { ...concurrentInput }, concurrentPort)];
  await entered.promise;
  const pending = await Promise.race(competitors);
  assert.equal(pending.lookupAttempted, true);
  assert.equal(pending.effectAttempted, false);
  assert.deepEqual(pending.observation, { status: "PENDING" });
  assert.equal(pending.rereadRequired, true);
  gate.resolve();
  const competingResults = await Promise.all(competitors);
  assert.equal(concurrentApply, 1);
  assert.equal(concurrentLookup, 1);
  assert.equal(competingResults.filter(result => result.database?.disposition?.status === "COMPLETED").length, 1);
  for (const result of competingResults) { exactResult(result, concurrentInput); }

  const mismatch = await executeNamespaceManagement(pool, mismatchInput, {
    async apply(value) { return { status: "APPLIED", ...value, digest: hash("wrong-original-digest") }; },
    async lookup() { throw new Error("Unexpected lookup"); },
  });
  assert.equal(mismatch.effectError, "NAMESPACE_MANAGEMENT_RESULT_CONFLICT");
  assert.equal(mismatch.observation, null);
  committed(mismatch.database!, "EXECUTE");
  committed(await readNamespaceManagement(pool, mismatchInput), "LOOKUP_REQUIRED");
  const lookupOnly = await executeNamespaceManagement(pool, mismatchInput, appliedPort);
  assert.equal(lookupOnly.effectAttempted, false);
  assert.equal(lookupOnly.lookupAttempted, true);
  committed(lookupOnly.database!, "COMPLETED");
  exactResult(lookupOnly, mismatchInput);

  const thrown = await executeNamespaceManagement(pool, throwInput, {
    async apply() { throw new Error(throwInput.ownerToken); },
    async lookup() { throw new Error("Unexpected lookup"); },
  });
  assert.equal(thrown.effectError, "NAMESPACE_MANAGEMENT_PORT_FAILED");
  assert.equal(thrown.rereadRequired, true);
  committed(await readNamespaceManagement(pool, throwInput), "LOOKUP_REQUIRED");
  const deniedHold = await acquireNamespaceHold(pool, { ...profiles[3], pinId: randomUUID(), ownerToken: throwInput.ownerToken });
  assert.equal(deniedHold.database.ok, false);
  exactResult(thrown, throwInput);

  // Faults wrap actual PG commands; no fabricated transaction result is used.
  for (const [input, hideCommitAt, expectedPhase, durableStatus] of [
    [beginAckInput, 1, "BEGIN", "READY_TO_CLAIM"],
    [claimAckInput, 2, "CLAIM", "LOOKUP_REQUIRED"],
  ] as const) {
    const beforeCallbacks = applyCalls + lookupCalls;
    const unknown = await executeNamespaceManagement(wire({ hideCommitAt, observations }), input, appliedPort);
    assert.equal(unknown.database?.database.ok, false);
    assert.equal(unknown.database?.database.settlement, "UNCONFIRMED");
    assert.equal(unknown.database?.database.commitOutcome, "UNKNOWN");
    assert.equal(unknown.transactions.at(-1)?.phase, expectedPhase);
    assert.equal(unknown.rereadRequired, true);
    assert.equal(applyCalls + lookupCalls, beforeCallbacks);
    committed(await readNamespaceManagement(pool, input), durableStatus);
    exactResult(unknown, input);
  }
  const beforeCleanup = applyCalls + lookupCalls;
  const cleanup = await executeNamespaceManagement(wire({ failReleaseAt: 1, observations }), cleanupInput, appliedPort);
  assert.equal(cleanup.database?.database.ok, true);
  assert.equal(cleanup.database?.database.cleanupFailed, true);
  assert.equal(cleanup.effectAttempted, false);
  assert.equal(cleanup.lookupAttempted, false);
  assert.equal(applyCalls + lookupCalls, beforeCleanup);
  committed(await readNamespaceManagement(pool, cleanupInput), "READY_TO_CLAIM");

  const completeUnknown = await executeNamespaceManagement(wire({ hideCommitAt: 3, observations }), completeAckInput, appliedPort);
  assert.equal(completeUnknown.effectAttempted, true);
  assert.equal(completeUnknown.observation?.status, "APPLIED");
  assert.equal(completeUnknown.database?.database.settlement, "UNCONFIRMED");
  assert.equal(completeUnknown.database?.database.commitOutcome, "UNKNOWN");
  assert.equal(completeUnknown.transactions.at(-1)?.phase, "COMPLETE");
  assert.equal(completeUnknown.rereadRequired, true);
  committed(await readNamespaceManagement(pool, completeAckInput), "ALREADY_COMPLETED");
  const callbacksBeforeUnknownReplay = applyCalls + lookupCalls;
  committed((await executeNamespaceManagement(pool, completeAckInput, appliedPort)).database!, "ALREADY_COMPLETED");
  assert.equal(applyCalls + lookupCalls, callbacksBeforeUnknownReplay);
  exactResult(completeUnknown, completeAckInput);

  const completeRollback = await executeNamespaceManagement(wire({ failOutboxAt: 3, observations }), rollbackInput, appliedPort);
  assert.equal(completeRollback.observation?.status, "APPLIED");
  assert.equal(completeRollback.database?.database.ok, false);
  assert.equal(completeRollback.database?.database.settlement, "ROLLED_BACK");
  committed(await readNamespaceManagement(pool, rollbackInput), "LOOKUP_REQUIRED");
  exactResult(completeRollback, rollbackInput);

  // Mutate DTO, Pool connect property, and port methods during the first await.
  // Previously captured receivers/methods and the original tuple must survive.
  const captureGate = deferred(), captureEntered = deferred();
  gates.push(captureGate);
  let connectChanged = false;
  const connect = pool.connect.bind(pool);
  const capturedConnect = async () => { captureEntered.resolve(); await captureGate.promise; return connect(); };
  const capturePool = new Proxy(pool, { get(owner, key, receiver) {
    if (key === "connect") {
      return connectChanged ? async () => { throw new Error("Changed connect must not run"); } : capturedConnect;
    }
    return Reflect.get(owner, key, receiver);
  } });
  const mutableInput = { ...captureInput };
  let capturedApply = 0;
  const mutablePort: TrustedNamespaceManagementPort = {
    async apply(value) { assert.equal(this, mutablePort); exactTarget(value, captureInput); capturedApply++; return { status: "APPLIED", ...value }; },
    async lookup() { throw new Error("Unexpected lookup"); },
  };
  const capturing = executeNamespaceManagement(capturePool, mutableInput, mutablePort);
  await captureEntered.promise;
  Object.assign(mutableInput, { profileId: randomUUID(), ownerToken: "changed-invalid-token", targetDigest: hash("changed") });
  Object.assign(mutablePort, { apply: async () => { throw new Error("Changed apply must not run"); },
    lookup: async () => { throw new Error("Changed lookup must not run"); } });
  connectChanged = true;
  captureGate.resolve();
  const captured = await capturing;
  committed(captured.database!, "COMPLETED");
  assert.equal(capturedApply, 1);
  exactResult(captured, captureInput);

  const beforeInvalid = applyCalls + lookupCalls;
  const invalid = await executeNamespaceManagement(pool, { ...invalidInput, ownerToken: "short" }, appliedPort);
  assert.equal(invalid.database, null);
  assert.equal(invalid.databaseError?.code, "NAMESPACE_TOKEN_INVALID");
  assert.equal(invalid.rereadRequired, true);
  assert.equal(applyCalls + lookupCalls, beforeInvalid);

  const ledgerAfter = (await pool.query("SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version")).rows;
  assert.deepEqual(ledgerAfter, ledgerBefore);
  retained(originals, await rowHashes());
  const summaries = (await pool.query<{ body: string }>(`SELECT next_state::text AS body
    FROM durable_runtime.runtime_audit_events WHERE next_state->>'profileId'=ANY($1::text[])`,
  [profiles.map(item => item.profileId)])).rows;
  for (const row of summaries) {
    assert.equal(row.body.includes("ownerToken"), false);
    assert.equal(row.body.includes("owner_token_hash"), false);
    assert.equal(row.body.includes("synthetic-owner-secret"), false);
  }
  const finalIdentity = await identity();
  t.diagnostic(JSON.stringify({ firstIdentity, seedIdentity, finalIdentity, ledgerBefore: 23, ledgerAfter: 23,
    originalRowsRetained: true, concurrentApply, concurrentLookup, observedCommands: observations,
    physicalNamespacePinVerified: false, actualAdapterUsed: false, liveManagementMutation: false,
    ackFault: "synthetic ACK/cleanup loss over actual PG COMMIT", callbackCount: 1 }));
});
