import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { StorageEvidenceAuthority, VerifiedDirectoryEvidence } from '../storage/evidence.ts'
import { createAgentPodPlanner } from './agent-pod-plan.ts'
import { recordAgentPodPlan } from './agent-pod-plan-records.ts'
import { reserveInitialAgentAttempt, type InitialAgentAttemptInput } from './initial-agent-attempt.ts'
import { LockedGatewayAuthority } from './gateway/authority.ts'
import { submitCommand, originalIdentity } from './gateway/store.ts'
import { claimCommand, markCommandUnknown } from './gateway/claim.ts'
import { inputDigest } from './gateway/input.ts'
import type { PayloadHash } from './runtime-evidence.ts'
import type { GatewayContext, VerifiedControllerIdentity, ExecutorId } from './gateway/types.ts'
import { CONTROLLER_SCOPE, ControllerInstance, type LeaseRecord } from '../ha/instance.ts'
import { tryAcquireControllerLease, releaseControllerLease } from '../ha/lease.ts'
import { prepareReconcileStep } from '../lifecycle/controller.ts'
import { harness, reviewerToken } from './kubernetes-pod-auth-fixtures.mts'
import { createInitialAgentPodLookup } from './initial-agent-pod-execution.ts'

// The original command is claimed/reserved normally, then adopted by another
// real isolated controller lease. Directory proof and HTTPS are synthetic only.
const database = process.env.ORCA_ORIGINAL_AGENT_POD_LOOKUP_DATABASE
const oid = process.env.ORCA_ORIGINAL_AGENT_POD_LOOKUP_DATABASE_OID
const leaseEvidence = process.env.ORCA_ORIGINAL_AGENT_POD_LOOKUP_LEASE_EVIDENCE
if (process.env.ORCA_ORIGINAL_AGENT_POD_LOOKUP_APPROVED !== 'root-first-verification' || !database ||
    database === 'orca_dev' || !/^orca_[a-z0-9_]+$/u.test(database) || database !== process.env.PGDATABASE ||
    !oid || !/^[1-9][0-9]*$/u.test(oid) || !leaseEvidence) {
  throw new Error('Root-approved isolated database/OID and original lease metadata path required')
}
const pool = createDurablePool({ database, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 5000,
  application_name: 'original-agent-pod-lookup-first' })
