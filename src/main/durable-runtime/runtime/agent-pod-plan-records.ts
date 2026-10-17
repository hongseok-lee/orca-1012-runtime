import { randomUUID, createHash } from 'node:crypto'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import type { OperationId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, type DurableTransaction } from '../db/connection.ts'
import type { JsonValue } from '../db/atomic.ts'
import type { AgentPodPlanRow, AgentPodPlanRecord, AgentPodPlanWriteResult } from '../db/agent-pod-plan-record-rows.ts'
import { createAgentPodPlanner, type UnauthorizedAgentPodPlan } from './agent-pod-plan.ts'
import { agentPodArray, agentPodFields, agentPodInteger, agentPodText } from './agent-pod-policy.ts'
import { canonicalInput } from './gateway/input.ts'
import { LockedGatewayAuthority } from './gateway/authority.ts'
import type { GatewayContext } from './gateway/types.ts'
import { CLOSED_AGENT_BOOTSTRAP, isClosedAgentBootstrap } from './closed-agent-bootstrap.ts'

export type { AgentPodPlanRecord, AgentPodPlanWriteResult, RecordAgentPodPlan, ReadAgentPodPlan } from '../db/agent-pod-plan-record-rows.ts'

function invalid(): never { throw new DurableDatabaseError('AGENT_POD_PLAN_INPUT_INVALID') }
// Plain own-data snapshot before await. No toJSON/getter execution, mutable
// caller references, sparse arrays, extra symbol keys, or cyclic JSON survive.
function snapshot(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') { return value }
  if (typeof value === 'number' && Number.isFinite(value)) { return value }
  if (typeof value !== 'object' || ancestors.has(value)) { return invalid() }
  ancestors.add(value)
  let result: JsonValue
  if (Array.isArray(value)) { result = agentPodArray(value).map(item => snapshot(item, ancestors)) }
  else {
    if (Object.getPrototypeOf(value) !== Object.prototype) { return invalid() }
    const object: Record<string, JsonValue> = {}
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') { return invalid() }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) { return invalid() }
      Object.defineProperty(object, key, { value: snapshot(descriptor.value, ancestors), enumerable: true })
    }
    result = object
  }
  ancestors.delete(value)
  return result
}
function quantity(value: unknown, suffix: string): number {
  const text = agentPodText(value)
  if (!text.endsWith(suffix) || !/^[1-9][0-9]*$/.test(text.slice(0, -suffix.length))) { return invalid() }
  return agentPodInteger(Number(text.slice(0, -suffix.length)))
}
// Read compatibility only. The original canonical plan/spec bytes are rebuilt,
// never rewritten in storage or accepted as a new legacy-format record.
function legacyClosedPlanForRead(plan: UnauthorizedAgentPodPlan, checkout: string): UnauthorizedAgentPodPlan {
  const annotations = { ...plan.pod.metadata.annotations }
  delete annotations[CLOSED_AGENT_BOOTSTRAP.checkoutAnnotation]
  const container = Object.freeze({ ...plan.pod.spec.containers[0], workingDir: checkout })
  const spec = Object.freeze({ ...plan.pod.spec, containers: Object.freeze([container]) })
  return Object.freeze({ ...plan,
    pod: Object.freeze({ ...plan.pod, metadata: Object.freeze({ ...plan.pod.metadata,
      annotations: Object.freeze(annotations) }), spec }),
    podSpecSHA256: createHash('sha256').update(JSON.stringify(spec)).digest('hex') })
}
function capturePlan(original: unknown) {
  try {
    const json = snapshot(original), encoded = canonicalInput(json)
    const p = agentPodFields(json, ['kind','identity','pod','mountExpectations','podSpecSHA256','readinessObserved','storageGrantIssued','physicalPinIssued'])
    const pod = agentPodFields(p.get('pod'), ['apiVersion','kind','metadata','spec'])
    const metadata = agentPodFields(pod.get('metadata'), ['name','namespace','labels','annotations'])
    const labels = agentPodFields(metadata.get('labels'), ['orca.dev/role','orca.dev/dataset','orca.dev/runtime-unit'])
    const annotationInput = metadata.get('annotations')
    const hasCheckout = annotationInput !== null && typeof annotationInput === 'object' &&
      Object.hasOwn(annotationInput, CLOSED_AGENT_BOOTSTRAP.checkoutAnnotation)
    const annotations = agentPodFields(annotationInput, ['orca.dev/operation-id','orca.dev/attempt-id','orca.dev/execution-epoch','orca.dev/intent-revision','orca.dev/spec-hash','orca.dev/resource-profile-revision',
      ...(hasCheckout ? [CLOSED_AGENT_BOOTSTRAP.checkoutAnnotation] : [])])
    const specValue = pod.get('spec')
    const hasRuntimeAuthentication = specValue !== null && typeof specValue === 'object' && Object.hasOwn(specValue, 'serviceAccountName')
    const spec = agentPodFields(specValue, ['restartPolicy','terminationGracePeriodSeconds','hostNetwork','automountServiceAccountToken','nodeSelector','tolerations','securityContext','affinity','containers','volumes',
      ...(hasRuntimeAuthentication ? ['serviceAccountName'] : [])])
    const containers = agentPodArray(spec.get('containers'))
    if (containers.length !== 1) { return invalid() }
    const container = agentPodFields(containers[0], ['name','image','imagePullPolicy','command','args','workingDir','env','resources','securityContext','volumeMounts'])
    const entrypoint = { command: agentPodArray(container.get('command')), args: agentPodArray(container.get('args')) }
    const closedBootstrap = isClosedAgentBootstrap(entrypoint), legacyClosedRead = closedBootstrap && !hasCheckout
    if (hasCheckout && (!closedBootstrap || container.get('workingDir') !== CLOSED_AGENT_BOOTSTRAP.workingDir)) { return invalid() }
    const checkout = agentPodText(hasCheckout ? annotations.get(CLOSED_AGENT_BOOTSTRAP.checkoutAnnotation) : container.get('workingDir'))
    const env = agentPodArray(container.get('env')).map(item => agentPodFields(item, ['name','value']))
    const envValue = (name: string) => {
      const matches = env.filter(item => item.get('name') === name)
      if (matches.length !== 1) { return invalid() }
      return matches[0].get('value')
    }
    const resources = agentPodFields(container.get('resources'), ['requests','limits'])
    const requests = agentPodFields(resources.get('requests'), ['cpu','memory','ephemeral-storage'])
    const volumes = agentPodArray(spec.get('volumes'))
    const temporary = agentPodFields(volumes.at(-1), ['name','emptyDir'])
    const emptyDir = agentPodFields(temporary.get('emptyDir'), ['sizeLimit'])
    const mounts = agentPodFields(p.get('mountExpectations'), ['protected','shared'])
    const protectedBindings = agentPodArray(mounts.get('protected')).map(item => {
      const b = agentPodFields(item, ['key','bindingId','leafId','claimName','claimUid','pvUid','serverPath','mode','clientPath','server'])
      return { key: b.get('key'), bindingId: b.get('bindingId'), leafId: b.get('leafId'), claimName: b.get('claimName'),
        claimUid: b.get('claimUid'), pvUid: b.get('pvUid'), serverPath: b.get('serverPath'), mode: b.get('mode'),
        clientPath: b.get('clientPath'), server: b.get('server') }
    })
    if (!protectedBindings.length) { return invalid() }
    const shared = agentPodFields(mounts.get('shared'), ['claimName','claimUid','pvUid','serverPath','server','clientPath','mode'])
    const dataset = agentPodText(labels.get('orca.dev/dataset'))
    // Reconstruction validates only the planner's fixed structure and internal
    // digest. Reconstructed policy is NOT authenticated external authority.
    const planner = createAgentPodPlanner({ namespace: metadata.get('namespace'), dataset, image: container.get('image'),
      entrypoint,
      ...(spec.has('serviceAccountName') ? { runtimeAuthentication: { serviceAccountName: spec.get('serviceAccountName'), audience: 'orca-runtime-agent' } } : {}),
      paths: { home: envValue('HOME'), claudeState: envValue('CLAUDE_CONFIG_DIR'), codexState: envValue('CODEX_HOME'), checkout },
      nfsServer: protectedBindings[0].server, protectedExportRoot: `/exports/runtime-domains/${dataset}`,
      protectedMounts: protectedBindings.map(b => ({ key: b.key, clientPath: b.clientPath })),
      shared: { claimName: shared.get('claimName'), claimUid: shared.get('claimUid'), pvUid: shared.get('pvUid'), serverPath: shared.get('serverPath') } })
    const rebuilt = planner.plan({ identity: p.get('identity'),
      protectedBindings: protectedBindings.map(b => ({ key: b.key, bindingId: b.bindingId, leafId: b.leafId,
        claimName: b.claimName, claimUid: b.claimUid, pvUid: b.pvUid, serverPath: b.serverPath, mode: b.mode })),
      profile: { revision: annotations.get('orca.dev/resource-profile-revision'), cpuMilli: quantity(requests.get('cpu'), 'm'),
        memoryMi: quantity(requests.get('memory'), 'Mi'), ephemeralMi: quantity(requests.get('ephemeral-storage'), 'Mi'),
        temporaryMi: quantity(emptyDir.get('sizeLimit'), 'Mi') } })
    const plan = legacyClosedRead ? legacyClosedPlanForRead(rebuilt, checkout) : rebuilt
    if (canonicalInput(snapshot(plan)) !== encoded) { return invalid() }
    return Object.freeze({ plan, encoded, planDigest: createHash('sha256').update(encoded).digest('hex'), dataset, legacyClosedRead })
  } catch { return invalid() }
}

