import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { QueryResultRow } from "pg";
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from "../db/connection.ts";
import { readMigrations } from "../db/migrate.ts";
import { counter, logicalId } from "../../../shared/durable-runtime/identity.ts";
import type { StorageEvidenceAuthority, VerifiedDirectoryEvidence } from "../storage/evidence.ts";
import type { AgentPodCreateObservation } from "../lifecycle/agent-pod-create-types.ts";
import { createAgentPodPlanner } from "./agent-pod-plan.ts";
import { recordAgentPodPlan } from "./agent-pod-plan-records.ts";
import { reserveInitialAgentAttempt } from "./initial-agent-attempt.ts";
import type { InitialAgentAttemptInput } from "./initial-agent-attempt.ts";
import { LockedGatewayAuthority } from "./gateway/authority.ts";
import { submitCommand, originalIdentity } from "./gateway/store.ts";
import { claimCommand } from "./gateway/claim.ts";
import { inputDigest } from "./gateway/input.ts";
import type { PayloadHash } from "./runtime-evidence.ts";
import type { GatewayContext, VerifiedControllerIdentity, ExecutorId } from "./gateway/types.ts";
import { assignInitialAgentPod, readInitialAgentPodAssignmentTarget } from "./initial-agent-pod-assignment.ts";
import type { InitialAgentPodAssignmentInput } from "./initial-agent-pod-assignment.ts";

