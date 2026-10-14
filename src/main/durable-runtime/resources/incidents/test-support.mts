import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient, QueryResult } from 'pg'
import { logicalId, counter } from '../../../../shared/durable-runtime/identity.ts'
import type { SessionId } from '../../../../shared/durable-runtime/identity.ts'
import type { FailureObservationInput, FailureTarget } from '../evidence/types.ts'
import type { VerifiedEvidence } from '../../runtime/runtime-evidence.ts'
import type { MutationOutcome, JsonValue } from '../../db/atomic.ts'
import { DurableDatabaseError } from '../../db/connection.ts'
import { prepareFailureObservation } from '../evidence/normalize.ts'
import { claimRuntimeEvent } from '../../events/store.ts'
import type { EventClaim, ConsumerAuthority, EventRecord } from '../../events/types.ts'
import type { IncidentIngressInput } from './prepare.ts'
import type { RecordFailureResult } from './types.ts'

// These nominal assertions are verification inputs only. No collector,
// workload authentication, Agent termination or production authority is proven.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Static fixture-only upstream brand; no product verification factory is installed.
export const fixtureProof = { evidenceRef: 'p121-fixture-verification', observedAt: '2026-10-13T12:00:00Z' } as VerifiedEvidence

export type Fixture = {
  target: FailureTarget
  agentId: string
  sessionId: SessionId
}
export async function fixture(pool: Pool): Promise<Fixture> {
  const unit = logicalId('runtime-unit', randomUUID()); const attempt = logicalId('attempt', randomUUID())
  const agent = randomUUID(); const session = logicalId('session', randomUUID()); const workspace = randomUUID()
  const binding = randomUUID(); const backend = `p121-fixture-${randomUUID()}`
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture physical refs; never a VerifiedWorkloadIdentity or stopped/fencing proof.
  const podUid = `fixture-pod-${randomUUID()}` as FailureTarget['podUid']
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture original incarnation, matched to its actual PG attempt.
  const incarnation = `fixture-incarnation-${randomUUID()}` as FailureTarget['incarnation']
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase,execution_epoch) VALUES($1,'RUNNING','READY',1)", [unit])
    await client.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',1)", [unit])
    await client.query("INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,resource_profile_revision,effective_resources,status) VALUES($1,$2,1,'COLD',$3,$4,0,'{}','READY')", [attempt, unit, podUid, incarnation])
    await client.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=$2 WHERE id=$1', [unit, attempt])
    await client.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'p121-fixture')", [agent])
    await client.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'p121-fixture','READY')", [workspace, randomUUID()])
    await client.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [session, agent, workspace])
    await client.query("INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,'fixture-export')", [backend])
    await client.query("INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state) VALUES($1,$2,'fixture-export','/fixture','RO')", [binding, backend])
    await client.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)', [unit, session, binding])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  return { target: { runtimeUnitId: unit, attemptId: attempt, podUid, executionEpoch: counter('execution-epoch', '1'),
    containerName: 'agent', runtimeContainerId: `containerd://fixture-${randomUUID()}`, incarnation }, agentId: agent, sessionId: session }
}

