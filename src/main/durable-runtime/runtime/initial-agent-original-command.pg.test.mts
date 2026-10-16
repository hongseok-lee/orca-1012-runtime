import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
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
import { claimCommand, markCommandUnknown } from "./gateway/claim.ts";
import { inputDigest } from "./gateway/input.ts";
import type { PayloadHash } from "./runtime-evidence.ts";
import type { GatewayContext, VerifiedControllerIdentity, ExecutorId, CommandRow } from "./gateway/types.ts";
import { assignInitialAgentPod, assignInitialAgentPodLookup, readInitialAgentPodLookupTarget } from "./initial-agent-pod-assignment.ts";
import { CONTROLLER_SCOPE, ControllerInstance, type LeaseRecord } from "../ha/instance.ts";
import { tryAcquireControllerLease, releaseControllerLease } from "../ha/lease.ts";
import { prepareReconcileStep } from "../lifecycle/controller.ts";

// Source-only first fixture. Root supplies the existing isolated ledger23 DB.
// Real lease/operation/command APIs are used; nominal controller/directory
// identities and Pod observations below are explicitly synthetic, not live proof.
const database = process.env.ORCA_INITIAL_ORIGINAL_COMMAND_DATABASE;
const oid = process.env.ORCA_INITIAL_ORIGINAL_COMMAND_DATABASE_OID;
const migrationPath = process.env.ORCA_INITIAL_ORIGINAL_COMMAND_MIGRATIONS;
const leaseEvidencePath = process.env.ORCA_INITIAL_ORIGINAL_COMMAND_LEASE_EVIDENCE;
if (process.env.ORCA_INITIAL_ORIGINAL_COMMAND_APPROVED !== "root-first-verification" ||
    !database || database === "orca_dev" || !/^orca_[a-z0-9_]+$/u.test(database) || process.env.PGDATABASE !== database ||
    !oid || !/^[1-9][0-9]*$/u.test(oid) || !migrationPath || !leaseEvidencePath) {
  throw new Error("Root-approved existing isolated ledger23 database/OID/migrations/lease evidence required");
}
const pool = createDurablePool({ database, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 5000,
  application_name: "initial-original-command-first" });