// Root supplies an existing isolated ledger23 DB later. This fixture uses only
// synthetic prepared directory/controller identities and API object observations.
// It has no physical issuer, Pod call, gate release, DDL, reset or live mutation.
const database = process.env.ORCA_INITIAL_POD_ASSIGNMENT_DATABASE;
const oid = process.env.ORCA_INITIAL_POD_ASSIGNMENT_DATABASE_OID;
const migrationPath = process.env.ORCA_INITIAL_POD_ASSIGNMENT_MIGRATIONS;
if (process.env.ORCA_INITIAL_POD_ASSIGNMENT_APPROVED !== "root-first-verification" ||
    !database || database === "orca_dev" || !/^orca_[a-z0-9_]+$/u.test(database) || process.env.PGDATABASE !== database ||
    !oid || !/^[1-9][0-9]*$/u.test(oid) || !migrationPath) {
  throw new Error("Root-approved existing isolated ledger23 database/OID/migrations required");
}
const pool = createDurablePool({ database, max: 4, application_name: "initial-pod-assignment-first" });
const dataset = "orca-1012-dev-v1", scope = `synthetic-assignment:${randomUUID()}`, owner = `synthetic-owner:${randomUUID()}`;
// SAFETY: test-only nominal controller identity; no authenticated issuer.
const controller = Object.freeze({ scope, owner, term: counter("controller-term", "1") }) as VerifiedControllerIdentity;
const directories = new Map<string, VerifiedDirectoryEvidence>();
const authority: StorageEvidenceAuthority = Object.freeze({
  directory(ref: string) { return directories.get(ref) ?? null; },
  directoryPinValid(evidence: VerifiedDirectoryEvidence) { return directories.get(evidence.evidenceRef) === evidence; },
  mount() { return null; }, mountPinValid() { return false; }, executionTarget() { return null; }, executionTargetPinValid() { return false; },
  permanentComputeStop() { return null; }, computeStopPinValid() { return false; },
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function identity() {
  const row = (await pool.query<{ database: string; oid: string; system: string; backend_pid: number }>(`SELECT current_database() AS database,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system,pg_backend_pid() AS backend_pid`)).rows[0];
  assert.equal(row.database, database); assert.equal(row.oid, oid); assert.equal(row.system, "7696101282789175327");
  assert.deepEqual((await pool.query("SELECT dataset_name FROM durable_runtime.dataset_metadata")).rows,
    [{ dataset_name: dataset }]);
  return row;
}
const originalTables = ["dataset_metadata", "controller_leases", "runtime_units", "operations", "resource_profiles", "attempts",
  "execution_grants", "storage_domains", "storage_bindings", "storage_write_grants", "storage_mounts", "agents", "workspaces",
  "sessions", "runtime_members", "runtime_member_storage_bindings", "runtime_commands", "runtime_command_history",
  "agent_pod_plans", "runtime_audit_events", "outbox_events"] as const;
async function rowHashes() {
  const rows: Record<string, string[]> = {};
  for (const table of originalTables) {
    rows[table] = (await pool.query<{ body: string }>(`SELECT to_jsonb(t)::text AS body FROM durable_runtime.${table} t`)).rows.map(row => hash(row.body)).sort();
  }
  return rows;
}

// Narrow reuse of the reviewed initial reservation seed: real plan/claim/core,
// new UUIDs/domain per case; no old rows or immutable triggers are modified.
async function seed() {
  const unit = logicalId("runtime-unit", randomUUID()), operation = logicalId("operation", randomUUID());
  const attempt = randomUUID(), agent = randomUUID(), workspace = randomUUID(), session = randomUUID();
  const exportId = `synthetic-assignment-export:${randomUUID()}`;
  const bindings = ["home", "project", "reference"].map((key, index) => {
    const bindingId = randomUUID(), leafId = randomUUID();
    return { key, bindingId, leafId, mode: index === 2 ? "RO" as const : "RW" as const,
      claimName: `protected-${leafId}`, claimUid: `claim-${leafId}`, pvUid: `consumer-pv-${leafId}`,
      serverPath: `/exports/runtime-domains/${dataset}/${leafId}` };
  });
  const context: GatewayContext = Object.freeze({ runtimeUnitId: unit, operationId: operation, controller });
  const policy = { namespace: "initial-assignment-fixture", dataset, image: `example.invalid/agent@sha256:${"1".repeat(64)}`,
    entrypoint: { command: ["/usr/local/bin/node"], args: ["-e", "setInterval(() => {}, 3600000)"] },
    nfsServer: "nfs.fixture.svc.cluster.local",
    paths: { home: "/agent/home", claudeState: "/agent/home/.claude", codexState: "/agent/home/.codex", checkout: "/agent/project" },
    protectedExportRoot: `/exports/runtime-domains/${dataset}`,
    protectedMounts: bindings.map(b => ({ key: b.key, clientPath: `/agent/${b.key}` })),
    shared: { claimName: "shared-fixture", claimUid: "shared-claim", pvUid: "shared-pv", serverPath: `/exports/shared/${dataset}` } };
  const plan = createAgentPodPlanner(policy).plan({ identity: { unitId: unit, operationId: operation, attemptId: attempt,
    resourceName: `orca-unit-${operation}`, executionEpoch: "0", intentRevision: "0", specHash: "a".repeat(64) },
  protectedBindings: bindings, profile: { revision: "0", cpuMilli: 100, memoryMi: 128, ephemeralMi: 256, temporaryMi: 64 } });
  await identity(); // Same Pool actual system/OID/dataset immediately before the case seed.
  const created = await withDurableTransaction(pool, async tx => {
    await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT')", [unit]);
    await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0)", [unit]);
    await tx.query(`INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,execution_epoch,external_resource_name)
      VALUES($1,$2,'WAKE',0,$3,1,'ENSURE_ATTEMPT',0,$4)`, [operation, unit, scope, plan.identity.resourceName]);
    await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'codex')", [agent]);
    await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'synthetic assignment','READY')", [workspace, `assignment:${workspace}`]);
    await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [session, agent, workspace]);
    await tx.query("INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES('assignment-fixture',$1)", [exportId]);
    for (const b of bindings) {
      const ref = `synthetic-assignment-directory:${b.bindingId}`;
      // SAFETY: synthetic prepared evidence; this cast is not a physical issuer.
      const evidence = Object.freeze({ evidenceRef: ref, topologyPinId: `synthetic-pin:${b.bindingId}`,
        candidate: Object.freeze({ domain: Object.freeze({ backendId: "assignment-fixture", exportId, pvUid: `server-ssd-${exportId}` }),
          canonicalDirectory: `/${dataset}/${b.leafId}`, podUid: "synthetic-nfs", generation: "synthetic-1", device: "123", inode: "456" }) }) as VerifiedDirectoryEvidence;
      directories.set(ref, evidence);
      await tx.query(`INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,identity_proof_ref,identity_verified_at,access_state)
        VALUES($1,'assignment-fixture',$2,$3,$4,clock_timestamp(),'VERIFIED')`, [b.bindingId, exportId, `/${dataset}/${b.leafId}`, ref]);
    }
    await tx.query("INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)", [unit, session, bindings[0].bindingId]);
    for (const b of bindings.slice(1)) {
      await tx.query("INSERT INTO durable_runtime.runtime_member_storage_bindings(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)", [unit, session, b.bindingId]);
    }
    const stored = await recordAgentPodPlan(tx, context, plan), locked = await LockedGatewayAuthority.acquire(tx, context);
    const envelope = { operationId: operation, controllerTerm: controller.term, stepRevision: counter("step-revision", "0"),
      executionEpoch: plan.identity.executionEpoch, intentRevision: plan.identity.intentRevision,
      podTarget: "CREATE_WITHOUT_POD" as const, expectedPodUid: null };
    const input = { resourceName: plan.identity.resourceName,
      body: { mode: "COLD", planDigest: stored.record.planDigest, attemptId: attempt, resourceProfileRevision: "0" } };
    // SAFETY: actual SHA256 nominal input hash only; no workload authority.
    const submitted = await submitCommand(locked, { command: "ensureAttempt", envelope, input, inputHash: inputDigest(input) as PayloadHash, predecessor: { kind: "NONE" } });
    // SAFETY: fixture executor identity only; not authenticated workload identity.
    const claimed = await claimCommand(locked, originalIdentity(submitted.command), `synthetic-assignment-executor:${operation}` as ExecutorId);
    if (claimed.disposition !== "CLAIMED") { assert.fail("Original fixture command must be claimed"); }
    const request: InitialAgentAttemptInput = { claim: claimed.claim, planDigest: stored.record.planDigest,
      expectedUnitRevision: counter("row:runtime-unit", "0"), bindings: bindings.map(b => ({ bindingId: logicalId("storage-binding", b.bindingId),
        expectedRevision: counter("row:storage-binding", "0"), storageEpoch: counter("storage-epoch", "0") })) };
    return { request, record: stored.record };
  });
  const reservation = await withDurableTransaction(pool, tx => reserveInitialAgentAttempt(tx, context, created.request, authority));
  assert.equal(reservation.disposition, "RESERVED");
  return { context, request: created.request, record: created.record, reservation, plan, bindings };
}
type Fixture = Awaited<ReturnType<typeof seed>>;
function observation(f: Fixture): AgentPodCreateObservation {
  return { kind: "AGENT_POD_CREATE_OBSERVATION", disposition: "CREATED", planDigest: f.request.planDigest,
    namespace: f.plan.pod.metadata.namespace, name: f.plan.identity.resourceName,
    pod: { uid: `synthetic-observed-pod:${f.plan.identity.attemptId}`, resourceVersion: "first-observed-rv",
      desiredResources: structuredClone(f.plan.pod.spec.containers[0].resources),
      admittedResources: { requests: { cpu: "150m", memory: "192Mi", "ephemeral-storage": "256Mi" }, limits: { "ephemeral-storage": "256Mi" } } },
    postAttempts: 1, readinessObserved: false, physicalPinVerified: false };
}
async function snapshot(f: Fixture) {
  const id = f.context.runtimeUnitId, attempt = f.plan.identity.attemptId;
  const [unit, pod, operation, command, executions, grants, bindings, mounts, audit, outbox] = await Promise.all([
    pool.query("SELECT * FROM durable_runtime.runtime_units WHERE id=$1", [id]),
    pool.query("SELECT * FROM durable_runtime.attempts WHERE runtime_unit_id=$1", [id]),
    pool.query("SELECT * FROM durable_runtime.operations WHERE id=$1", [f.context.operationId]),
    pool.query("SELECT * FROM durable_runtime.runtime_commands WHERE id=$1", [f.request.claim.commandId]),
    pool.query("SELECT * FROM durable_runtime.execution_grants WHERE runtime_unit_id=$1 ORDER BY id", [id]),
    pool.query("SELECT * FROM durable_runtime.storage_write_grants WHERE attempt_id=$1 ORDER BY id", [attempt]),
    pool.query("SELECT * FROM durable_runtime.storage_bindings WHERE id=ANY($1::uuid[]) ORDER BY id", [f.bindings.map(b => b.bindingId)]),
    pool.query("SELECT * FROM durable_runtime.storage_mounts WHERE attempt_id=$1", [attempt]),
    pool.query("SELECT * FROM durable_runtime.runtime_audit_events WHERE runtime_unit_id=$1 ORDER BY id", [id]),
    pool.query("SELECT * FROM durable_runtime.outbox_events WHERE aggregate_id=$1 ORDER BY id", [id]),
  ]);
  return { unit: unit.rows, attempt: pod.rows, operation: operation.rows, command: command.rows, executions: executions.rows,
    grants: grants.rows, bindings: bindings.rows, mounts: mounts.rows, audit: audit.rows, outbox: outbox.rows };
}
async function rejected(f: Fixture, input: InitialAgentPodAssignmentInput, expectedCode: string, context = f.context) {
  const before = await snapshot(f);
  await assert.rejects(withDurableTransaction(pool, tx => assignInitialAgentPod(tx, context, input)),
    error => error instanceof DurableDatabaseError && error.code === expectedCode);
  assert.deepEqual(await snapshot(f), before);
}