/** Pure strict preparation only; the digest is data, not execution authority. */
export function prepareAgentPodPlan(original: unknown): Readonly<{ plan: UnauthorizedAgentPodPlan; planDigest: string }> {
  const captured = capturePlan(original)
  if (captured.legacyClosedRead) { return invalid() }
  return Object.freeze({ plan: captured.plan, planDigest: captured.planDigest })
}

function projection(row: AgentPodPlanRow): AgentPodPlanRecord {
  try {
    const captured = capturePlan(row.plan), { plan } = captured, id = plan.identity
    if (row.plan_digest !== captured.planDigest || row.operation_id !== id.operationId || row.runtime_unit_id !== id.unitId ||
      row.dataset_name !== captured.dataset || row.attempt_id !== id.attemptId || row.execution_epoch !== id.executionEpoch ||
      row.intent_revision !== id.intentRevision || row.namespace !== plan.pod.metadata.namespace || row.resource_name !== id.resourceName ||
      row.spec_hash !== id.specHash || row.pod_spec_sha256 !== plan.podSpecSHA256 || !(row.recorded_at instanceof Date) ||
      !Number.isFinite(row.recorded_at.getTime())) { throw new Error('Invalid stored Agent Pod plan') }
    return Object.freeze({ plan, planDigest: captured.planDigest, recordedAt: row.recorded_at.toISOString() })
  } catch { throw new DurableDatabaseError('AGENT_POD_PLAN_RECORD_INVALID') }
}

