import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { CONTROLLER_DATASET, CONTROLLER_SCOPE } from '../ha/instance.ts'
import { createControllerWorker } from '../ha/worker.ts'
import { gate, observedPool, until } from '../ha/worker-fixtures.mts'
import type { ControllerInventoryContext } from '../ha/pass.ts'
import { persistControllerInventoryObservation } from '../lifecycle/controller-inventory-observation.ts'
import { initializeLifecycleScope } from '../lifecycle/intent.ts'
import type { ListedResource, ResourceWatchEvent } from '../lifecycle/watch.ts'
import { createAgentPodPlanner } from './agent-pod-plan.ts'
import { createAgentPodPlanPersistence } from './agent-pod-plan-persistence.ts'
import { readAgentPodPlan } from './agent-pod-plan-records.ts'
import { inputDigest } from './gateway/input.ts'

if (process.env.ORCA_AGENT_POD_PLAN_PERSISTENCE_APPROVED !== 'root-ready' ||
    !/^orca_agent_pod_plan_[a-z0-9_]+$/u.test(process.env.PGDATABASE ?? '')) {
  throw new Error('Root first plan-persistence assignment and isolated schema-ready database required')
}

test('actual planner record and inventory preserve original unverified history and match only the stored logical plan', async t => {
  const pool = createDurablePool({ max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000 })
  const observer = createDurablePool({ max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000 })
  const namespace = 'agent-plan-persistence-fixture'
  const fresh = { unit: randomUUID(), operation: randomUUID(), attempt: randomUUID(), uid: `fixture-${randomUUID()}` }
  const late = { unit: randomUUID(), operation: randomUUID(), attempt: randomUUID(), uid: `fixture-${randomUUID()}` }
  const callback = gate(), begin = gate()
  let provide!: (context: ControllerInventoryContext) => void
  const originalPass = new Promise<ControllerInventoryContext>(resolve => { provide = resolve })
  const marker: ListedResource = { namespace, name: `orca-unit-${fresh.operation}`, uid: fresh.uid,
    unitId: fresh.unit, operationId: fresh.operation, executionEpoch: '0', resourceVersion: 'context-only-rv', specHash: 'a'.repeat(64) }
  const worker = createControllerWorker(pool, {
    lease: { revision: 'agent-plan-persistence-fixture', durationMs: 120000 }, renewIntervalMs: 60000,
    standbyPollIntervalMs: 100000, passPollIntervalMs: 100000, maximumWork: 1, externalBudgetMs: 30000
  }, { inventory: { transport: {
    list: async () => ({ resourceVersion: 'context-only-list', objects: [marker] }),
    watch: async () => ({ status: 'EVENTS', resourceVersion: 'context-only-watch', events: [] }),
    get: async () => null
  }, async sink(_event, _source, context) { provide(context); callback.signal(); await callback.wait } } })
  t.after(async () => {
    begin.release(); callback.release(); await worker.stop()
    await Promise.all([pool.end(), observer.end()])
  })
  await withDurableTransaction(pool, initializeLifecycleScope)
  assert.equal(worker.start(), true)
  await until(() => worker.snapshot().inFlight.callbacks === 1)
  const pass = await originalPass // The actual worker supplies the private verified identity; no test brand/cast.
  const context = (target: typeof fresh) => ({ controller: pass.controller,
    runtimeUnitId: logicalId('runtime-unit', target.unit), operationId: logicalId('operation', target.operation) })
  const policy = { namespace, dataset: CONTROLLER_DATASET, image: `fixture.invalid/agent@sha256:${'1'.repeat(64)}`,
    entrypoint: { command: ['/opt/agent/entrypoint'], args: ['--resume-mode', 'cold'] },
    paths: { home: '/agent/home', claudeState: '/agent/home/.claude', codexState: '/agent/home/.codex', checkout: '/agent/project' },
    protectedMounts: [{ key: 'main', clientPath: '/agent' }], nfsServer: 'fixture.invalid',
    protectedExportRoot: `/exports/runtime-domains/${CONTROLLER_DATASET}`,
    shared: { claimName: 'fixture-shared', claimUid: 'fixture-shared-claim', pvUid: 'fixture-shared-pv', serverPath: `/exports/shared/${CONTROLLER_DATASET}` } }
  const bindings = new Map([fresh, late].map(target => [target.unit, { binding: randomUUID(), leaf: randomUUID() }]))
  function request(target: typeof fresh) {
    const binding = bindings.get(target.unit); assert.ok(binding)
    return { identity: { unitId: target.unit, operationId: target.operation, attemptId: target.attempt,
      resourceName: `orca-unit-${target.operation}`, executionEpoch: '0', intentRevision: '0', specHash: 'a'.repeat(64) },
      protectedBindings: [{ key: 'main', bindingId: binding.binding, leafId: binding.leaf, claimName: `fixture-protected-${target.unit}`,
        claimUid: `fixture-claim-${target.unit}`, pvUid: `fixture-pv-${target.unit}`,
        serverPath: `/exports/runtime-domains/${CONTROLLER_DATASET}/${binding.leaf}`, mode: 'RW' as const }],
      profile: { revision: '0', cpuMilli: 250, memoryMi: 1024, ephemeralMi: 1024, temporaryMi: 256 } }
  }
  function observation(target: typeof fresh, resourceVersion: string, specHash = 'a'.repeat(64)): Exclude<ResourceWatchEvent, { type: 'BOOKMARK' }> {
    return { type: 'ADDED', object: { namespace, name: `orca-unit-${target.operation}`, uid: target.uid,
      unitId: target.unit, operationId: target.operation, executionEpoch: '0', resourceVersion, specHash } }
  }
  async function bindObservedAttempt(target: typeof fresh) {
    await withDurableTransaction(pool, async tx => {
      await tx.query(`INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,
        resource_profile_revision,effective_resources,status) VALUES($1,$2,0,'COLD',$3,'fixture',0,'{}','RUNNING')`,
      [target.attempt, target.unit, target.uid])
      await tx.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=$2 WHERE id=$1', [target.unit, target.attempt])
    })
  }
  async function inventoryRows(target: typeof fresh) {
    return (await observer.query(`SELECT id,next_state,producer_id,producer_seq FROM durable_runtime.runtime_audit_events
      WHERE runtime_unit_id=$1 AND operation_id=$2 AND kind='CONTROLLER_INVENTORY_OBSERVATION' ORDER BY producer_seq`,
    [target.unit, target.operation])).rows
  }
  async function inventoryOutbox(target: typeof fresh) {
    return (await observer.query(`SELECT id,event FROM durable_runtime.outbox_events
      WHERE aggregate_id=$1 AND event->>'kind'='CONTROLLER_INVENTORY_OBSERVATION' ORDER BY id`, [target.unit])).rows
  }
  const scope = Object.freeze({ datasetName: CONTROLLER_DATASET, namespace })
  const ledger = (await observer.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  await withDurableTransaction(pool, async tx => {
    for (const target of [fresh, late]) {
      await tx.query("INSERT INTO durable_runtime.runtime_units(id,dataset_name,desired_mode,phase) VALUES($1,$2,'RUNNING','READY')", [target.unit, CONTROLLER_DATASET])
      await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0)", [target.unit])
      await tx.query(`INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,
        controller_term,step,execution_epoch,external_resource_name)
        VALUES($1,$2,'WAKE',0,$3,$4,'ENSURE_ATTEMPT',0,$5)`,
      [target.operation, target.unit, CONTROLLER_SCOPE, pass.controller.term, `orca-unit-${target.operation}`])
    }
  })
  await bindObservedAttempt(late)
  const unavailable = await persistControllerInventoryObservation(pool, scope, observation(late, 'before-plan-rv'), 'LIST', pass)
  assert.ok(unavailable.ok); assert.equal(unavailable.cleanupFailed, false); assert.equal(unavailable.value.disposition, 'RECORDED')
  const first = (await inventoryRows(late))[0]
  assert.equal(first.next_state.specHashVerification, 'UNAVAILABLE'); assert.equal('planDigest' in first.next_state, false)
  // Seed one exact pre-versioned observation using its original public history fields, not an alternate reader.
  const raw = observation(late, 'legacy-v1-rv').object
  const legacyPayload = { kind: 'CONTROLLER_INVENTORY_OBSERVATION', type: 'ADDED', datasetName: CONTROLLER_DATASET,
    namespace: raw.namespace, name: raw.name, uid: raw.uid, unitId: raw.unitId, operationId: raw.operationId,
    executionEpoch: raw.executionEpoch, resourceVersion: raw.resourceVersion, observedSpecHash: raw.specHash,
    specHashVerification: 'UNAVAILABLE', physicalFenceVerified: false }
  const legacyEvent = { ...legacyPayload, source: 'LIST', observationKey: JSON.stringify([namespace, raw.name, raw.uid,
    raw.resourceVersion, 'ADDED', raw.operationId, raw.executionEpoch]), observationHash: inputDigest(legacyPayload) }
  await withDurableTransaction(pool, async tx => {
    const id = randomUUID()
    await tx.query(`INSERT INTO durable_runtime.runtime_audit_events(id,actor_id,runtime_unit_id,operation_id,attempt_id,pod_uid,
      kind,next_state,occurred_at,received_at,producer_id,producer_seq,evidence_refs,payload)
      VALUES($1,$2,$3,$4,$5,$6,'CONTROLLER_INVENTORY_OBSERVATION',$7::jsonb,clock_timestamp(),clock_timestamp(),$8,2,'[]','{}')`,
    [id, pass.controller.owner, late.unit, late.operation, late.attempt, late.uid, JSON.stringify(legacyEvent), first.producer_id])
    await tx.query(`INSERT INTO durable_runtime.outbox_events(id,aggregate_id,aggregate_kind,revision,event,created_at)
      VALUES($1,$2,'runtime-unit',0,$3::jsonb,clock_timestamp())`, [id, late.unit, JSON.stringify(legacyEvent)])
  })
  const originalUnavailableRows = await inventoryRows(late), originalUnavailableOutbox = await inventoryOutbox(late)
  let holdBegin = true
  const recordingPool = observedPool(pool, async (sql, _values, _client, execute) => {
    if (holdBegin && sql === 'BEGIN ISOLATION LEVEL READ COMMITTED') { holdBegin = false; begin.signal(); await begin.wait }
    return execute()
  })
  const requestFresh = request(fresh), expected = createAgentPodPlanner(policy).plan(requestFresh)
  const persistence = createAgentPodPlanPersistence(recordingPool, policy), mutableContext = context(fresh)
  const pending = persistence.record(mutableContext, requestFresh)
  await begin.entered
  policy.image = `fixture.invalid/changed@sha256:${'2'.repeat(64)}`
  requestFresh.profile.cpuMilli = 999; requestFresh.protectedBindings[0].claimName = 'changed-after-first-await'
  mutableContext.operationId = logicalId('operation', late.operation)
  begin.release()
  const recorded = await pending
  assert.ok(recorded.ok); assert.equal(recorded.cleanupFailed, false); assert.equal(recorded.settlement, 'COMMITTED')
  assert.equal(recorded.value.disposition, 'RECORDED'); assert.deepEqual(recorded.value.record.plan, expected)
  assert.equal(recorded.value.record.plan.kind, 'UNAUTHORIZED_PLAN')
  assert.equal(recorded.value.record.plan.storageGrantIssued, false); assert.equal(recorded.value.record.plan.physicalPinIssued, false)
  assert.equal(recorded.value.record.plan.readinessObserved, false)
  assert.equal((await observer.query('SELECT count(*)::text AS n FROM durable_runtime.attempts WHERE id=$1', [fresh.attempt])).rows[0].n, '0')
  const replayed = await persistence.record(context(fresh), request(fresh))
  assert.ok(replayed.ok); assert.equal(replayed.value.disposition, 'REPLAYED'); assert.deepEqual(replayed.value.record, recorded.value.record)
  const stored = await withDurableTransaction(pool, tx => readAgentPodPlan(tx, logicalId('operation', fresh.operation)))
  assert.deepEqual(stored, recorded.value.record)
  await bindObservedAttempt(fresh)
  const matched = await persistControllerInventoryObservation(pool, scope, observation(fresh, 'matched-rv'), 'WATCH', pass)
  assert.ok(matched.ok); assert.equal(matched.value.disposition, 'RECORDED')
  const matchedRows = await inventoryRows(fresh), matchedOutbox = await inventoryOutbox(fresh)
  assert.equal(matchedRows.length, 1); assert.equal(matchedRows[0].next_state.specHashVerification, 'MATCHED')
  assert.equal(matchedRows[0].next_state.planDigest, recorded.value.record.planDigest)
  assert.equal(matchedRows[0].next_state.observationVersion, 2); assert.equal(matchedRows[0].next_state.physicalFenceVerified, false)
  const mismatched = await persistControllerInventoryObservation(pool, scope, observation(fresh, 'mismatch-rv', 'b'.repeat(64)), 'WATCH', pass)
  assert.ok(mismatched.ok); assert.equal(mismatched.value.disposition, 'CONFLICT')
  assert.deepEqual(await inventoryRows(fresh), matchedRows); assert.deepEqual(await inventoryOutbox(fresh), matchedOutbox)
  const lateRecord = await persistence.record(context(late), request(late))
  assert.ok(lateRecord.ok); assert.equal(lateRecord.value.disposition, 'RECORDED')
  for (const version of ['before-plan-rv', 'legacy-v1-rv']) {
    const originalReplay = await persistControllerInventoryObservation(pool, scope, observation(late, version), 'WATCH', pass)
    assert.ok(originalReplay.ok); assert.equal(originalReplay.value.disposition, 'REPLAYED')
  }
  const rawConflict = await persistControllerInventoryObservation(pool, scope, observation(late, 'legacy-v1-rv', 'b'.repeat(64)), 'WATCH', pass)
  assert.ok(rawConflict.ok); assert.equal(rawConflict.value.disposition, 'CONFLICT')
  assert.deepEqual(await inventoryRows(late), originalUnavailableRows)
  assert.deepEqual(await inventoryOutbox(late), originalUnavailableOutbox)
  assert.equal((await observer.query('SELECT count(*)::text AS n FROM durable_runtime.agent_pod_plans WHERE operation_id=ANY($1::uuid[])',
    [[fresh.operation, late.operation]])).rows[0].n, '2')
  assert.equal((await observer.query('SELECT count(*)::text AS n FROM durable_runtime.execution_grants WHERE runtime_unit_id=ANY($1::uuid[])',
    [[fresh.unit, late.unit]])).rows[0].n, '0')
  assert.equal((await observer.query('SELECT count(*)::text AS n FROM durable_runtime.storage_write_grants WHERE attempt_id=ANY($1::uuid[])',
    [[fresh.attempt, late.attempt]])).rows[0].n, '0')
  assert.deepEqual((await observer.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  callback.release(); await worker.stop()
  assert.equal((await pool.query('SELECT 1 AS n')).rows[0].n, 1, 'The borrowed pool remains usable')
})