await test("Initial Pod assignment: original UID/resources and closed gate transaction boundaries", async t => {
  t.after(() => pool.end());
  const firstIdentity = await identity(), migrations = await readMigrations(migrationPath);
  assert.equal(migrations.length, 23);
  const ledger = (await pool.query("SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version")).rows;
  assert.deepEqual(ledger.map(row => [row.version, row.checksum]), migrations.map(row => [row.version, row.checksum]));
  const originals = await rowHashes();
  await withDurableTransaction(pool, async tx => {
    await tx.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,$2,1,clock_timestamp()+interval '10 minutes')", [scope, owner]);
  });
  const f = await seed(), observed = observation(f), input = { claim: f.request.claim, planDigest: f.request.planDigest, observation: observed };
  const before = await snapshot(f);
  const target = await withDurableTransaction(pool, tx => readInitialAgentPodAssignmentTarget(tx, f.context, input));
  assert.deepEqual(target.record, f.record);
  assert.equal(target.status, "RESERVED"); assert.equal(target.podUid, null);
  assert.deepEqual(await snapshot(f), before); // Shared lookup validator performs no mutation.
  const assigned = await withDurableTransaction(pool, tx => assignInitialAgentPod(tx, f.context, input));
  assert.equal(assigned.disposition, "ASSIGNED"); assert.equal(assigned.visibility, "TRANSACTION_LOCAL");
  assert.equal(assigned.unitRevision, "2"); assert.equal(assigned.podUid, observed.pod!.uid);
  assert.equal(assigned.resourceVersion, "first-observed-rv"); assert.equal(assigned.gate, "CLOSED");
  assert.equal(assigned.providerReady, false); assert.equal(assigned.writerGrantActivated, false);
  const after = await snapshot(f);
  assert.equal(after.attempt[0].status, "POD_ASSIGNED"); assert.equal(after.attempt[0].pod_uid, observed.pod!.uid);
  assert.deepEqual(after.attempt[0].effective_resources, observed.pod!.admittedResources);
  assert.equal(after.attempt[0].incarnation, null); assert.equal(after.attempt[0].ready_at, null);
  assert.equal(after.attempt[0].started_at, null); assert.equal(after.attempt[0].stopped_at, null);
  assert.equal(after.unit[0].phase, "PROVISIONING"); assert.equal(after.unit[0].revision, "2");
  for (const field of ["executions", "grants", "bindings", "mounts", "command", "operation"] as const) {
    assert.deepEqual(after[field], before[field]);
  }
  assert.equal(after.audit.length, before.audit.length + 1); assert.equal(after.outbox.length, before.outbox.length + 1);
  const assignmentAudit = after.audit.find(row => row.kind === "INITIAL_AGENT_POD_ASSIGNED");
  assert.ok(assignmentAudit);
  assert.deepEqual(assignmentAudit.next_state.desiredResources, observed.pod!.desiredResources);
  assert.deepEqual(assignmentAudit.next_state.admittedResources, observed.pod!.admittedResources);
  const replayObservation = { ...observed, disposition: "FOUND" as const,
    pod: { ...observed.pod!, resourceVersion: "new-get-rv" }, postAttempts: 0 as const };
  const replay = await withDurableTransaction(pool, tx => assignInitialAgentPod(tx, f.context, { ...input, observation: replayObservation }));
  assert.deepEqual(replay, { ...assigned, disposition: "REPLAYED" });
  assert.deepEqual(await snapshot(f), after);
  const assignedTarget = await withDurableTransaction(pool, tx => readInitialAgentPodAssignmentTarget(tx, f.context, input));
  assert.equal(assignedTarget.status, "POD_ASSIGNED"); assert.equal(assignedTarget.podUid, assigned.podUid);
  assert.deepEqual(assignedTarget.record, f.record);
  await rejected(f, { ...input, observation: { ...observed, pod: { ...observed.pod!, uid: "other-pod" } } }, "INITIAL_AGENT_POD_ASSIGNMENT_CONFLICT");
  await rejected(f, { ...input, observation: { ...observed, pod: { ...observed.pod!, admittedResources: { requests: { cpu: "999m" } } } } }, "INITIAL_AGENT_POD_ASSIGNMENT_CONFLICT");

  const invalid = await seed(), invalidObserved = observation(invalid);
  const invalidInput = { claim: invalid.request.claim, planDigest: invalid.request.planDigest, observation: invalidObserved };
  for (const disposition of ["ABSENT", "UNKNOWN", "CONFLICT"] as const) {
    await rejected(invalid, { ...invalidInput, observation: { ...invalidObserved, disposition, pod: null } }, "INITIAL_AGENT_POD_OBSERVATION");
  }
  await rejected(invalid, { ...invalidInput, observation: { ...invalidObserved, namespace: "other-namespace" } }, "INITIAL_AGENT_POD_OBSERVATION_CONFLICT");
  await rejected(invalid, { ...invalidInput, observation: { ...invalidObserved, name: "other-name" } }, "INITIAL_AGENT_POD_OBSERVATION_CONFLICT");
  await rejected(invalid, { ...invalidInput, observation: { ...invalidObserved, pod: { ...invalidObserved.pod!, uid: "" } } }, "INITIAL_AGENT_POD_OBSERVATION");
  await rejected(invalid, { ...invalidInput, observation: { ...invalidObserved, pod: { ...invalidObserved.pod!, desiredResources: {} } } }, "INITIAL_AGENT_POD_OBSERVATION_CONFLICT");
  await rejected(invalid, { ...invalidInput, planDigest: "0".repeat(64) }, "INITIAL_AGENT_POD_PLAN");
  await rejected(invalid, { ...invalidInput, claim: { ...invalidInput.claim, executionToken: logicalId("runtime-command-execution", randomUUID()) } }, "INITIAL_AGENT_POD_CLAIM");
  await rejected(invalid, invalidInput, "COMMAND_AUTHORITY_STALE", {
    ...invalid.context, controller: Object.freeze({ ...controller, owner: "stale-controller-owner" }),
  });

  const partial = await seed(), partialObserved = observation(partial);
  // Fixture-owned grant only: leave one grant REVOKING rather than delete an
  // immutable history row. It cannot be accepted as the full RESERVED set.
  await pool.query("UPDATE durable_runtime.storage_write_grants SET state='REVOKING',revision=revision+1 WHERE id=$1", [partial.reservation.storageGrants[0].grantId]);
  await rejected(partial, { claim: partial.request.claim, planDigest: partial.request.planDigest, observation: partialObserved }, "INITIAL_AGENT_POD_GRANTS");

  const rolled = await seed(), rolledBefore = await snapshot(rolled);
  await assert.rejects(withDurableTransaction(pool, async tx => {
    await assignInitialAgentPod(tx, rolled.context, { claim: rolled.request.claim, planDigest: rolled.request.planDigest, observation: observation(rolled) });
    throw new DurableDatabaseError("SYNTHETIC_ASSIGNMENT_ROLLBACK");
  }), error => error instanceof DurableDatabaseError && error.code === "SYNTHETIC_ASSIGNMENT_ROLLBACK");
  assert.deepEqual(await snapshot(rolled), rolledBefore);

  const captured = await seed(), mutable = structuredClone({ claim: captured.request.claim,
    planDigest: captured.request.planDigest, observation: observation(captured) });
  const capturedResult = await withDurableTransaction(pool, async tx => {
    const originalQuery = tx.query, query = originalQuery.bind(tx), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    tx.query = async function<Row extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []) {
      entered.resolve(); await gate.promise; return query<Row>(sql, values);
    };
    const pending = assignInitialAgentPod(tx, captured.context, mutable);
    const settled = pending.then(() => undefined, () => undefined);
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error("Fixture assignment ended before expected boundary"); })]);
      tx.query = originalQuery; // Restore borrowed receiver before later lock/helper queries.
      Object.assign(mutable, { planDigest: "0".repeat(64) });
      Object.assign(mutable.claim, { executionToken: logicalId("runtime-command-execution", randomUUID()) });
      Object.assign(mutable.observation, { namespace: "changed", name: "changed" });
      Object.assign(mutable.observation.pod!, { uid: "changed", desiredResources: {}, admittedResources: {} });
      gate.resolve();
      return await pending;
    } finally {
      tx.query = originalQuery;
      gate.resolve();
      await settled;
    }
  });
  assert.equal(capturedResult.disposition, "ASSIGNED");
  assert.equal(capturedResult.podUid, observation(captured).pod!.uid);
  assert.deepEqual((await snapshot(captured)).attempt[0].effective_resources, observation(captured).pod!.admittedResources);

  const originalHashesAfter = await rowHashes();
  for (const table of originalTables) {
    const counts = new Map<string, number>();
    for (const digest of originalHashesAfter[table]) { counts.set(digest, (counts.get(digest) ?? 0) + 1); }
    for (const digest of originals[table]) {
      assert.ok((counts.get(digest) ?? 0) > 0, `Original ${table} row missing`);
      counts.set(digest, counts.get(digest)! - 1);
    }
  }
  assert.deepEqual((await pool.query("SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version")).rows, ledger);
  // Only fixed IDs/resources are stored; claim tokens and complete Pod bytes are absent.
  const eventBodies = (await pool.query<{ body: string }>("SELECT next_state::text AS body FROM durable_runtime.runtime_audit_events WHERE kind='INITIAL_AGENT_POD_ASSIGNED' AND runtime_unit_id=ANY($1::uuid[])",
    [[f.context.runtimeUnitId, captured.context.runtimeUnitId]])).rows;
  for (const row of eventBodies) {
    assert.equal(row.body.includes("executionToken"), false); assert.equal(row.body.includes("commandId"), true);
    assert.equal(row.body.includes("containers"), false);
  }
  t.diagnostic(JSON.stringify({ firstIdentity, finalIdentity: await identity(), ledgerBefore: 23, ledgerAfter: 23,
    originalRowsRetained: true, callbackCount: 1, actualPodCalls: 0, physicalIssuer: false, providerReady: false,
    writerGrantActivated: false, gate: "CLOSED", ddl: 0, syntheticObservations: true }));
});
