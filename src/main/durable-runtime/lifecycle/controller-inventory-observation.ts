import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, runDurableTransaction, type DurableTransactionResult } from '../db/connection.ts'
import { CONTROLLER_DATASET, CONTROLLER_SCOPE } from '../ha/instance.ts'
import type { ControllerInventoryContext } from '../ha/pass.ts'
import { LockedGatewayAuthority } from '../runtime/gateway/authority.ts'
import { inputDigest } from '../runtime/gateway/input.ts'
import type { JsonValue } from '../runtime/gateway/types.ts'
import { readAgentPodPlan } from '../runtime/agent-pod-plan-records.ts'
import { inventoryNamespace, inventoryName, inventoryOpaque } from './kubernetes-identity.ts'
import type { ResourceWatchEvent } from './watch.ts'

export type ControllerInventoryPersistence = Readonly<{
  disposition: 'RECORDED' | 'REPLAYED' | 'TARGET_UNBOUND' | 'CONFLICT'
}>
type Target = { dataset_name: string; unit_epoch: string; revision: string; controller_scope: string;
  operation_epoch: string; external_resource_name: string | null; expected_pod_uid: string | null;
  attempt_id: string | null; pod_uid: string | null; attempt_epoch: string | null }

// An operation-local observer journal namespace, never an Agent producer or authority.
function observerProducer(operationId: string): string {
  const h = createHash('sha256').update(`controller-inventory:v1:${CONTROLLER_SCOPE}:${operationId}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}
function disposition(value: ControllerInventoryPersistence['disposition']): ControllerInventoryPersistence {
  return Object.freeze({ disposition: value })
}

function replaysObservation(stored: unknown, original: Readonly<Record<string, JsonValue>>): boolean {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) { return false }
  for (const [field, value] of Object.entries(original)) {
    if (!Object.hasOwn(stored, field) || Reflect.get(stored, field) !== value) { return false }
  }
  const verification = Reflect.get(stored, 'specHashVerification'), version = Reflect.get(stored, 'observationVersion')
  const planDigest = Reflect.get(stored, 'planDigest')
  let payload: Readonly<Record<string, JsonValue>>
  if (version === undefined && verification === 'UNAVAILABLE' && planDigest === undefined) {
    // Original v1 history remains UNAVAILABLE even after a plan is recorded later.
    payload = { ...original, specHashVerification: verification }
  } else if (version === 2 && verification === 'UNAVAILABLE' && planDigest === undefined) {
    payload = { ...original, observationVersion: version, specHashVerification: verification }
  } else if (version === 2 && verification === 'MATCHED' && typeof planDigest === 'string' && /^[0-9a-f]{64}$/u.test(planDigest)) {
    payload = { ...original, observationVersion: version, specHashVerification: verification, planDigest }
  } else { return false }
  return Reflect.get(stored, 'observationHash') === inputDigest(payload)
}

/** Authenticated transport observation only. Caller supplies the private live pass identity;
 * no Pod, attempt, grant, activity, provider freshness or physical-stop state is changed. */
export async function persistControllerInventoryObservation(pool: Pool,
  policy: Readonly<{ datasetName: string; namespace: string }>,
  caller: Exclude<ResourceWatchEvent, { type: 'BOOKMARK' }>, source: 'LIST' | 'WATCH',
  pass: ControllerInventoryContext): Promise<DurableTransactionResult<ControllerInventoryPersistence>> {
  const datasetName = policy.datasetName, namespace = inventoryNamespace(policy.namespace)
  const controller = Object.freeze({ ...pass.controller, owner: inventoryOpaque(pass.controller.owner),
    term: counter('controller-term', pass.controller.term) }), signal = pass.signal
  const object = caller.object, type = caller.type
  const observed = Object.freeze({ namespace: inventoryNamespace(object.namespace), name: inventoryName(object.name),
    uid: inventoryOpaque(object.uid), unitId: logicalId('runtime-unit', object.unitId),
    operationId: logicalId('operation', object.operationId), executionEpoch: counter('execution-epoch', object.executionEpoch),
    resourceVersion: inventoryOpaque(object.resourceVersion), observedSpecHash: inventoryOpaque(object.specHash) })
  if (datasetName !== CONTROLLER_DATASET || controller.scope !== CONTROLLER_SCOPE || observed.namespace !== namespace ||
      !['ADDED', 'MODIFIED', 'DELETED'].includes(type) || !['LIST', 'WATCH'].includes(source) ||
      !/^[0-9a-f]{64}$/u.test(observed.observedSpecHash)) {
    throw new DurableDatabaseError('CONTROLLER_INVENTORY_INPUT')
  }
  const check = () => { if (signal.aborted) { throw new DurableDatabaseError('CONTROLLER_PASS_CANCELLED') } }
  check()
  const key = JSON.stringify([namespace, observed.name, observed.uid, observed.resourceVersion,
    type, observed.operationId, observed.executionEpoch])
  // LIST/WATCH may replay the same exact object; original source/owner/time remain in the first audit.
  const originalPayload = Object.freeze({ kind: 'CONTROLLER_INVENTORY_OBSERVATION', type, datasetName, ...observed,
    physicalFenceVerified: false })
  const producer = observerProducer(observed.operationId)
  const context = Object.freeze({ controller, runtimeUnitId: observed.unitId, operationId: observed.operationId })
  return runDurableTransaction(pool, async tx => {
    check()
    const known = await tx.query<{ dataset_name: string; controller_scope: string; runtime_unit_id: string }>(
      `SELECT o.id,u.dataset_name,o.controller_scope,o.runtime_unit_id FROM durable_runtime.runtime_units u
      CROSS JOIN durable_runtime.operations o WHERE u.id=$1 AND o.id=$2`,
      [observed.unitId, observed.operationId])
    check()
    if (known.rowCount !== 1) { return disposition('TARGET_UNBOUND') }
    if (known.rows[0].dataset_name !== datasetName || known.rows[0].controller_scope !== controller.scope ||
        known.rows[0].runtime_unit_id !== observed.unitId) { return disposition('CONFLICT') }
    // Unit -> operation -> controller lease, then a fresh DB clock check after any lock wait.
    const authority = await LockedGatewayAuthority.acquire(tx, context)
    check()
    const target = (await tx.query<Target>(`SELECT u.dataset_name,u.execution_epoch AS unit_epoch,u.revision,
      o.controller_scope,o.execution_epoch AS operation_epoch,o.external_resource_name,o.expected_pod_uid,
      a.id AS attempt_id,a.pod_uid,a.execution_epoch AS attempt_epoch
      FROM durable_runtime.runtime_units u JOIN durable_runtime.operations o ON o.runtime_unit_id=u.id
      LEFT JOIN durable_runtime.attempts a ON a.id=u.active_attempt_id AND a.runtime_unit_id=u.id
      WHERE u.id=$1 AND o.id=$2`, [observed.unitId, observed.operationId])).rows[0]
    check()
    if (!target) { return disposition('TARGET_UNBOUND') }
    if (target.dataset_name !== datasetName || target.controller_scope !== controller.scope ||
        target.external_resource_name !== observed.name || target.unit_epoch !== observed.executionEpoch ||
        target.operation_epoch !== observed.executionEpoch) { return disposition('CONFLICT') }
    if (target.attempt_id === null || target.pod_uid === null) { return disposition('TARGET_UNBOUND') }
    if (target.pod_uid !== observed.uid || target.attempt_epoch !== observed.executionEpoch ||
        (target.expected_pod_uid !== null && target.expected_pod_uid !== observed.uid)) { return disposition('CONFLICT') }
    const old = await tx.query<{ next_state: unknown }>(`SELECT next_state
      FROM durable_runtime.runtime_audit_events WHERE runtime_unit_id=$1 AND operation_id=$2
      AND kind='CONTROLLER_INVENTORY_OBSERVATION' AND next_state->>'observationKey'=$3`,
      [observed.unitId, observed.operationId, key])
    check()
    await authority.assertCurrent()
    check()
    if (old.rowCount) {
      return disposition(old.rowCount === 1 && replaysObservation(old.rows[0].next_state, originalPayload) ? 'REPLAYED' : 'CONFLICT')
    }
    // Read only after the original target checks and first-observation replay. Stored plans do not issue authority.
    const record = await readAgentPodPlan(tx, observed.operationId)
    check()
    let verification: Readonly<{ specHashVerification: 'UNAVAILABLE' } | { specHashVerification: 'MATCHED'; planDigest: string }> =
      Object.freeze({ specHashVerification: 'UNAVAILABLE' })
    if (record) {
      const plan = record.plan, identity = plan.identity
      if (plan.pod.metadata.labels['orca.dev/dataset'] !== datasetName || identity.unitId !== observed.unitId ||
          identity.operationId !== observed.operationId || identity.attemptId !== target.attempt_id ||
          identity.executionEpoch !== observed.executionEpoch || plan.pod.metadata.namespace !== observed.namespace ||
          plan.pod.metadata.name !== observed.name || identity.resourceName !== observed.name ||
          identity.specHash !== observed.observedSpecHash) { return disposition('CONFLICT') }
      verification = Object.freeze({ specHashVerification: 'MATCHED', planDigest: record.planDigest })
    }
    const payload = Object.freeze({ ...originalPayload, observationVersion: 2, ...verification })
    const payloadHash = inputDigest(payload)
    // This sequence is allocated under the Unit/operation locks. RV remains opaque event data.
    const sequence = (await tx.query<{ sequence: string }>(`SELECT (coalesce(max(producer_seq),0)+1)::text AS sequence
      FROM durable_runtime.runtime_audit_events WHERE producer_id=$1`, [producer])).rows[0].sequence
    const event = Object.freeze({ ...payload, source, observationKey: key, observationHash: payloadHash })
    const values = [randomUUID(), controller.owner, observed.unitId, observed.operationId, target.attempt_id,
      observed.uid, JSON.stringify(event), producer, counter('sequence:producer', sequence), controller.scope, controller.term]
    check()
    const inserted = await tx.query(`INSERT INTO durable_runtime.runtime_audit_events
      (id,actor_id,runtime_unit_id,operation_id,attempt_id,pod_uid,kind,next_state,occurred_at,received_at,
       producer_id,producer_seq,evidence_refs,payload)
      SELECT $1,$2,$3,$4,$5,$6,'CONTROLLER_INVENTORY_OBSERVATION',$7::jsonb,clock_timestamp(),clock_timestamp(),
        $8,$9,'[]'::jsonb,'{}'::jsonb
      WHERE EXISTS(SELECT 1 FROM durable_runtime.controller_leases c
        WHERE c.scope=$10 AND c.owner=$2 AND c.term=$11 AND c.expires_at>clock_timestamp()) RETURNING id`, values)
    if (inserted.rowCount !== 1) { throw new DurableDatabaseError('COMMAND_AUTHORITY_STALE') }
    check()
    const outbox = await tx.query(`INSERT INTO durable_runtime.outbox_events
      (id,aggregate_id,aggregate_kind,revision,event,created_at)
      SELECT $1,$2,'runtime-unit',$3,$4::jsonb,clock_timestamp()
      WHERE EXISTS(SELECT 1 FROM durable_runtime.controller_leases c
        WHERE c.scope=$5 AND c.owner=$6 AND c.term=$7 AND c.expires_at>clock_timestamp()) RETURNING id`,
      [values[0], observed.unitId, target.revision, JSON.stringify(event), controller.scope, controller.owner, controller.term])
    if (outbox.rowCount !== 1) { throw new DurableDatabaseError('COMMAND_AUTHORITY_STALE') }
    check()
    await authority.assertCurrent()
    check()
    return disposition('RECORDED')
  })
}
