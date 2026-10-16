import { createHash } from 'node:crypto'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, type DurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import type { JsonValue } from '../db/atomic.ts'
import type { AdmissionShape } from '../resources/policy/admission.ts'
import { readAgentPodPlan } from './agent-pod-plan-records.ts'
import { agentPodText } from './agent-pod-policy.ts'
import type { UnauthorizedAgentPodPlan } from './agent-pod-plan.ts'
import { LockedGatewayAuthority, currentAuthoritySql } from './gateway/authority.ts'
import { canonicalInput } from './gateway/input.ts'
import type { GatewayContext } from './gateway/types.ts'

export type InitialAgentResourceProfileInput = Readonly<{ planDigest: string; policyRevision: string }>
export type InitialAgentResourceProfileResult = Readonly<{
  disposition: 'RECORDED' | 'REPLAYED'
  visibility: 'TRANSACTION_LOCAL'
  authority: 'DATA_ONLY'
  planDigest: string
  profileRevision: string
  policyRevision: string
  shapeDigest: string
  eventId: string
  unitRevision: string
  admissionObserved: false
  executionAuthorized: false
}>
const kind = 'INITIAL_AGENT_RESOURCE_PROFILE_RECORDED'
const deny = (suffix: string): never => { throw new DurableDatabaseError(`INITIAL_AGENT_PROFILE_${suffix}`) }
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
function eventIdentity(unit: string, revision: string): string {
  const h = digest(`initial-agent-resource-profile:v1:${unit}:${revision}`)
  return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`
}

// The stored plan reader already reconstructs the strict planner and compares
// the complete original bytes/digests. This helper accepts only that plan.
function declaredShape(plan: UnauthorizedAgentPodPlan, planDigest: string): AdmissionShape {
  const container = plan.pod.spec.containers[0], requests = container.resources.requests
  const cpu = /^([1-9][0-9]*)m$/u.exec(requests.cpu)
  const memory = /^([1-9][0-9]*)Mi$/u.exec(requests.memory)
  if (!cpu || !memory) { return deny('PLAN') }
  const revision = plan.pod.metadata.annotations['orca.dev/resource-profile-revision']
  return Object.freeze({ sourceRef: `initial-agent-plan:v1:${planDigest}`,
    profileId: `initial-agent-profile:v1:${plan.identity.unitId}:${revision}`,
    runtimeUnitId: plan.identity.unitId, containerIdentity: container.name,
    observed: false, complete: true,
    containers: Object.freeze([Object.freeze({ name: container.name, memoryBytes: (BigInt(memory[1]) * 1048576n).toString(),
      cpuMillicores: BigInt(cpu[1]).toString(), memoryLimitPresent: false, cpuLimitPresent: false, restartableInit: false })]),
    initContainers: Object.freeze([]), overheadMemoryBytes: '0', overheadCpuMillicores: '0',
    spot: true, oneUnitPerNode: true })
}

/** SQL-only declaration, not admission/accounting or execution permission.
 * The caller owns the outer transaction, must propagate failures to rollback,
 * and must observe settlement before publishing the transaction-local result. */
export async function recordInitialAgentResourceProfile(tx: DurableTransaction, originalContext: GatewayContext,
  original: InitialAgentResourceProfileInput): Promise<InitialAgentResourceProfileResult> {
  const query = tx.query.bind(tx)
  const isLockHeld = tx.isLockHeld.bind(tx), advanceLock = tx.advanceLock.bind(tx), markLockAcquired = tx.markLockAcquired.bind(tx)
  // Keep the original receiver/query through nested reader and lock helpers too.
  const stableTx = new Proxy(tx, { get(target, key, receiver) {
    if (key === 'query') { return query }
    if (key === 'isLockHeld') { return isLockHeld }
    if (key === 'advanceLock') { return advanceLock }
    if (key === 'markLockAcquired') { return markLockAcquired }
    return Reflect.get(target, key, receiver)
  } })
  const c = originalContext.controller
  const context: GatewayContext = Object.freeze({ runtimeUnitId: logicalId('runtime-unit', originalContext.runtimeUnitId),
    operationId: logicalId('operation', originalContext.operationId), controller: Object.freeze({ ...c,
      scope: agentPodText(c.scope), owner: agentPodText(c.owner), term: counter('controller-term', c.term) }) })
  const planDigest = agentPodText(original.planDigest), policyRevision = counter('policy-revision', original.policyRevision)
  if (!/^[0-9a-f]{64}$/u.test(planDigest)) { return deny('INPUT') }
  const record = await readAgentPodPlan(stableTx, context.operationId)
  if (!record || record.planDigest !== planDigest || record.plan.identity.unitId !== context.runtimeUnitId ||
      record.plan.identity.operationId !== context.operationId) { return deny('PLAN') }
  const plan = record.plan, id = plan.identity, dataset = plan.pod.metadata.labels['orca.dev/dataset']
  const revision = counter('profile-revision', plan.pod.metadata.annotations['orca.dev/resource-profile-revision'])
  const shape = declaredShape(plan, planDigest), shapeBody = canonicalInput(shape), shapeDigest = digest(shapeBody)
  const members = async () => (await query<{ session_id: string }>(
    'SELECT session_id FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1 ORDER BY session_id', [id.unitId])).rows.map(r => r.session_id)
  const sessions = await members()
  if (!sessions.length) { return deny('MEMBERS') }
  await lockAggregates(stableTx, { sessionIds: sessions.map(s => logicalId('session', s)), runtimeUnitIds: [id.unitId] })
  if (canonicalInput(await members()) !== canonicalInput(sessions)) { return deny('MEMBERS_CHANGED') }
  if ((await query("SELECT id FROM durable_runtime.sessions WHERE id=ANY($1::uuid[]) AND lifecycle='OPEN'", [sessions])).rowCount !== sessions.length) {
    return deny('SESSION_CLOSED')
  }
  const authority = await LockedGatewayAuthority.acquire(stableTx, context)
  const unit = (await query<{ revision: string; dataset_name: string; desired_mode: string; active_attempt_id: string | null;
    execution_epoch: string; intent_revision: string }>('SELECT * FROM durable_runtime.runtime_units WHERE id=$1', [id.unitId])).rows[0]
  const operation = (await query<{ kind: string; result: JsonValue | null; external_resource_name: string | null;
    execution_epoch: string; intent_revision: string; controller_term: string; expected_pod_uid: string | null }>(
    'SELECT * FROM durable_runtime.operations WHERE id=$1 AND runtime_unit_id=$2', [id.operationId, id.unitId])).rows[0]
  if (!unit || !operation || unit.dataset_name !== dataset || unit.desired_mode !== 'RUNNING' ||
      unit.execution_epoch !== id.executionEpoch || unit.intent_revision !== id.intentRevision ||
      operation.kind !== 'WAKE' || operation.result !== null || operation.external_resource_name !== id.resourceName ||
      operation.execution_epoch !== id.executionEpoch || operation.intent_revision !== id.intentRevision ||
      operation.controller_term !== context.controller.term || operation.expected_pod_uid !== null) { return deny('STALE') }
  if (unit.active_attempt_id !== null ||
      (await query('SELECT id FROM durable_runtime.attempts WHERE runtime_unit_id=$1', [id.unitId])).rowCount ||
      (await query('SELECT id FROM durable_runtime.execution_grants WHERE runtime_unit_id=$1', [id.unitId])).rowCount ||
      (await query('SELECT runtime_unit_id FROM durable_runtime.resource_unit_state WHERE runtime_unit_id=$1', [id.unitId])).rowCount) {
    return deny('NOT_INITIAL')
  }
  const eventId = eventIdentity(id.unitId, revision)
  const temporary = plan.pod.spec.volumes.find(volume => volume.name === 'temporary')
  if (!temporary || !('emptyDir' in temporary)) { return deny('PLAN') }
  const event = { kind, unitId: id.unitId, operationId: id.operationId, profileRevision: revision, policyRevision,
    planDigest, podSpecSHA256: plan.podSpecSHA256, shapeDigest, unitRevision: unit.revision,
    ephemeralStorageRequest: plan.pod.spec.containers[0].resources.requests['ephemeral-storage'],
    ephemeralStorageLimit: plan.pod.spec.containers[0].resources.limits['ephemeral-storage'],
    temporarySizeLimit: temporary.emptyDir.sizeLimit,
    admissionObserved: false, executionAuthorized: false }
  const body = canonicalInput(event)
  const profiles = (await query<{ revision: string; policy_revision: string; container_resources: JsonValue;
    previous_good_revision: string | null; learned_memory_floor: string | null; floor_protected_until: Date | null }>(
    'SELECT * FROM durable_runtime.resource_profiles WHERE runtime_unit_id=$1 ORDER BY revision', [id.unitId])).rows
  const audits = (await query<{ id: string; actor_id: string; operation_id: string | null; resource_profile_revision: string | null;
    previous_state: JsonValue | null; next_state: JsonValue;
    producer_id: string; producer_seq: string; evidence_refs: JsonValue; payload: JsonValue }>(
    'SELECT * FROM durable_runtime.runtime_audit_events WHERE runtime_unit_id=$1 AND kind=$2', [id.unitId, kind])).rows
  const outboxes = (await query<{ id: string; aggregate_kind: string; revision: string; event: JsonValue }>(
    "SELECT * FROM durable_runtime.outbox_events WHERE aggregate_id=$1 AND event->>'kind'=$2", [id.unitId, kind])).rows
  const result = (disposition: 'RECORDED' | 'REPLAYED'): InitialAgentResourceProfileResult => Object.freeze({
    disposition, visibility: 'TRANSACTION_LOCAL', authority: 'DATA_ONLY', planDigest, profileRevision: revision,
    policyRevision, shapeDigest, eventId, unitRevision: unit.revision, admissionObserved: false, executionAuthorized: false })
  if (profiles.length || audits.length || outboxes.length) {
    const p = profiles[0], a = audits[0], o = outboxes[0]
    if (profiles.length !== 1 || audits.length !== 1 || outboxes.length !== 1 || !p || !a || !o ||
        p.revision !== revision || p.policy_revision !== policyRevision || canonicalInput(p.container_resources) !== shapeBody ||
        p.previous_good_revision !== null || p.learned_memory_floor !== null || p.floor_protected_until !== null ||
        a.id !== eventId || a.operation_id !== id.operationId || a.actor_id !== context.controller.owner ||
        a.resource_profile_revision !== revision || a.previous_state !== null ||
        a.producer_id !== eventId || a.producer_seq !== '1' || canonicalInput(a.next_state) !== body ||
        canonicalInput(a.evidence_refs) !== '[]' || canonicalInput(a.payload) !== '{}' ||
        o.id !== eventId || o.aggregate_kind !== 'runtime-unit' || o.revision !== unit.revision || canonicalInput(o.event) !== body) {
      return deny('CONFLICT')
    }
    await authority.assertCurrent()
    return result('REPLAYED')
  }
  const auth = [context.controller.scope, context.controller.owner, context.controller.term]
  async function write(sql: string, values: readonly unknown[]): Promise<void> {
    if ((await query(sql, [...auth, ...values])).rowCount !== 1) { return deny('STALE') }
  }
  await write(`INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision,previous_good_revision)
    SELECT $4,$5,$6::jsonb,$7,NULL WHERE ${currentAuthoritySql} RETURNING revision`, [id.unitId, revision, shapeBody, policyRevision])
  await write(`INSERT INTO durable_runtime.runtime_audit_events(id,actor_id,runtime_unit_id,operation_id,resource_profile_revision,kind,next_state,
    occurred_at,received_at,producer_id,producer_seq,evidence_refs,payload)
    SELECT $4,$2,$5,$6,$7,'INITIAL_AGENT_RESOURCE_PROFILE_RECORDED',$8::jsonb,clock_timestamp(),clock_timestamp(),$4,1,'[]'::jsonb,'{}'::jsonb
    WHERE ${currentAuthoritySql} RETURNING id`, [eventId, id.unitId, id.operationId, revision, body])
  await write(`INSERT INTO durable_runtime.outbox_events(id,aggregate_id,aggregate_kind,revision,event,created_at)
    SELECT $4,$5,'runtime-unit',$6,$7::jsonb,clock_timestamp() WHERE ${currentAuthoritySql} RETURNING id`, [eventId, id.unitId, unit.revision, body])
  await authority.assertCurrent()
  return result('RECORDED')
}