/** Observation only; no locks, lease acquisition, grant or provider effects. */
export async function readAgentPodPlan(tx: DurableTransaction, originalOperationId: OperationId): Promise<AgentPodPlanRecord | null> {
  const operationId = logicalId('operation', originalOperationId), query = tx.query.bind(tx)
  const result = await query<AgentPodPlanRow>('SELECT * FROM durable_runtime.agent_pod_plans WHERE operation_id=$1', [operationId])
  return result.rows[0] ? projection(result.rows[0]) : null
}

/** Immutable UNAUTHORIZED_PLAN, transaction-local until caller observes COMMIT. */
export async function recordAgentPodPlan(tx: DurableTransaction, originalContext: GatewayContext,
  originalPlan: UnauthorizedAgentPodPlan): Promise<AgentPodPlanWriteResult> {
  const captured = capturePlan(originalPlan), { plan } = captured, id = plan.identity, query = tx.query.bind(tx)
  const controller = originalContext.controller
  const context: GatewayContext = Object.freeze({ runtimeUnitId: logicalId('runtime-unit', originalContext.runtimeUnitId),
    operationId: logicalId('operation', originalContext.operationId), controller: Object.freeze({ ...controller,
      scope: agentPodText(controller.scope), owner: agentPodText(controller.owner), term: counter('controller-term', controller.term) }) })
  if (context.runtimeUnitId !== id.unitId || context.operationId !== id.operationId) { throw new DurableDatabaseError('AGENT_POD_PLAN_SCOPE') }
  const authority = await LockedGatewayAuthority.acquire(tx, context)
  const old = await query<AgentPodPlanRow>('SELECT * FROM durable_runtime.agent_pod_plans WHERE operation_id=$1', [id.operationId])
  if (old.rowCount) {
    const record = projection(old.rows[0])
    if (record.planDigest !== captured.planDigest || canonicalInput(snapshot(record.plan)) !== captured.encoded) {
      throw new DurableDatabaseError('AGENT_POD_PLAN_CONFLICT')
    }
    return Object.freeze({ disposition: 'REPLAYED', record })
  }
  if (captured.legacyClosedRead) { return invalid() }
  const values = [context.controller.scope, context.controller.owner, context.controller.term, id.operationId, id.unitId,
    captured.dataset, id.attemptId, id.executionEpoch, id.intentRevision, plan.pod.metadata.namespace,
    id.resourceName, id.specHash, plan.podSpecSHA256, captured.planDigest, captured.encoded]
  await authority.assertCurrent()
  let inserted
  try {
    inserted = await query<AgentPodPlanRow>(`INSERT INTO durable_runtime.agent_pod_plans
      (operation_id,runtime_unit_id,dataset_name,attempt_id,execution_epoch,intent_revision,namespace,resource_name,spec_hash,pod_spec_sha256,plan_digest,plan)
      SELECT $4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb FROM durable_runtime.runtime_units u
      JOIN durable_runtime.operations o ON o.runtime_unit_id=u.id
      WHERE u.id=$5 AND o.id=$4 AND u.dataset_name=$6 AND u.desired_mode='RUNNING'
      AND u.execution_epoch=$8 AND o.execution_epoch=$8 AND u.intent_revision=$9 AND o.intent_revision=$9
      AND o.kind='WAKE' AND o.result IS NULL AND o.external_resource_name=$11
      AND o.controller_scope=$1 AND o.controller_term=$3
      AND EXISTS(SELECT 1 FROM durable_runtime.controller_leases c
        WHERE c.scope=$1 AND c.owner=$2 AND c.term=$3 AND c.expires_at>clock_timestamp()) RETURNING *`, values)
  } catch (error) {
    if (error instanceof DurableDatabaseError && error.code === '23505') { throw new DurableDatabaseError('AGENT_POD_PLAN_CONFLICT') }
    throw error
  }
  if (inserted.rowCount !== 1) { throw new DurableDatabaseError('AGENT_POD_PLAN_STALE') }
  const eventId = randomUUID(), producer = randomUUID()
  const event = JSON.stringify({ kind: 'AGENT_POD_PLAN_RECORDED', operationId: id.operationId, runtimeUnitId: id.unitId,
    reservedAttemptId: id.attemptId, planDigest: captured.planDigest, specHash: id.specHash, podSpecSHA256: plan.podSpecSHA256,
    planKind: plan.kind, storageGrantIssued: false, physicalPinIssued: false, readinessObserved: false })
  const audit = await query(`INSERT INTO durable_runtime.runtime_audit_events
    (id,actor_id,runtime_unit_id,operation_id,kind,next_state,occurred_at,received_at,producer_id,producer_seq,evidence_refs,payload)
    SELECT $1,$2,$3,$4,'AGENT_POD_PLAN_RECORDED',$5::jsonb,clock_timestamp(),clock_timestamp(),$6,1,'[]'::jsonb,'{}'::jsonb
    WHERE EXISTS(SELECT 1 FROM durable_runtime.controller_leases c
      WHERE c.scope=$7 AND c.owner=$2 AND c.term=$8 AND c.expires_at>clock_timestamp()) RETURNING id`,
  [eventId, context.controller.owner, id.unitId, id.operationId, event, producer, context.controller.scope, context.controller.term])
  if (audit.rowCount !== 1) { throw new DurableDatabaseError('AGENT_POD_PLAN_STALE') }
  const outbox = await query(`INSERT INTO durable_runtime.outbox_events(id,aggregate_id,aggregate_kind,revision,event,created_at)
    SELECT $1,u.id,'runtime-unit',u.revision,$3::jsonb,clock_timestamp() FROM durable_runtime.runtime_units u WHERE u.id=$2
    AND EXISTS(SELECT 1 FROM durable_runtime.controller_leases c
      WHERE c.scope=$4 AND c.owner=$5 AND c.term=$6 AND c.expires_at>clock_timestamp()) RETURNING id`,
  [eventId, id.unitId, event, context.controller.scope, context.controller.owner, context.controller.term])
  if (outbox.rowCount !== 1) { throw new DurableDatabaseError('AGENT_POD_PLAN_STALE') }
  await authority.assertCurrent()
  return Object.freeze({ disposition: 'RECORDED', record: projection(inserted.rows[0]) })
}