export function observation(f: Fixture, overrides: Partial<FailureObservationInput> = {}): FailureObservationInput {
  const base: FailureObservationInput = {
    observationId: `observation:${randomUUID()}`, sourceDedupKey: `source:${randomUUID()}`,
    sourceKind: 'KUBERNETES', sourceRef: `fixture-source:${randomUUID()}`, target: { ...f.target },
    observedAt: new Date('2026-10-13T12:00:01.000Z'), sourceAuthenticated: true,
    termination: { state: 'LAST', containerId: f.target.runtimeContainerId!, incarnation: f.target.incarnation!,
      processIdentity: 'fixture-process', finishedAt: '2026-10-13T12:00:00.123456789Z', startedAt: null,
      exitCode: 137, signal: 9, reason: 'OOMKilled' },
    counterTransition: null,
    signals: { oomKilled: true, memoryEviction: false, nodeOom: false, limitOom: false,
      heapLimit: false, childOom: false, parentAlive: null, otherTermination: false },
    resources: null, placement: null, workloadKind: 'AGENT', profileVerified: true, defaultLimitlessProfile: true,
    affectedWorkIds: [], gaps: [], evidence: { fixtureProjection: true }, ...overrides
  }
  const prepared = prepareFailureObservation(base)
  if (!prepared.canonicalKey) { return base }
  const provenance = { target: { ...base.target }, eventKey: prepared.canonicalKey,
    sourceRef: base.sourceRef, observedAt: '2026-10-13T12:00:00.123456789Z' }
  const values = { memoryRequest: '1Gi', memoryLimit: null, cpuRequest: '1', cpuLimit: null }
  return { ...base, resources: overrides.resources === undefined ? {
    desired: { ...values }, observedSpec: { ...values }, observedStatus: null,
    admitted: { values: { ...values }, provenance }, applied: { values: { ...values }, provenance }
  } : overrides.resources, placement: overrides.placement === undefined ? {
    batchId: 'fixture-original-placement', nodeUid: 'fixture-node', targetPodUid: base.target.podUid,
    complete: true, otherUserPodUids: [], platformPodUids: [], unknownPodUids: [], provenance
  } : overrides.placement }
}
export function request(f: Fixture, raw = observation(f)): IncidentIngressInput {
  return { observation: raw, runtimeEventId: null, sessionIds: [f.sessionId], verifiedSource: fixtureProof,
    collectionPolicy: { revision: 'fixture-collection-v1', budgetMs: 60000 },
    receiptKey: { principalId: 'p121-fixture-collector', sessionScope: `unit:${f.target.runtimeUnitId}`,
      method: 'resource-failure.ingest', operationKey: raw.observationId } }
}
export function result(outcome: MutationOutcome): RecordFailureResult {
  assert.notEqual(outcome.status, 'UNCERTAIN')
  if (outcome.status === 'UNCERTAIN') { throw new Error('fixture commit uncertain') }
  const response = outcome.receipt.response
  assert.ok(response && typeof response === 'object' && !Array.isArray(response))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The tested module's object receipt; shape checks and fixture assertions follow.
  return response as unknown as RecordFailureResult
}
export async function unitRow(pool: Pool, f: Fixture): Promise<JsonValue> {
  return (await pool.query('SELECT to_jsonb(u) AS value FROM durable_runtime.runtime_units u WHERE id=$1', [f.target.runtimeUnitId])).rows[0].value
}
export async function stateRow(pool: Pool, incidentId: string) {
  return (await pool.query(`SELECT *,collection_started_at::text AS original_start,deadline_at::text AS original_deadline
    FROM durable_runtime.failure_incident_state WHERE incident_id=$1`, [incidentId])).rows[0]
}
export async function count(pool: Pool, table: 'failure_incidents' | 'failure_observations', f: Fixture): Promise<string> {
  return (await pool.query(`SELECT count(*) AS n FROM durable_runtime.${table} WHERE runtime_unit_id=$1`, [f.target.runtimeUnitId])).rows[0].n
}
export async function errorCode(action: () => Promise<unknown>, expected: string): Promise<void> {
  await assert.rejects(action, error => error instanceof DurableDatabaseError && error.code === expected)
}
export function hookPool(pool: Pool, hook: (sql: string, execute: () => Promise<QueryResult>) => Promise<QueryResult>): Pool {
  const copy = Object.create(pool)
  copy.connect = async () => {
    const client: PoolClient = await pool.connect()
    return new Proxy(client, { get(target, key) {
      if (key === 'query') {
        return (sql: string, values: unknown[] = []) => hook(sql, () => client.query(sql, values))
      }
      const member = Reflect.get(target, key)
      return typeof member === 'function' ? member.bind(target) : member
    } })
  }
  return copy
}
export function gate() {
  let enter!: () => void; let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }); const waiting = new Promise<void>(resolve => { release = resolve })
  return { enter, release, entered, waiting }
}

export async function queueClaim(pool: Pool, f: Fixture, raw: FailureObservationInput): Promise<EventClaim> {
  const producer = randomUUID(); const event = randomUUID(); const scope = `p121-fixture:${randomUUID()}`
  const authority: ConsumerAuthority = { scope, owner: 'p121-fixture-controller', term: counter('controller-term', '1') }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,$2,1,clock_timestamp()+interval '60 seconds')", [scope, authority.owner])
    await client.query('INSERT INTO durable_runtime.runtime_event_producers(producer_id,incarnation,agent_id,runtime_unit_id,attempt_id,pod_uid,execution_epoch,committed_through) VALUES($1,$2,$3,$4,$5,$6,$7,1)',
      [producer, f.target.incarnation, f.agentId, f.target.runtimeUnitId, f.target.attemptId, f.target.podUid, f.target.executionEpoch])
    await client.query("INSERT INTO durable_runtime.runtime_event_queue(event_id,producer_id,incarnation,producer_seq,agent_id,payload,state) VALUES($1,$2,$3,1,$4,$5,'PENDING')",
      [event, producer, f.target.incarnation, f.agentId, JSON.stringify({ kind: 'RESOURCE_FAILURE_EVIDENCE', observation: raw })])
    await client.query('INSERT INTO durable_runtime.runtime_event_targets(event_id,session_id,agent_id) VALUES($1,$2,$3)', [event, f.sessionId, f.agentId])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  const claimed = await claimRuntimeEvent(pool, { producerId: logicalId('producer', producer), incarnation: f.target.incarnation! }, authority, { claimDurationMs: 60000 })
  assert.equal(claimed.status, 'CLAIMED')
  if (claimed.status !== 'CLAIMED') { throw new Error('fixture claim unavailable') }
  return claimed.claim
}
export function decode(event: EventRecord) {
  const payload = event.payload
  assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload))
  assert.equal(payload.kind, 'RESOURCE_FAILURE_EVIDENCE')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Actual PG payload is revalidated by the evidence normalizer and the original PG binding checks; this is fixture data, not authentication.
  const raw = payload.observation as unknown as FailureObservationInput
  return { observation: raw, verifiedSource: fixtureProof }
}
