import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from '../db/connection.ts'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import type { StorageEvidenceAuthority, VerifiedDirectoryEvidence } from '../storage/evidence.ts'
import type { VerifiedControllerIdentity, GatewayContext, ExecutorId } from './gateway/types.ts'
import type { PayloadHash } from './runtime-evidence.ts'
import type { InitialAgentAttemptInput } from './initial-agent-attempt.ts'
import type { PreparedInitialAgentPinsLease, PreparedInitialAgentPinsOwner } from './initial-agent-attempt-transaction.ts'
import { createAgentPodPlanner } from './agent-pod-plan.ts'
import { recordAgentPodPlan } from './agent-pod-plan-records.ts'
import { LockedGatewayAuthority } from './gateway/authority.ts'
import { submitCommand, originalIdentity } from './gateway/store.ts'
import { claimCommand } from './gateway/claim.ts'
import { inputDigest } from './gateway/input.ts'
import { harness, reviewerToken } from './kubernetes-pod-auth-fixtures.mts'
import { createInitialAgentPodExecution } from './initial-agent-pod-execution.ts'

// Existing Root-assigned isolated SQL23 only. No DDL/reset, real pin issuer or Kubernetes request.
const database = process.env.ORCA_INITIAL_AGENT_POD_EXECUTION_DATABASE, oid = process.env.ORCA_INITIAL_AGENT_POD_EXECUTION_DATABASE_OID
if (process.env.ORCA_INITIAL_AGENT_POD_EXECUTION_APPROVED !== 'root-first-verification' || !database ||
    database === 'orca_dev' || !/^orca_[a-z0-9_]+$/u.test(database) || database !== process.env.PGDATABASE || !oid || !/^[1-9][0-9]*$/u.test(oid)) {
  throw new Error('Root-approved existing isolated SQL23 database/OID inputs required')
}
const pool = createDurablePool({ database, max: 4, application_name: 'initial-agent-pod-execution-first' })
const dataset = 'orca-1012-dev-v1', namespace = 'initial-execution-fixture', scope = `synthetic-initial-execution:${randomUUID()}`
const ownerId = `synthetic-initial-owner:${randomUUID()}`
// SAFETY: synthetic fixture nominal identity only; no controller/workload authentication issuer is qualified.
const controller = Object.freeze({ scope, owner: ownerId, term: counter('controller-term', '1') }) as VerifiedControllerIdentity
const directories = new Map<string, VerifiedDirectoryEvidence>()
const authority: StorageEvidenceAuthority = Object.freeze({
  directory(ref: string) { return directories.get(ref) ?? null },
  directoryPinValid(evidence: VerifiedDirectoryEvidence) { return directories.get(evidence.evidenceRef) === evidence },
  mount() { return null }, mountPinValid() { return false }, executionTarget() { return null }, executionTargetPinValid() { return false },
  permanentComputeStop() { return null }, computeStopPinValid() { return false },
})
const tables = ['controller_leases', 'runtime_units', 'operations', 'resource_profiles', 'attempts', 'execution_grants', 'storage_domains',
  'storage_bindings', 'storage_write_grants', 'storage_mounts', 'agents', 'workspaces', 'sessions', 'runtime_members',
  'runtime_member_storage_bindings', 'runtime_commands', 'runtime_command_history', 'agent_pod_plans', 'runtime_audit_events', 'outbox_events'] as const
