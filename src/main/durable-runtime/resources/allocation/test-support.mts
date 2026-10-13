import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient, QueryResult } from 'pg'
import { logicalId, counter } from '../../../../shared/durable-runtime/identity.ts'
import type { SessionId } from '../../../../shared/durable-runtime/identity.ts'
import type { VerifiedEvidence } from '../../runtime/runtime-evidence.ts'
import type { MutationOutcome } from '../../db/atomic.ts'
import type { FailureTarget, ClassificationResult } from '../evidence/types.ts'
import { createInitialPolicy, evaluateGrowth } from '../policy/index.ts'
import type { AdmissionShape } from '../policy/admission.ts'
import type { ProfileEvidence, CapEvidence } from '../policy/types.ts'
import type { ResourceAuthority, ResourceFacts, ScopeAuthorizer, PrepareResourceRequest, AllocationResult } from './types.ts'
import { registerResourcePolicy, registerResourceBudgetScope, registerResourceUnitHead } from './index.ts'

// Nominal fixture inputs ONLY. This does not install an issuer or prove real
// admission, external capacity, Agent OOM or the authenticated production path.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Static fixture-only upstream brand; never exported from the product index.
export const fixtureEvidence = { evidenceRef: 'p122-fixture-evidence', observedAt: '2026-10-13T15:00:00Z' } as VerifiedEvidence
const Mi = 1048576n
export const policy = createInitialPolicy('1')
export type Fixture = { target: FailureTarget; session: SessionId; incidentId: string; scope: string; domain: string
  controller: PrepareResourceRequest['controller']; shape: AdmissionShape; profile: ProfileEvidence; classification: ClassificationResult }