const dataset = "orca-1012-dev-v1";
const directories = new Map<string, VerifiedDirectoryEvidence>();
const authority: StorageEvidenceAuthority = Object.freeze({
  directory(ref: string) { return directories.get(ref) ?? null; },
  directoryPinValid(evidence: VerifiedDirectoryEvidence) { return directories.get(evidence.evidenceRef) === evidence; },
  mount() { return null; }, mountPinValid() { return false; }, executionTarget() { return null; }, executionTargetPinValid() { return false; },
  permanentComputeStop() { return null; }, computeStopPinValid() { return false; },
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function identity() {
  return withDurableTransaction(pool, async tx => {
    const row = (await tx.query<{ database: string; oid: string; system: string; backend_pid: number }>(`SELECT current_database() AS database,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
      (SELECT system_identifier::text FROM pg_control_system()) AS system,pg_backend_pid() AS backend_pid`)).rows[0];
    assert.equal(row.database, database); assert.equal(row.oid, oid); assert.equal(row.system, "7696101282789175327");
    assert.deepEqual((await tx.query("SELECT dataset_name FROM durable_runtime.dataset_metadata")).rows, [{ dataset_name: dataset }]);
    return row;
  });
}
// Root permits only the fixed control row's normal acquire/release transitions.
// Preserve every other pre-existing row; retain its original control metadata
// privately rather than treating a legitimate lease transition as an unchanged row.
const originalTables = ["dataset_metadata", "runtime_units", "operations", "resource_profiles", "attempts",
  "execution_grants", "storage_domains", "storage_bindings", "storage_write_grants", "storage_mounts", "agents", "workspaces",
  "sessions", "runtime_members", "runtime_member_storage_bindings", "runtime_commands", "runtime_command_history",
  "agent_pod_plans", "runtime_audit_events", "outbox_events", "rpc_receipts"] as const;
async function rowHashes() {
  const rows: Record<string, string[]> = {};
  for (const table of originalTables) {
    rows[table] = (await pool.query<{ body: string }>(`SELECT to_jsonb(t)::text AS body FROM durable_runtime.${table} t`)).rows.map(row => hash(row.body)).sort();
  }
  return rows;
}

// Narrow reuse of the reviewed initial reservation seed: real plan/claim/core,
// new UUIDs/domain per case; no old rows or immutable triggers are modified.
async function seed(controller: VerifiedControllerIdentity) {
  const scope = controller.scope;
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
      VALUES($1,$2,'WAKE',0,$3,$5,'ENSURE_ATTEMPT',0,$4)`, [operation, unit, scope, plan.identity.resourceName, controller.term]);
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
    assert.equal(submitted.disposition, "ACCEPTED");
    return { command: submitted.command, record: stored.record };
  });
  return { context, record: created.record, command: created.command, plan, bindings };
}
type Fixture = Awaited<ReturnType<typeof seed>>;
function contextFor(f: Fixture, controller: VerifiedControllerIdentity): GatewayContext {
  return Object.freeze({ ...f.context, controller });
}
async function adopt(f: Fixture, controller: VerifiedControllerIdentity) {
  const context = contextFor(f, controller);
  const prepared = await prepareReconcileStep(pool, { context, mutationKey: randomUUID(),
    expectedUnitRevision: counter("row:runtime-unit", "1"), expectedIntentRevision: counter("intent-revision", "0"),
    expectedStepRevision: counter("step-revision", "0"), step: "ENSURE_ATTEMPT",
    // SAFETY: nominal fixture executor only; a pending original must not issue a claim.
    executorId: `synthetic-original-lookup:${f.context.operationId}` as ExecutorId, input: { lookupOnlyFixture: true } });
  assert.equal(prepared.mutation.status, "COMMITTED");
  if (prepared.mutation.status !== "COMMITTED") { assert.fail("Real adoption must commit"); }
  assert.deepEqual(prepared.mutation.receipt.response, { disposition: "LOOKUP_ORIGINAL", commandId: f.command.id,
    state: f.command.state });
  assert.deepEqual(prepared.execution, { disposition: "NO_EXECUTION", reason: "LOOKUP_ORIGINAL" });
  return context;
}
async function claimAndReserve(f: Fixture, controller: VerifiedControllerIdentity) {
  const context = await adopt(f, controller);
  const request = await withDurableTransaction(pool, async tx => {
    const locked = await LockedGatewayAuthority.acquire(tx, context);
    // SAFETY: fixture executor identity, not authenticated provider identity.
    const claimed = await claimCommand(locked, originalIdentity(f.command), `synthetic-original-executor:${f.command.id}` as ExecutorId);
    if (claimed.disposition !== "CLAIMED") { assert.fail("Original command must be claimed exactly once"); }
    const input: InitialAgentAttemptInput = { claim: claimed.claim, planDigest: f.record.planDigest,
      expectedUnitRevision: counter("row:runtime-unit", "0"), bindings: f.bindings.map(b => ({ bindingId: logicalId("storage-binding", b.bindingId),
        expectedRevision: counter("row:storage-binding", "0"), storageEpoch: counter("storage-epoch", "0") })) };
    return input;
  });
  const reservation = await withDurableTransaction(pool, tx => reserveInitialAgentAttempt(tx, context, request, authority));
  assert.equal(reservation.disposition, "RESERVED");
  return { ...f, context, request, reservation, command: { ...f.command, state: "EXECUTING" as const } };
}
async function snapshot(f: Fixture) {
  const unit = f.context.runtimeUnitId, operation = f.context.operationId, command = f.command.id;
  const reads = {
    unit: ["SELECT * FROM durable_runtime.runtime_units WHERE id=$1", [unit]],
    operation: ["SELECT * FROM durable_runtime.operations WHERE id=$1", [operation]],
    command: ["SELECT * FROM durable_runtime.runtime_commands WHERE runtime_unit_id=$1 ORDER BY id", [unit]],
    history: ["SELECT * FROM durable_runtime.runtime_command_history WHERE command_id=$1 ORDER BY id", [command]],
    attempt: ["SELECT * FROM durable_runtime.attempts WHERE runtime_unit_id=$1 ORDER BY id", [unit]],
    execution: ["SELECT * FROM durable_runtime.execution_grants WHERE runtime_unit_id=$1 ORDER BY id", [unit]],
    storage: ["SELECT * FROM durable_runtime.storage_write_grants WHERE attempt_id=$1 ORDER BY id", [f.plan.identity.attemptId]],
    bindings: ["SELECT * FROM durable_runtime.storage_bindings WHERE id=ANY($1::uuid[]) ORDER BY id", [f.bindings.map(b => b.bindingId)]],
    mounts: ["SELECT * FROM durable_runtime.storage_mounts WHERE attempt_id=$1 ORDER BY id", [f.plan.identity.attemptId]],
    audit: ["SELECT * FROM durable_runtime.runtime_audit_events WHERE runtime_unit_id=$1 ORDER BY id", [unit]],
    outbox: ["SELECT * FROM durable_runtime.outbox_events WHERE aggregate_id=ANY($1::uuid[]) ORDER BY id", [[unit, operation]]],
    receipts: ["SELECT * FROM durable_runtime.rpc_receipts WHERE session_scope=$1 ORDER BY principal_id,operation_key", [`runtime-unit:${unit}`]],
  } as const;
  const result: Record<keyof typeof reads, unknown[]> = { unit: [], operation: [], command: [], history: [], attempt: [],
    execution: [], storage: [], bindings: [], mounts: [], audit: [], outbox: [], receipts: [] };
  for (const key of Object.keys(reads) as (keyof typeof reads)[]) {
    const [sql, values] = reads[key];
    result[key] = (await pool.query(sql, [...values])).rows;
  }
  return result;
}
async function rejectsUnchanged(f: Fixture, work: () => Promise<unknown>, code: string) {
  const before = await snapshot(f);
  await assert.rejects(work, error => error instanceof DurableDatabaseError && error.code === code);
  assert.deepEqual(await snapshot(f), before);
}
function found(f: Fixture): AgentPodCreateObservation {
  return { kind: "AGENT_POD_CREATE_OBSERVATION", disposition: "FOUND", planDigest: f.record.planDigest,
    namespace: f.plan.pod.metadata.namespace, name: f.plan.identity.resourceName,
    pod: { uid: `synthetic-found:${f.plan.identity.attemptId}`, resourceVersion: "synthetic-get-1",
      desiredResources: structuredClone(f.plan.pod.spec.containers[0].resources),
      admittedResources: structuredClone(f.plan.pod.spec.containers[0].resources) },
    postAttempts: 0, readinessObserved: false, physicalPinVerified: false };
}
// Explicit nonproduction corruption seeds only on newly-created fixture IDs.
// No existing execution/history is changed, deleted or hidden; no trigger is disabled.
// These rows are never claimed/reserved/executed through the normal path.
async function syntheticHistory(f: Fixture, controller: VerifiedControllerIdentity,
  kind: "MISSING" | "MISMATCH" | "AMBIGUOUS") {
  const context = await adopt(f, controller), token = randomUUID(), executor = `synthetic-corrupt:${f.command.id}`;
  await withDurableTransaction(pool, async tx => {
    const locked = await LockedGatewayAuthority.acquire(tx, context);
    await locked.assertCurrent();
    assert.equal((await tx.query(`UPDATE durable_runtime.runtime_commands SET state='EXECUTING',executor_id=$2,
      execution_token=$3,claimed_at=clock_timestamp(),revision=revision+1 WHERE id=$1 AND state='ACCEPTED' RETURNING id`,
    [f.command.id, executor, token])).rowCount, 1);
    if (kind === "MISSING") { return; }
    for (let index = 0; index < (kind === "AMBIGUOUS" ? 2 : 1); index++) {
      await tx.query(`INSERT INTO durable_runtime.runtime_command_history(id,command_id,stage,controller_term,executor_id,execution_token)
        VALUES($1,$2,'EXECUTING',$3,$4,$5)`,
      [randomUUID(), f.command.id, controller.term, kind === "MISMATCH" ? `${executor}:wrong` : executor, token]);
    }
  });
  return context;
}

await test("Original initial command: distinct envelope/claim/current terms and lookup-only assignment", async t => {
  let active: { instance: ControllerInstance; lease: LeaseRecord } | null = null;
  t.after(async () => {
    try {
      if (active) {
        const released = await releaseControllerLease(pool, active.instance, active.lease);
        assert.equal(released.status, "RELEASED");
        active = null;
      }
    } finally { await pool.end(); }
  });
  const actual = await identity(), migrations = await readMigrations(migrationPath);
  assert.equal(migrations.length, 23);
  const ledger = (await pool.query("SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version")).rows;
  assert.deepEqual(ledger.map(row => [row.version, row.checksum]), migrations.map(row => [row.version, row.checksum]));
  const control = (await pool.query(`SELECT c.scope,c.owner,c.term,c.revision,c.expires_at,
    clock_timestamp() AS pg_clock,coalesce(c.expires_at>clock_timestamp(),false) AS unexpired
    FROM (SELECT 1) guard LEFT JOIN durable_runtime.controller_leases c ON c.scope=$1`, [CONTROLLER_SCOPE])).rows[0];
  await writeFile(leaseEvidencePath, `${JSON.stringify({ actual, control })}\n`, { flag: "wx", mode: 0o600 });
  assert.equal(control.unexpired, false, "Isolated control lease must be expired/absent; no forced expiry/reset");
  const originals = await rowHashes();
  async function nextController(): Promise<VerifiedControllerIdentity> {
    if (active) {
      const released = await releaseControllerLease(pool, active.instance, active.lease);
      assert.equal(released.status, "RELEASED"); active = null;
    }
    const instance = new ControllerInstance(CONTROLLER_SCOPE);
    const acquired = await tryAcquireControllerLease(pool, instance, { revision: "initial-original-command-fixture", durationMs: 60000 });
    assert.equal(acquired.status, "ACTIVE");
    if (acquired.status !== "ACTIVE") { assert.fail("Real isolated lease acquisition required"); }
    active = { instance, lease: acquired.lease };
    // SAFETY: fixture nominal identity from a real confirmed lease; not a production issuer.
    return Object.freeze({ scope: acquired.lease.scope, owner: acquired.lease.owner, term: acquired.lease.term }) as VerifiedControllerIdentity;
  }
  const first = await nextController();
  const f = await seed(first), unknown = await seed(first);
  const malformed: Fixture[] = [];
  for (let index = 0; index < 3; index++) { malformed.push(await seed(first)); }
  const claimant = await nextController();
  assert.equal(BigInt(claimant.term), BigInt(first.term) + 1n);
  const reserved = await claimAndReserve(f, claimant), unknownReserved = await claimAndReserve(unknown, claimant);
  assert.equal(reserved.request.claim.identity.originalEnvelope.controllerTerm, first.term);
  assert.equal(reserved.request.claim.controllerTerm, claimant.term);
  const originalCommand = (await snapshot(f)).command;
  const originalHistory = (await snapshot(f)).history;
  const reservationAudit = (await pool.query(`SELECT * FROM durable_runtime.runtime_audit_events
    WHERE runtime_unit_id=$1 AND kind='INITIAL_AGENT_ATTEMPT_RESERVED'`, [f.context.runtimeUnitId])).rows;
  assert.equal(reservationAudit.length, 1);
  const current = await nextController();
  assert.equal(BigInt(current.term), BigInt(claimant.term) + 1n);
  const context = await adopt(reserved, current), unknownContext = await adopt(unknownReserved, current);
  const input = { commandId: f.command.id, planDigest: f.record.planDigest };
  const before = await snapshot(f);
  const target = await withDurableTransaction(pool, tx => readInitialAgentPodLookupTarget(tx, context, input));
  assert.equal(target.status, "RESERVED"); assert.equal(target.podUid, null);
  assert.equal(target.gate, "CLOSED"); assert.equal(target.writerGrantActivated, false); assert.equal(target.providerReady, false);
  assert.equal(target.attemptId, f.plan.identity.attemptId); assert.deepEqual(target.record, f.record);
  for (const key of ["claim", "executorId", "executionToken", "controllerTerm"]) {
    assert.equal(Object.hasOwn(target, key), false);
  }
  assert.deepEqual(await snapshot(f), before); // No new command/token/attempt/grant/receipt or other write.
  await rejectsUnchanged(f, () => withDurableTransaction(pool, tx => readInitialAgentPodLookupTarget(tx, reserved.context, input)),
    "COMMAND_AUTHORITY_STALE");
  await rejectsUnchanged(f, () => withDurableTransaction(pool, tx => assignInitialAgentPod(tx, context,
    { claim: reserved.request.claim, planDigest: input.planDigest, observation: found(f) })), "INITIAL_AGENT_POD_INPUT");
  const observed = found(f);
  const assigned = await withDurableTransaction(pool, tx => assignInitialAgentPodLookup(tx, context, { ...input, observation: observed }));
  assert.equal(assigned.disposition, "ASSIGNED"); assert.equal(assigned.podUid, observed.pod!.uid);
  assert.equal(assigned.unitRevision, "2"); assert.equal(assigned.gate, "CLOSED");
  assert.equal(assigned.writerGrantActivated, false); assert.equal(assigned.providerReady, false);
  const after = await snapshot(f);
  for (const key of ["operation", "command", "history", "execution", "storage", "bindings", "mounts", "receipts"] as const) {
    assert.deepEqual(after[key], before[key]);
  }
  assert.equal(after.attempt.length, 1); assert.equal(after.audit.length, before.audit.length + 1);
  assert.equal(after.outbox.length, before.outbox.length + 1);
  const attempt = (await pool.query("SELECT * FROM durable_runtime.attempts WHERE id=$1", [f.plan.identity.attemptId])).rows[0];
  assert.equal(attempt.status, "POD_ASSIGNED"); assert.equal(attempt.incarnation, null);
  assert.equal(attempt.started_at, null); assert.equal(attempt.ready_at, null); assert.equal(attempt.stopped_at, null);
  const replay = await withDurableTransaction(pool, tx => assignInitialAgentPodLookup(tx, context, { ...input, observation: observed }));
  assert.deepEqual(replay, { ...assigned, disposition: "REPLAYED" }); assert.deepEqual(await snapshot(f), after);
  const command = (await pool.query<CommandRow>("SELECT * FROM durable_runtime.runtime_commands WHERE id=$1", [f.command.id])).rows[0];
  const old = originalCommand[0] as CommandRow;
  for (const key of ["original_controller_term", "step_revision", "pod_target", "expected_pod_uid", "execution_epoch",
    "intent_revision", "input_hash", "input", "executor_id", "execution_token", "accepted_at", "claimed_at", "state"] as const) {
    assert.deepEqual(command[key], old[key]);
  }
  assert.equal(command.owner_controller_term, current.term);
  const history = (await pool.query("SELECT * FROM durable_runtime.runtime_command_history WHERE command_id=$1", [f.command.id])).rows;
  for (const row of originalHistory) { assert.ok(history.some(item => hash(JSON.stringify(item)) === hash(JSON.stringify(row)))); }
  const executing = history.filter(row => row.stage === "EXECUTING");
  assert.equal(executing.length, 1); assert.equal(executing[0].controller_term, claimant.term);
  assert.equal(executing[0].executor_id, command.executor_id); assert.equal(executing[0].execution_token, command.execution_token);
  assert.deepEqual((await pool.query(`SELECT * FROM durable_runtime.runtime_audit_events
    WHERE runtime_unit_id=$1 AND kind='INITIAL_AGENT_ATTEMPT_RESERVED'`, [f.context.runtimeUnitId])).rows, reservationAudit);
  await withDurableTransaction(pool, async tx => {
    const locked = await LockedGatewayAuthority.acquire(tx, context);
    const notClaimed = await claimCommand(locked, originalIdentity(command), reserved.request.claim.executorId);
    assert.equal(notClaimed.disposition, "NOT_CLAIMABLE");
  });
  assert.deepEqual(await snapshot(f), after);
  await withDurableTransaction(pool, async tx => {
    await markCommandUnknown(await LockedGatewayAuthority.acquire(tx, unknownContext), unknownReserved.request.claim);
  });
  await rejectsUnchanged(unknown, () => withDurableTransaction(pool, tx => readInitialAgentPodLookupTarget(tx, unknownContext,
    { commandId: unknown.command.id, planDigest: unknown.record.planDigest })), "INITIAL_AGENT_POD_ORIGINAL_HISTORY");
  for (const [index, kind] of (["MISSING", "MISMATCH", "AMBIGUOUS"] as const).entries()) {
    const broken = malformed[index], brokenContext = await syntheticHistory(broken, current, kind);
    await rejectsUnchanged(broken, () => withDurableTransaction(pool, tx => readInitialAgentPodLookupTarget(tx, brokenContext,
      { commandId: broken.command.id, planDigest: broken.record.planDigest })), "INITIAL_AGENT_POD_ORIGINAL_HISTORY");
  }
  assert.deepEqual((await pool.query("SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version")).rows, ledger);
  const retained = await rowHashes();
  for (const table of originalTables) {
    const remaining = [...retained[table]];
    for (const oldHash of originals[table]) {
      const index = remaining.indexOf(oldHash); assert.notEqual(index, -1, `Pre-existing ${table} row retained`); remaining.splice(index, 1);
    }
  }
  t.diagnostic("Real lease/operation/command takeover; synthetic directory/controller brand/FOUND observation only. Missing/mismatch/ambiguous history uses new nonproduction IDs; no existing row corruption or execution authority.");
});