async function identity() {
  const actual = (await pool.query<{ database: string; oid: string; system: string }>(`SELECT current_database() AS database,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system`)).rows[0]
  assert.equal(actual.database, database); assert.equal(actual.oid, oid); assert.equal(actual.system, '7696101282789175327')
  assert.deepEqual((await pool.query('SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows, [{ dataset_name: dataset }])
}
async function originalRows() {
  const rows: Record<string, string[]> = {}
  for (const table of tables) {
    rows[table] = (await pool.query<{ body: string }>(`SELECT to_jsonb(t)::text AS body FROM durable_runtime.${table} t`)).rows.map(row => row.body).sort()
  }
  return rows
}

// Only the additive seed needed by this integration. Reservation/assignment SQL stays in its actual modules.
async function seed() {
  const unit = logicalId('runtime-unit', randomUUID()), operation = logicalId('operation', randomUUID()), attempt = randomUUID()
  const session = randomUUID(), agent = randomUUID(), workspace = randomUUID(), leaf = randomUUID(), bindingId = logicalId('storage-binding', randomUUID())
  const exportId = `synthetic-execution-export:${randomUUID()}`, reference = `synthetic-execution-directory:${bindingId}`
  const context: GatewayContext = Object.freeze({ runtimeUnitId: unit, operationId: operation, controller })
  const plan = createAgentPodPlanner({ namespace, dataset, image: `example.invalid/agent@sha256:${'1'.repeat(64)}`,
    entrypoint: { command: ['/usr/local/bin/node'], args: ['-e', 'setInterval(() => {}, 3600000)'] },
    paths: { home: '/agent/home', claudeState: '/agent/home/.claude', codexState: '/agent/home/.codex', checkout: '/agent/project' },
    protectedMounts: [{ key: 'all', clientPath: '/agent' }], nfsServer: 'nfs.fixture.svc.cluster.local',
    protectedExportRoot: `/exports/runtime-domains/${dataset}`,
    shared: { claimName: 'shared-fixture', claimUid: 'shared-claim', pvUid: 'shared-pv', serverPath: `/exports/shared/${dataset}` }
  }).plan({ identity: { unitId: unit, operationId: operation, attemptId: attempt, resourceName: `orca-unit-${operation}`,
    executionEpoch: '0', intentRevision: '0', specHash: 'a'.repeat(64) },
  protectedBindings: [{ key: 'all', bindingId, leafId: leaf, claimName: `protected-${leaf}`, claimUid: `claim-${leaf}`,
    pvUid: `consumer-pv-${leaf}`, serverPath: `/exports/runtime-domains/${dataset}/${leaf}`, mode: 'RW' }],
  profile: { revision: '0', cpuMilli: 100, memoryMi: 128, ephemeralMi: 256, temporaryMi: 64 } })
  // SAFETY: synthetic prepared proof only. Server backing PV and consumer leaf PV remain distinct.
  const evidence = Object.freeze({ evidenceRef: reference, topologyPinId: `synthetic-pin:${bindingId}`,
    candidate: Object.freeze({ domain: Object.freeze({ backendId: 'execution-fixture', exportId, pvUid: `server-ssd-pv:${exportId}` }),
      canonicalDirectory: `/${dataset}/${leaf}`, podUid: 'synthetic-nfs', generation: 'synthetic-1', device: '123', inode: '456' }) }) as VerifiedDirectoryEvidence
  directories.set(reference, evidence)
  return withDurableTransaction(pool, async tx => {
    await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT')", [unit])
    await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0)", [unit])
    await tx.query(`INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,execution_epoch,external_resource_name)
      VALUES($1,$2,'WAKE',0,$3,1,'ENSURE_ATTEMPT',0,$4)`, [operation, unit, scope, plan.identity.resourceName])
    await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'codex')", [agent])
    await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'synthetic closed execution','READY')", [workspace, `execution:${workspace}`])
    await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [session, agent, workspace])
    await tx.query('INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2)', ['execution-fixture', exportId])
    await tx.query(`INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,identity_proof_ref,identity_verified_at,access_state)
      VALUES($1,$2,$3,$4,$5,clock_timestamp(),'VERIFIED')`, [bindingId, 'execution-fixture', exportId, `/${dataset}/${leaf}`, reference])
    await tx.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)', [unit, session, bindingId])
    const stored = await recordAgentPodPlan(tx, context, plan)
    const envelope = { operationId: operation, controllerTerm: controller.term, stepRevision: counter('step-revision', '0'),
      executionEpoch: plan.identity.executionEpoch, intentRevision: plan.identity.intentRevision, podTarget: 'CREATE_WITHOUT_POD' as const, expectedPodUid: null }
    const commandInput = { resourceName: plan.identity.resourceName, body: { mode: 'COLD', planDigest: stored.record.planDigest,
      attemptId: attempt, resourceProfileRevision: plan.pod.metadata.annotations['orca.dev/resource-profile-revision'] } }
    const locked = await LockedGatewayAuthority.acquire(tx, context)
    // SAFETY: synthetic SHA-256/executor fixture brands, not authenticated authority.
    const submitted = await submitCommand(locked, { command: 'ensureAttempt', envelope, input: commandInput,
      inputHash: inputDigest(commandInput) as PayloadHash, predecessor: { kind: 'NONE' } })
    const claimed = await claimCommand(locked, originalIdentity(submitted.command), `synthetic-executor:${operation}` as ExecutorId)
    assert.equal(claimed.disposition, 'CLAIMED')
    if (claimed.disposition !== 'CLAIMED') { throw new Error('synthetic initial claim missing') }
    const request: InitialAgentAttemptInput = { claim: claimed.claim, planDigest: stored.record.planDigest,
      expectedUnitRevision: counter('row:runtime-unit', '0'), bindings: [{ bindingId,
        expectedRevision: counter('row:storage-binding', '0'), storageEpoch: counter('storage-epoch', '0') }] }
    return { context, request, plan, reference, evidence }
  })
}
type Seed = Awaited<ReturnType<typeof seed>>
function pins(f: Seed) {
  const state = { takes: 0, releases: 0, held: true }
  const lease: PreparedInitialAgentPinsLease = Object.freeze({ evidence: Object.freeze([f.evidence]), release() {
    assert.equal(this, lease); state.releases++; state.held = false
  } })
  const owner: PreparedInitialAgentPinsOwner = Object.freeze({ takePreparedPins(evidence: readonly VerifiedDirectoryEvidence[]) {
    assert.deepEqual(evidence, [f.evidence]); assert.equal(state.takes, 0); state.takes++; return lease
  } })
  return { owner, state }
}
function observedPool(unknownCommit = false) {
  const connect = pool.connect.bind(pool), state = { clients: 0, transactions: 0, commits: 0, releases: 0 }
  const borrowed: Pool = Object.create(pool, { connect: { value: async () => {
    const client = await connect(), query = client.query.bind(client), release = client.release.bind(client)
    state.clients++
    let active = false
    const wrapped: PoolClient = Object.create(client, {
      query: { value: async function<Row extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []) {
        if (unknownCommit && sql === 'ROLLBACK') { throw new DurableDatabaseError('08006') }
        const result = await query<Row>(sql, [...values])
        if (sql.startsWith('BEGIN')) { active = true; state.transactions++ }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          if (active) { active = false; state.transactions-- }
          if (sql === 'COMMIT') { state.commits++; if (unknownCommit) { throw new DurableDatabaseError('08006') } }
        }
        return result
      } },
      release: { value: (destroy: boolean) => { state.clients--; state.releases++; release(destroy) } },
    })
    return wrapped
  } } })
  return { pool: borrowed, state }
}
function observedPod(f: Seed, uid: string) {
  return { ...f.plan.pod, metadata: { ...f.plan.pod.metadata, uid, resourceVersion: 'first-rv' } }
}
function compose(f: Seed, h: ReturnType<typeof harness>, db = observedPool()) {
  const held = pins(f), request = h.transport.request.bind(h.transport)
  const https = { request(...args: Parameters<typeof request>) {
    assert.equal(db.state.clients, 0, 'all original DB clients released before HTTPS')
    assert.equal(db.state.transactions, 0, 'no SQL transaction holds locks during HTTPS')
    return request(...args)
  } }
  const executor = createInitialAgentPodExecution({ pool: db.pool, directoryAuthority: authority, preparedPinsOwner: held.owner,
    podConfig: { apiOrigin: 'https://kubernetes.invalid:6443', ca: Buffer.from('synthetic-ca'), namespace, dataset,
      timeoutMs: 1000, readBearerToken: () => reviewerToken } }, https)
  return { executor, held, db }
}
const start = (f: Seed) => ({ context: f.context, attempt: f.request, directoryEvidenceReferences: [f.reference], remainingMs: 60_000 })
const lookup = (f: Seed) => ({ context: f.context, claim: f.request.claim, planDigest: f.request.planDigest, remainingMs: 60_000 })

