import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createDurablePool, DurableDatabaseError } from '../db/connection.ts'
import { createAgentPodPlanner } from '../runtime/agent-pod-plan.ts'
import { canonicalInput } from '../runtime/gateway/input.ts'
import { createPgOpsServices } from './pg-services.ts'

const database = process.env.ORCA_OPS_RESOURCES_DATABASE
if (!database || database === 'orca_dev' || !/^orca_ops_resources_[a-z0-9_]+$/.test(database) ||
    database !== process.env.PGDATABASE) { throw new Error('Dedicated Ops resources verification database required') }
const pool = createDurablePool({ database, max: 3, application_name: 'ops-desired-resources-focused' })
const digest = (value: unknown) => createHash('sha256').update(canonicalInput(value)).digest('hex')
const onlyHead = process.env.ORCA_OPS_RESOURCES_ONLY_HEAD === '1'

async function seed(cpu = '777', wrongPlanDigest = false) {
  const unit = randomUUID(), workspace = randomUUID(), agent = randomUUID(), session = randomUUID(), binding = randomUUID()
  const f = { unit, sessions: [session], binding }, operation = randomUUID(), scope = `ops-resources:${randomUUID()}`
  await pool.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'fixture')", [agent])
  await pool.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'fixture','READY')", [workspace, `fixture:${workspace}`])
  await pool.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT')", [unit])
  await pool.query('INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,\'fixture\')', [unit])
  await pool.query("INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state) VALUES($1,$2,'fixture',$3,'UNKNOWN')", [binding, unit, `/fixture/${unit}`])
  await pool.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [session, agent, workspace])
  await pool.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)', [unit, session, binding])
  const group = `ops-resources:${randomUUID()}`, leaf = randomUUID()
  // Fixture data only: this expired FK row is never acquired or used as a controller authority.
  await pool.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,'fixture-data-only',0,'1970-01-01')", [scope])
  await pool.query(`INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,execution_epoch,external_resource_name)
    VALUES($1,$2,'WAKE',0,$3,0,'ENSURE_ATTEMPT',0,$4)`, [operation, f.unit, scope, `orca-unit-${operation}`])
  await pool.query('INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)', [group, { id: group }])
  await pool.query(`INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,project_group_id,reserved_path,payload,create_request,runtime_unit_id)
    VALUES($1,'FOLDER_WORKSPACE',$2,$3,'{}','{}',$4)`, [workspace, group, `/fixture/${workspace}`, f.unit])
  const plan = createAgentPodPlanner({ namespace: 'ops-resource-fixture', dataset: 'orca-1012-dev-v1',
    image: `example.invalid/agent@sha256:${'1'.repeat(64)}`, entrypoint: { command: ['/usr/local/bin/node'], args: ['-e', 'setInterval(() => {}, 3600000)'] },
    paths: { home: '/agent/home', claudeState: '/agent/home/.claude', codexState: '/agent/home/.codex', checkout: '/agent/project' },
    nfsServer: 'nfs.fixture.svc.cluster.local', protectedExportRoot: '/exports/runtime-domains/orca-1012-dev-v1',
    protectedMounts: [{ key: 'home', clientPath: '/agent' }],
    shared: { claimName: 'shared-fixture', claimUid: 'shared-claim', pvUid: 'shared-pv', serverPath: '/exports/shared/orca-1012-dev-v1' } }).plan({
    identity: { unitId: f.unit, operationId: operation, attemptId: randomUUID(), resourceName: `orca-unit-${operation}`,
      executionEpoch: '0', intentRevision: '0', specHash: 'a'.repeat(64) },
    protectedBindings: [{ key: 'home', bindingId: f.binding, leafId: leaf, claimName: `protected-${leaf}`,
      claimUid: `claim-${leaf}`, pvUid: `pv-${leaf}`, serverPath: `/exports/runtime-domains/orca-1012-dev-v1/${leaf}`, mode: 'RW' }],
    profile: { revision: '7', cpuMilli: Number(cpu), memoryMi: 1024, ephemeralMi: 2048, temporaryMi: 256 } })
  const prepared = { planDigest: digest(plan) }, id = plan.identity
  await pool.query(`INSERT INTO durable_runtime.agent_pod_plans(operation_id,runtime_unit_id,dataset_name,attempt_id,
    execution_epoch,intent_revision,namespace,resource_name,spec_hash,pod_spec_sha256,plan_digest,plan)
    VALUES($1,$2,'orca-1012-dev-v1',$3,0,0,$4,$5,$6,$7,$8,$9)`, [operation, f.unit, id.attemptId,
    plan.pod.metadata.namespace, id.resourceName, id.specHash, plan.podSpecSHA256, prepared.planDigest, plan])
  const shape = { sourceRef: `initial-agent-plan:v1:${prepared.planDigest}`, profileId: `initial-agent-profile:v1:${f.unit}:7`,
    runtimeUnitId: f.unit, containerIdentity: 'agent', observed: false, complete: true,
    containers: [{ name: 'agent', memoryBytes: '1073741824', cpuMillicores: cpu,
      memoryLimitPresent: false, cpuLimitPresent: false, restartableInit: false }],
    initContainers: [], overheadMemoryBytes: '0', overheadCpuMillicores: '0', spot: true, oneUnitPerNode: true }
  await pool.query('INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,7,$2,4)', [f.unit, shape])
  const event = { kind: 'INITIAL_AGENT_RESOURCE_PROFILE_RECORDED', unitId: f.unit, operationId: operation,
    profileRevision: '7', policyRevision: '4', planDigest: wrongPlanDigest ? 'f'.repeat(64) : prepared.planDigest,
    shapeDigest: digest(shape), recordedUnitRevision: '0' }
  const eventId = randomUUID()
  await pool.query(`INSERT INTO durable_runtime.runtime_audit_events(id,actor_id,runtime_unit_id,operation_id,resource_profile_revision,
    kind,next_state,occurred_at,received_at,producer_id,producer_seq,evidence_refs,payload)
    VALUES($1,'fixture-data-only',$2,$3,7,$4,$5,clock_timestamp(),clock_timestamp(),$1,1,'[]','{}')`,
  [eventId, f.unit, operation, event.kind, event])
  const serverScope = { datasetName: 'orca-1012-dev-v1', namespaceId: `fixture:${workspace}`, workspaceIds: [workspace] }
  const actor = { ...serverScope, principalId: 'ops-resource-fixture', authorizationRef: 'fixture-only' }
  const services = createPgOpsServices({ pool, scope: serverScope, streamId: 'ops-fixture',
    lifecyclePolicy: { operationDeadlineMs: 60000, idleDurationMs: 60000 }, controllerConnected: false })
  return { ...f, operation, shape, actor, services, eventId }
}