const dataset = 'orca-1012-dev-v1'
const directories = new Map<string, VerifiedDirectoryEvidence>()
const authority: StorageEvidenceAuthority = Object.freeze({
  directory(ref: string) { return directories.get(ref) ?? null },
  directoryPinValid(evidence: VerifiedDirectoryEvidence) { return directories.get(evidence.evidenceRef) === evidence },
  mount() { return null }, mountPinValid() { return false }, executionTarget() { return null }, executionTargetPinValid() { return false },
  permanentComputeStop() { return null }, computeStopPinValid() { return false },
})
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
async function identity() {
  const actual = (await pool.query<{ database: string; oid: string; system: string }>(`SELECT current_database() AS database,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system`)).rows[0]
  assert.equal(actual.database, database); assert.equal(actual.oid, oid); assert.equal(actual.system, '7696101282789175327')
  assert.deepEqual((await pool.query('SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows, [{ dataset_name: dataset }])
  return actual
}
const tables = ['dataset_metadata', 'runtime_units', 'operations', 'resource_profiles', 'attempts', 'execution_grants',
  'storage_domains', 'storage_bindings', 'storage_write_grants', 'storage_mounts', 'agents', 'workspaces', 'sessions',
  'runtime_members', 'runtime_member_storage_bindings', 'runtime_commands', 'runtime_command_history', 'agent_pod_plans',
  'runtime_audit_events', 'outbox_events', 'rpc_receipts'] as const
async function originalRows() {
  const result: Record<string, string[]> = {}
  for (const table of tables) {
    result[table] = (await pool.query<{ body: string }>(`SELECT to_jsonb(t)::text AS body FROM durable_runtime.${table} t`)).rows.map(row => hash(row.body)).sort()
  }
  return result
}
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
  const context = contextFor(f, controller);
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

function observedPool() {
  const connect = pool.connect.bind(pool), state = { clients: 0, transactions: 0 }
  const borrowed: Pool = Object.create(pool, { connect: { value: async () => {
    const client = await connect(), query = client.query.bind(client), release = client.release.bind(client)
    state.clients++
    let active = false
    const wrapped: PoolClient = Object.create(client, {
      query: { value: async function<Row extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []) {
        const result = await query<Row>(sql, [...values])
        if (sql.startsWith('BEGIN')) { active = true; state.transactions++ }
        if ((sql === 'COMMIT' || sql === 'ROLLBACK') && active) { active = false; state.transactions-- }
        return result
      } },
      release: { value: (destroy: boolean) => { state.clients--; release(destroy) } },
    })
    return wrapped
  } } })
  return { pool: borrowed, state }
}
function compose(f: Fixture, h: ReturnType<typeof harness>) {
  const db = observedPool(), request = h.transport.request.bind(h.transport)
  const https = { request(...args: Parameters<typeof request>) {
    assert.equal(db.state.clients, 0, 'original target COMMIT/cleanup must precede HTTPS')
    assert.equal(db.state.transactions, 0, 'HTTP holds no DB transaction')
    assert.equal(args[1].method, 'GET', 'this factory must never POST even for RESERVED with no UID')
    assert.ok(args[0].pathname.endsWith('/pods/' + f.plan.identity.resourceName))
    return request(...args)
  } }
  const lookup = createInitialAgentPodLookup({ pool: db.pool,
    podConfig: { apiOrigin: 'https://kubernetes.invalid:6443', ca: Buffer.from('synthetic-ca'),
      namespace: f.plan.pod.metadata.namespace, dataset, timeoutMs: 1000, readBearerToken: () => reviewerToken } }, https)
  return { lookup, db }
}
async function commandSnapshot(f: Fixture) {
  const command = (await pool.query('SELECT * FROM durable_runtime.runtime_commands WHERE id=$1', [f.command.id])).rows
  const history = (await pool.query('SELECT * FROM durable_runtime.runtime_command_history WHERE command_id=$1 ORDER BY id', [f.command.id])).rows
  const reservation = (await pool.query(`SELECT * FROM durable_runtime.runtime_audit_events
    WHERE runtime_unit_id=$1 AND kind='INITIAL_AGENT_ATTEMPT_RESERVED'`, [f.context.runtimeUnitId])).rows
  const grants = (await pool.query('SELECT * FROM durable_runtime.execution_grants WHERE runtime_unit_id=$1 ORDER BY id', [f.context.runtimeUnitId])).rows
  const writes = (await pool.query('SELECT * FROM durable_runtime.storage_write_grants WHERE attempt_id=$1 ORDER BY id', [f.plan.identity.attemptId])).rows
  return { command, history, reservation, grants, writes }
}

test('adopted original Agent command uses only GET and assigns or replays its original Pod with a closed gate', async t => {
  let active: { instance: ControllerInstance; lease: LeaseRecord } | null = null
  t.after(async () => {
    try {
      if (active) {
        const released = await releaseControllerLease(pool, active.instance, active.lease)
        assert.equal(released.status, 'RELEASED'); active = null
      }
    } finally { await pool.end() }
  })
  const actual = await identity()
  const ledger = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length, 23)
  const control = (await pool.query(`SELECT c.scope,c.owner,c.term,c.revision,c.expires_at,
    clock_timestamp() AS pg_clock,coalesce(c.expires_at>clock_timestamp(),false) AS unexpired
    FROM (SELECT 1) guard LEFT JOIN durable_runtime.controller_leases c ON c.scope=$1`, [CONTROLLER_SCOPE])).rows[0]
  await writeFile(leaseEvidence, JSON.stringify({ actual, control }) + '\n', { flag: 'wx', mode: 0o600 })
  assert.equal(control.unexpired, false, 'normal isolated lease acquire only; no expiry/reset mutation')
  const originals = await originalRows()
  async function nextController(): Promise<VerifiedControllerIdentity> {
    if (active) {
      const released = await releaseControllerLease(pool, active.instance, active.lease)
      assert.equal(released.status, 'RELEASED'); active = null
    }
    const instance = new ControllerInstance(CONTROLLER_SCOPE)
    const acquired = await tryAcquireControllerLease(pool, instance, { revision: 'original-pod-lookup-fixture', durationMs: 60000 })
    assert.equal(acquired.status, 'ACTIVE')
    if (acquired.status !== 'ACTIVE') { assert.fail('real isolated lease required') }
    active = { instance, lease: acquired.lease }
    // SAFETY: nominal fixture identity from the confirmed lease, not a production issuer.
    return Object.freeze({ scope: acquired.lease.scope, owner: acquired.lease.owner, term: acquired.lease.term }) as VerifiedControllerIdentity
  }
  const first = await nextController(), f = await seed(first)
  const reserved = await claimAndReserve(f, first)
  const current = await nextController(), context = await adopt(reserved, current)
  const input = { context, commandId: f.command.id, planDigest: f.record.planDigest, remainingMs: 60000 }
  const before = await commandSnapshot(f), signal = new AbortController().signal
  const staleHttp = harness([]), stale = compose(f, staleHttp)
  const denied = await stale.lookup.lookup({ ...input, context: reserved.context }, signal)
  assert.equal(denied.phase, 'TARGET'); assert.equal(denied.target?.ok, false)
  assert.equal(denied.createRequested, false); assert.equal(denied.reservation, null)
  assert.equal(staleHttp.requests.length, 0); assert.equal(stale.db.state.clients, 0)

  const absentHttp = harness([{ status: 404 }]), absent = compose(f, absentHttp)
  const missing = await absent.lookup.lookup(input, signal)
  assert.equal(missing.observation?.disposition, 'ABSENT'); assert.equal(missing.observation?.postAttempts, 0)
  assert.equal(missing.assignment, null); assert.equal(missing.createRequested, false); assert.equal(missing.reservation, null)
  assert.equal(absentHttp.requests.length, 1); absentHttp.assertCleanup()
  assert.deepEqual(await commandSnapshot(f), before)

  const unknownHttp = harness([{ errorCode: 'ECONNRESET' }]), unknown = compose(f, unknownHttp)
  const uncertain = await unknown.lookup.lookup(input, signal)
  assert.equal(uncertain.phase, 'TRANSPORT'); assert.equal(uncertain.error?.code, 'NETWORK_FAILED')
  assert.equal(uncertain.assignment, null); assert.equal(uncertain.createRequested, false)
  assert.equal(unknownHttp.requests.length, 1); unknownHttp.assertCleanup()
  assert.deepEqual(await commandSnapshot(f), before)

  const uid = 'synthetic-original-pod:' + randomUUID()
  const pod = { ...f.plan.pod, metadata: { ...f.plan.pod.metadata, uid, resourceVersion: 'synthetic-get-1' } }
  const foundHttp = harness([{ status: 200, body: pod }, { status: 200, body: pod }]), found = compose(f, foundHttp)
  const assigned = await found.lookup.lookup(input, signal)
  assert.equal(assigned.target?.ok, true); assert.equal(assigned.target?.settlement, 'COMMITTED')
  assert.equal(assigned.target?.cleanupFailed, false); assert.equal(assigned.observation?.disposition, 'FOUND')
  assert.equal(assigned.assignment?.ok, true); assert.equal(assigned.assignment?.settlement, 'COMMITTED')
  assert.equal(assigned.assignment?.commitOutcome, 'ACKNOWLEDGED'); assert.equal(assigned.assignment?.cleanupFailed, false)
  if (!assigned.assignment?.ok) { assert.fail('original Pod assignment must commit') }
  assert.equal(assigned.assignment.value.disposition, 'ASSIGNED'); assert.equal(assigned.assignment.value.podUid, uid)
  assert.equal(assigned.assignment.value.attemptId, f.plan.identity.attemptId)
  assert.equal(assigned.gate, 'CLOSED'); assert.equal(assigned.providerReady, false); assert.equal(assigned.writerGrantActivated, false)
  assert.equal(assigned.createRequested, false); assert.equal(assigned.reservation, null)
  const assignedRows = (await pool.query(`SELECT * FROM durable_runtime.runtime_audit_events
    WHERE runtime_unit_id=$1 AND kind='INITIAL_AGENT_POD_ASSIGNED'`, [f.context.runtimeUnitId])).rows
  assert.equal(assignedRows.length, 1)
  const replayed = await found.lookup.lookup(input, signal)
  assert.equal(replayed.assignment?.ok, true)
  if (!replayed.assignment?.ok) { assert.fail('original Pod replay must commit') }
  assert.equal(replayed.assignment.value.disposition, 'REPLAYED'); assert.equal(replayed.assignment.value.podUid, uid)
  assert.equal(replayed.observation?.postAttempts, 0); assert.equal(foundHttp.requests.length, 2)
  foundHttp.assertCleanup(); assert.equal(found.db.state.clients, 0); assert.equal(found.db.state.transactions, 0)
  assert.deepEqual(await commandSnapshot(f), before)
  assert.deepEqual((await pool.query(`SELECT * FROM durable_runtime.runtime_audit_events
    WHERE runtime_unit_id=$1 AND kind='INITIAL_AGENT_POD_ASSIGNED'`, [f.context.runtimeUnitId])).rows, assignedRows)
  assert.equal((await pool.query('SELECT pod_uid FROM durable_runtime.attempts WHERE id=$1', [f.plan.identity.attemptId])).rows[0].pod_uid, uid)

  // Command UNKNOWN is DB state, separate from the preceding uncertain HTTP read.
  await withDurableTransaction(pool, async tx => {
    await markCommandUnknown(await LockedGatewayAuthority.acquire(tx, context), reserved.request.claim)
  })
  const dbUnknownHttp = harness([]), dbUnknown = compose(f, dbUnknownHttp)
  const blocked = await dbUnknown.lookup.lookup(input, signal)
  assert.equal(blocked.phase, 'TARGET'); assert.equal(blocked.target?.ok, false)
  assert.equal(blocked.observation, null); assert.equal(blocked.assignment, null); assert.equal(blocked.createRequested, false)
  assert.equal(dbUnknownHttp.requests.length, 0); assert.equal(dbUnknown.db.state.clients, 0)
  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  const retained = await originalRows()
  for (const table of tables) {
    const rows = [...retained[table]]
    for (const value of originals[table]) {
      const index = rows.indexOf(value); assert.notEqual(index, -1, `original ${table} row retained`); rows.splice(index, 1)
    }
  }
  await identity()
  t.diagnostic('Real isolated lease/adoption/command/reservation and GET/assignment connection; synthetic directory and HTTPS only. No CREATE, physical issuer, provider/writer or HA qualification.')
})