test('actual committed initial reservation connects once to idle Pod observation and UID assignment with a closed gate', async t => {
  t.after(() => pool.end())
  await identity()
  const ledger = (await pool.query('SELECT * FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length, 23)
  const before = await originalRows()
  await pool.query(`INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at)
    VALUES($1,$2,1,clock_timestamp()+interval '5 minutes')`, [scope, ownerId])

  const first = await seed(), uid = `synthetic-pod:${randomUUID()}`
  const firstHttp = harness([{ status: 404 }, { status: 201, body: observedPod(first, uid) }]), actual = compose(first, firstHttp)
  const assigned = await actual.executor.start(start(first), new AbortController().signal)
  assert.equal(assigned.reservation?.database?.ok, true)
  assert.equal(assigned.reservation?.pins.disposition, 'RELEASED'); assert.equal(actual.held.state.releases, 1)
  assert.equal(assigned.observation?.disposition, 'CREATED'); assert.equal(assigned.observation?.postAttempts, 1)
  assert.equal(assigned.assignment?.ok, true)
  if (!assigned.assignment?.ok) { throw new Error('initial assignment transaction did not commit') }
  assert.equal(assigned.assignment.value.disposition, 'ASSIGNED'); assert.equal(assigned.assignment.value.podUid, uid)
  assert.equal(assigned.gate, 'CLOSED'); assert.equal(assigned.providerReady, false); assert.equal(assigned.writerGrantActivated, false)
  assert.deepEqual(firstHttp.requests.map(row => row.options.method), ['GET', 'POST']); firstHttp.assertCleanup()
  assert.equal(firstHttp.requests[1]?.request.body, JSON.stringify(first.plan.pod))
  const a = (await pool.query('SELECT pod_uid,status,incarnation,ready_at,started_at FROM durable_runtime.attempts WHERE id=$1', [first.plan.identity.attemptId])).rows[0]
  assert.deepEqual(a, { pod_uid: uid, status: 'POD_ASSIGNED', incarnation: null, ready_at: null, started_at: null })
  const beforeReplay = await originalRows()
  const laterPod = observedPod(first, uid); laterPod.metadata.resourceVersion = 'later-rv'
  const laterHttp = harness([{ body: laterPod }]), later = compose(first, laterHttp)
  const replay = await later.executor.lookup(lookup(first), new AbortController().signal)
  assert.equal(later.held.state.takes, 0); assert.equal(replay.createRequested, false); assert.equal(replay.observation?.postAttempts, 0)
  assert.equal(replay.assignment?.ok, true)
  if (!replay.assignment?.ok) { throw new Error('lookup replay transaction did not commit') }
  assert.equal(replay.assignment.value.disposition, 'REPLAYED')
  assert.equal(replay.assignment.value.unitRevision, assigned.assignment.value.unitRevision)
  assert.deepEqual(await originalRows(), beforeReplay); laterHttp.assertCleanup()

  const uncertain = await seed(), uncertainHttp = harness([{ status: 404 }, { errorCode: 'ECONNRESET' }]), un = compose(uncertain, uncertainHttp)
  const unknown = await un.executor.start(start(uncertain), new AbortController().signal)
  assert.equal(unknown.reservation?.database?.ok, true); assert.equal(unknown.observation?.disposition, 'UNKNOWN')
  assert.equal(unknown.assignment, null); assert.equal(uncertainHttp.requests.length, 2); uncertainHttp.assertCleanup()
  const retryHttp = harness([]), retry = compose(uncertain, retryHttp)
  const reservationReplay = await retry.executor.start(start(uncertain), new AbortController().signal)
  assert.equal(reservationReplay.reservation?.database?.ok, true)
  if (!reservationReplay.reservation?.database?.ok) { throw new Error('original reservation replay did not commit') }
  assert.equal(reservationReplay.reservation.database.value.disposition, 'REPLAYED')
  assert.equal(reservationReplay.observation, null); assert.equal(retryHttp.requests.length, 0)
  const recoveredHttp = harness([{ body: observedPod(uncertain, `synthetic-recovered:${randomUUID()}`) }]), recovered = compose(uncertain, recoveredHttp)
  const recoveredAssignment = await recovered.executor.lookup(lookup(uncertain), new AbortController().signal)
  assert.equal(recoveredAssignment.assignment?.ok, true); assert.equal(recoveredAssignment.observation?.postAttempts, 0)
  assert.equal(recovered.held.state.takes, 0); assert.equal(recoveredHttp.requests.length, 1); recoveredHttp.assertCleanup()

  const ambiguous = await seed(), noHttp = harness([]), pending = compose(ambiguous, noHttp, observedPool(true))
  const unconfirmed = await pending.executor.start(start(ambiguous), new AbortController().signal)
  assert.equal(unconfirmed.reservation?.database?.settlement, 'UNCONFIRMED')
  assert.equal(unconfirmed.reservation?.pins.disposition, 'RETAINED'); assert.equal(pending.held.state.releases, 0)
  assert.equal(unconfirmed.observation, null); assert.equal(unconfirmed.assignment, null); assert.equal(noHttp.requests.length, 0)
  assert.equal(pending.db.state.clients, 0); noHttp.assertCleanup()

  const after = await originalRows()
  for (const table of tables) {
    const remaining = [...after[table]]
    for (const row of before[table]) {
      const index = remaining.indexOf(row); assert.notEqual(index, -1, `original ${table} row retained`); remaining.splice(index, 1)
    }
  }
  await identity()
  assert.deepEqual((await pool.query('SELECT * FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
})