export function authorizer(principal = 'p122-fixture-operator'): ScopeAuthorizer & { calls: number } {
  return { calls: 0, async authorize(authority) { this.calls += 1; assert.equal(authority.principalId, principal) } }
}
export function authority(f: Fixture): ResourceAuthority {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Owned PG fixture scope, not a production string-to-authority factory.
  return { principalId: 'p122-fixture-operator', datasetName: 'orca-1012-dev-v1', domainIdentity: f.domain,
    budgetScope: f.scope, runtimeUnitId: f.target.runtimeUnitId, evidence: fixtureEvidence } as ResourceAuthority
}
export async function fixture(pool: Pool, shared?: Pick<Fixture, 'scope' | 'domain' | 'controller'>): Promise<Fixture> {
  const unit = logicalId('runtime-unit', randomUUID()), attempt = logicalId('attempt', randomUUID()), session = logicalId('session', randomUUID())
  const scope = shared?.scope ?? `p122-scope:${randomUUID()}`, domain = shared?.domain ?? `p122-domain:${randomUUID()}`
  const controller = shared?.controller ?? { scope: `p122-controller:${randomUUID()}`, owner: 'p122-fixture-controller', term: counter('controller-term', '1') }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Physical tuple is synthetic fixture data, matched to actual owned PG rows only.
  const target = { runtimeUnitId: unit, attemptId: attempt, executionEpoch: counter('execution-epoch', '1'),
    podUid: `fixture-pod:${randomUUID()}`, containerName: 'agent', runtimeContainerId: `fixture-container:${randomUUID()}`,
    incarnation: `fixture-incarnation:${randomUUID()}` } as FailureTarget
  const shape: AdmissionShape = { sourceRef: 'fixture-original-admission', profileId: 'fixture-approved-profile',
    runtimeUnitId: unit, containerIdentity: target.runtimeContainerId!, observed: true, complete: true,
    containers: [{ name: 'agent', memoryBytes: (64n * Mi).toString(), cpuMillicores: '100', memoryLimitPresent: false,
      cpuLimitPresent: false, restartableInit: false }], initContainers: [], overheadMemoryBytes: '0', overheadCpuMillicores: '0', spot: true, oneUnitPerNode: true }
  const profile: ProfileEvidence = { profileId: shape.profileId, profileRevision: '0', sourceRef: shape.sourceRef, verified: true, target,
    memoryBytes: shape.containers[0].memoryBytes, cpuMillicores: '100', minimumMemoryBytes: (64n * Mi).toString(), minimumCpuMillicores: '100',
    coldStartMemoryBytes: (64n * Mi).toString(), memoryLimitOmitted: true, cpuLimitOmitted: true, spot: true, isolated: true,
    ratio: { sourceRef: 'fixture-compute-configuration', minBytesPerMillicore: '262144', maxBytesPerMillicore: '1048576' } }
  const incidentId = randomUUID(), observation = `fixture-observation:${randomUUID()}`
  const classification: ClassificationResult = { classification: 'ISOLATED_NODE_MEMORY_EXHAUSTION', authority: 'DATA_ONLY',
    automaticGrowthCandidate: true, reasons: ['FIXTURE_MEMORY_EVIDENCE'], missing: [], conflicts: [], observationIds: [observation] }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,$2,1,clock_timestamp()+interval '1 hour') ON CONFLICT(scope) DO NOTHING", [controller.scope, controller.owner])
    await client.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase,execution_epoch) VALUES($1,'RUNNING','READY',1)", [unit])
    await client.query('INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,$2::jsonb,1)', [unit, JSON.stringify(shape)])
    await client.query("INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,resource_profile_revision,effective_resources,status) VALUES($1,$2,1,'COLD',$3,$4,0,$5::jsonb,'READY')", [attempt, unit, target.podUid, target.incarnation, JSON.stringify(shape)])
    await client.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=$2 WHERE id=$1', [unit, attempt])
    const agent = randomUUID(), workspace = randomUUID(), binding = randomUUID(), backend = `fixture-backend:${randomUUID()}`
    await client.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'p122-fixture')", [agent])
    await client.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'p122-fixture','READY')", [workspace, randomUUID()])
    await client.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [session, agent, workspace])
    await client.query("INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,'fixture-export')", [backend])
    await client.query("INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state) VALUES($1,$2,'fixture-export','/fixture','RO')", [binding, backend])
    await client.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)', [unit, session, binding])
    await client.query(`INSERT INTO durable_runtime.failure_incidents(id,runtime_unit_id,attempt_id,pod_uid,container_id,restart_identity,evidence_key,classification,evidence_refs,observed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'ISOLATED_NODE_MEMORY_EXHAUSTION',$8::jsonb,clock_timestamp())`, [incidentId, unit, attempt, target.podUid, target.runtimeContainerId, target.incarnation, `fixture-incident:${incidentId}`, JSON.stringify([observation])])
    await client.query(`INSERT INTO durable_runtime.failure_incident_state(incident_id,runtime_unit_id,attempt_id,execution_epoch,collection_started_at,deadline_at,state,classification_revision,evidence_ids)
      VALUES($1,$2,$3,1,clock_timestamp(),clock_timestamp()+interval '1 minute','CLASSIFIED',1,$4::text[])`, [incidentId, unit, attempt, [observation]])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  return { target, session, incidentId, scope, domain, controller, shape, profile, classification }
}
export function facts(f: Fixture, capacity: boolean, kind: 'GROW' | 'REPLACE' = 'GROW'): ResourceFacts {
  const caps: CapEvidence = { verified: true, sourceRef: `fixture-capacity-observation:${capacity ? 'available' : 'unavailable'}`,
    policyBytes: (128n * Mi).toString(), unitBudgetBytes: (128n * Mi).toString(), quotaBytes: (128n * Mi).toString(),
    ratioBytes: (128n * Mi).toString(), reservationBytes: (128n * Mi).toString(), admittedEndpoints: [],
    capacityAvailable: capacity, singleWriterBudgetAvailable: capacity }
  const now = Date.now()
  const calculated = evaluateGrowth({ policy, target: f.target, classification: f.classification, classificationTarget: f.target,
    currentAgent: true, profile: f.profile, caps, peak: null, priorResourceWait: false,
    budget: { runtimeUnitId: f.target.runtimeUnitId, sourceRef: 'fixture-budget', dbNowMs: now,
      rollingStartMs: now - policy.rollingMs, episodeGrowth: '0', rollingGrowth: '0', episodeReplacements: '0' } })
  assert.ok(calculated.targetMemoryBytes)
  // Use the exact policy API for the declared target, including capacity=false.
  // Never overwrite false with true to obtain a calculation result.
  const declared: AdmissionShape = { ...f.shape, sourceRef: 'fixture-declared-target', profileId: 'fixture-target-profile',
    containers: [{ ...f.shape.containers[0], memoryBytes: kind === 'REPLACE' ? f.profile.memoryBytes : calculated.targetMemoryBytes,
      cpuMillicores: kind === 'REPLACE' ? f.profile.cpuMillicores : '200' }] }
  return { verification: fixtureEvidence, completeAccountingEvidence: fixtureEvidence, target: f.target,
    classification: f.classification, profile: f.profile, caps, peak: null, declared, admitted: { ...declared }, old: f.shape,
    protectedDemand: { memoryBytes: '0', cpuMillicores: '0' } }
}
export function request(f: Fixture, capacity = true, kind: 'GROW' | 'REPLACE' = 'GROW'): PrepareResourceRequest {
  return { authority: authority(f), controller: f.controller, authorizer: authorizer(), operationKey: randomUUID(), kind,
    incidentId: f.incidentId, policyRevision: '1', workloadProfileKey: 'fixture-workload', expectedUnitRevision: '0',
    expectedIntentRevision: '0', expectedApprovedProfileRevision: '0', expectedClassificationRevision: '1',
    reservationDurationMs: 300, facts: facts(f, capacity, kind) }
}
export async function register(pool: Pool, f: Fixture, memory = (1024n * Mi).toString(), cpu = '10000'): Promise<void> {
  const base = request(f)
  await registerResourcePolicy(pool, { ...base, policy })
  await registerResourceBudgetScope(pool, { ...base, operationKey: `scope:${f.scope}`, expectedRevision: null,
    memoryLimitBytes: memory, cpuLimitMillicores: cpu, settings: { fixtureOnly: true }, evidence: fixtureEvidence })
  await registerResourceUnitHead(pool, { ...base, approvedProfileRevision: '0', policyRevision: '1', approvedShape: f.shape,
    accounted: { memoryBytes: f.profile.memoryBytes, cpuMillicores: f.profile.cpuMillicores }, evidence: fixtureEvidence, bootstrap: 'CURRENT_ACCOUNTED' })
}
export function response(value: MutationOutcome): AllocationResult {
  assert.notEqual(value.status, 'UNCERTAIN')
  if (value.status === 'UNCERTAIN') { throw new Error('fixture COMMIT uncertain') }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Tested module receipt object, with assertions at each use; no authority is manufactured.
  return value.receipt.response as unknown as AllocationResult
}
export async function unitRevision(pool: Pool, f: Fixture): Promise<string> {
  return (await pool.query('SELECT revision FROM durable_runtime.runtime_units WHERE id=$1', [f.target.runtimeUnitId])).rows[0].revision
}
export function hookPool(pool: Pool, hook: (sql: string, execute: () => Promise<QueryResult>, client: PoolClient) => Promise<QueryResult>): Pool {
  const wrapper = Object.create(pool)
  wrapper.connect = async () => {
    const client = await pool.connect()
    return new Proxy(client, { get(target, key) {
      if (key === 'query') { return (sql: string, values: unknown[] = []) => hook(sql, () => client.query(sql, values), client) }
      const member = Reflect.get(target, key); return typeof member === 'function' ? member.bind(target) : member
    } })
  }
  return wrapper
}
export function gate() {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(r => { enter = r }), waiting = new Promise<void>(r => { release = r })
  return { enter, release, entered, waiting }
}