test('stored desired requests: exact reference, scoped snapshot and no invented observations', async t => {
  t.after(() => pool.end())
  const identity = (await pool.query(`SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system`)).rows[0]
  assert.equal(identity.database, database)
  assert.equal(identity.oid, process.env.ORCA_OPS_RESOURCES_DATABASE_OID)
  assert.equal(identity.system, '7696101282789175327')
  assert.equal((await pool.query('SELECT count(*)::text AS n FROM durable_runtime.schema_migrations')).rows[0].n, '23')
  const a = await seed(), b = await seed('999')
  // A larger, unrelated stored profile must not win over the audited reference.
  await pool.query('INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,99,$2,4)',
    [a.unit, { ...a.shape, containers: [{ ...a.shape.containers[0], cpuMillicores: '9999' }] }])
  if (!onlyHead) { await t.test('initial declaration and list/detail share the exact profile; another Unit remains forbidden', async () => {
    const before = (await pool.query('SELECT to_jsonb(u) AS body FROM durable_runtime.runtime_units u WHERE id=$1', [a.unit])).rows
    const list = await a.services.units(a.actor), detail = await a.services.unit(a.actor, a.unit)
    assert.deepEqual(list.units.map(u => u.id), [a.unit])
    assert.deepEqual(list.units[0].resources, detail.unit.resources)
    assert.deepEqual(detail.unit.resources, { desired: { cpuMilli: '777', memoryBytes: '1073741824' },
      admitted: null, usage: null, peak: null, nextDownsizeAt: null })
    assert.equal(detail.unit.attempt, null)
    await assert.rejects(a.services.unit(a.actor, b.unit), e => e instanceof DurableDatabaseError && e.code === 'OPS_TARGET_FORBIDDEN')
    assert.deepEqual((await pool.query('SELECT to_jsonb(u) AS body FROM durable_runtime.runtime_units u WHERE id=$1', [a.unit])).rows, before)
  }) }
  await t.test('resource head selects its desired revision, then approved when no replacement is pending', async () => {
    const budget = `fixture-budget:${randomUUID()}`
    const fixturePolicy = { revision: '4' }
    await pool.query('INSERT INTO durable_runtime.resource_policy_versions(policy_revision,policy,policy_digest) VALUES(4,$1,$2) ON CONFLICT DO NOTHING',
      [fixturePolicy, digest(fixturePolicy)])
    await pool.query(`INSERT INTO durable_runtime.resource_budget_scopes(scope,dataset_name,budget_domain_id,memory_limit_bytes,cpu_limit_millicores,configuration,evidence_ref)
      VALUES($1,'orca-1012-dev-v1',$1,10000000000,10000,'{}','fixture-data-only')`, [budget])
    await pool.query('INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,8,$2,4)',
      [a.unit, { ...a.shape, profileId: 'fixture-target-8', containers: [{ ...a.shape.containers[0], cpuMillicores: '888', memoryBytes: '2147483648' }] }])
    await pool.query(`INSERT INTO durable_runtime.resource_unit_state(runtime_unit_id,budget_scope,approved_profile_revision,
      desired_profile_revision,policy_revision,accounted_memory_bytes,accounted_cpu_millicores,accounting_evidence_ref,breaker)
      VALUES($1,$2,7,8,4,0,0,'fixture-data-only','CLOSED')`, [a.unit, budget])
    assert.deepEqual((await a.services.unit(a.actor, a.unit)).unit.resources.desired, { cpuMilli: '888', memoryBytes: '2147483648' })
    await pool.query('UPDATE durable_runtime.resource_unit_state SET desired_profile_revision=NULL,revision=revision+1 WHERE runtime_unit_id=$1', [a.unit])
    assert.deepEqual((await a.services.unit(a.actor, a.unit)).unit.resources.desired, { cpuMilli: '777', memoryBytes: '1073741824' })
  })
  if (!onlyHead) { await t.test('mismatched initial plan evidence fails rather than projecting another identity', async () => {
    const corrupt = await seed('666', true)
    await assert.rejects(corrupt.services.unit(corrupt.actor, corrupt.unit), e => e instanceof DurableDatabaseError && e.code === 'OPS_RESOURCE_PROFILE_REFERENCE')
  }) }
})
