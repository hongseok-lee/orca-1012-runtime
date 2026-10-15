import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from '../db/connection.ts'
import { readExecutionTarget } from './execution-target-records.ts'
import { createExecutionTargetComposition } from './execution-target-composition.ts'
import { compositionCreation, compositionDoubles, compositionInput,
  compositionPod } from './execution-target-composition-fixtures.mts'

// Synthetic observers only. Existing isolated DB/ledger20 is reused without DDL,
// reset, deletion or modification of the previous fixture's rows.
await test('execution target composition: isolated PG callback 1', async t => {
  assert.equal(process.env.PGDATABASE, 'orca_execution_targets_20261015')
  assert.equal(process.env.ORCA_EXECUTION_TARGET_COMPOSITION_APPROVED, 'root-first-verification')
  const pool = createDurablePool({ max: 4, application_name: 'execution-target-composition-fixture' })
  t.after(() => pool.end())
  const identity = (await pool.query(`SELECT current_database() AS database,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system,
    pg_backend_pid() AS backend_pid,clock_timestamp() AS observed_at`)).rows[0]
  assert.equal(identity.database, 'orca_execution_targets_20261015')
  assert.equal(identity.oid, '92238')
  assert.equal(identity.system, '7696101282789175327')
  assert.deepEqual((await pool.query('SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows,
    [{ dataset_name: 'orca-1012-dev-v1' }])
  const ledger = async () => (await pool.query(
    'SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  const originalLedger = await ledger()
  assert.equal(originalLedger.length, 20)
  assert.deepEqual(originalLedger.at(-1), { ...originalLedger.at(-1),
    version: '020-execution-target-records.sql',
    checksum: '85fc2a7494dc1066c2e168948560a3114d043c0dbcdc6ab5d1177adf706565b1' })
  console.log(JSON.stringify({ phase: 'COMPOSITION_IDENTITY_BEFORE_FIRST_SEED', ...identity,
    ledgerRows: originalLedger.length, migration020Checksum: originalLedger.at(-1).checksum }))
  const tables = ['dataset_metadata', 'runtime_units', 'resource_profiles', 'attempts',
    'operations', 'controller_leases', 'execution_target_records']
  const rows = async table => (await pool.query(`SELECT to_jsonb(t) AS row FROM durable_runtime.${table} t`)).rows
    .map(value => JSON.stringify(value.row)).sort()
  const originalRows = new Map()
  for (const table of tables) {
    originalRows.set(table, await rows(table))
  }
  const transaction = body => withDurableTransaction(pool, body)
  async function seed() {
    const input = compositionInput()
    input.attemptId = randomUUID()
    input.incarnation = randomUUID()
    input.expected.runtimeUnitId = randomUUID()
    input.expected.operationId = randomUUID()
    input.expected.executionEpoch = '1'
    input.expected.podUid = `synthetic-composition-pod:${input.attemptId}`
    const context = { runtimeUnitId: input.expected.runtimeUnitId, operationId: input.expected.operationId,
      controller: { scope: `synthetic-composition-controller:${randomUUID()}`, owner: randomUUID(), term: '1' } }
    // Setup only. The composition prepare below receives no transaction or Pool.
    await transaction(async tx => {
      await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,intent_revision,execution_epoch,phase) VALUES($1,'RUNNING',1,1,'READY')", [context.runtimeUnitId])
      await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,1,'{}',1)", [context.runtimeUnitId])
      await tx.query(`INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,resource_profile_revision,effective_resources,status)
        VALUES($1,$2,1,'COLD',$3,$4,1,'{}','READY')`, [input.attemptId, context.runtimeUnitId, input.expected.podUid, input.incarnation])
      await tx.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=$2 WHERE id=$1', [context.runtimeUnitId, input.attemptId])
      await tx.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,$2,1,clock_timestamp()+interval '20 minutes')", [context.controller.scope, context.controller.owner])
      await tx.query(`INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,step_revision,expected_pod_uid,execution_epoch)
        VALUES($1,$2,'SYNTHETIC_EXECUTION_TARGET',1,$3,1,'OBSERVE',0,$4,1)`,
      [context.operationId, context.runtimeUnitId, context.controller.scope, input.expected.podUid])
    })
    return { input, context }
  }
  let insideRecord = false, resourceVersion = 'synthetic-composition-rv1'
  const observers = compositionDoubles({
    pod: async input => {
      assert.equal(insideRecord, false)
      const value = compositionPod(input)
      return { ...value, dataset: 'orca-1012-dev-v1',
        pod: { ...value.pod, resourceVersion } }
    },
    creation: async input => {
      assert.equal(insideRecord, false)
      return compositionCreation(input)
    }
  })
  observers.configuration.dataset = 'orca-1012-dev-v1'
  const service = createExecutionTargetComposition(observers.configuration)
  const prepare = fixture => service.prepare(fixture.input, new AbortController().signal)
  const record = (fixture, handle) => transaction(async tx => {
    const observerCalls = observers.calls.length
    insideRecord = true
    try {
      const result = await service.record(tx, fixture.context, handle)
      assert.equal(result.status, 'TRANSACTION_LOCAL')
      assert.equal(observers.calls.length, observerCalls)
      return result.record
    } finally {
      insideRecord = false
    }
  })
  const read = fixture => transaction(tx => readExecutionTarget(tx, {
    attemptId: fixture.input.attemptId, podUid: fixture.input.expected.podUid,
    incarnation: fixture.input.incarnation, executionEpoch: fixture.input.expected.executionEpoch }))
  const exact = await seed(), handle = await prepare(exact)
  const original = await record(exact, handle)
  assert.equal(Object.isFrozen(original), true)
  assert.deepEqual(await read(exact), original)
  assert.deepEqual(await record(exact, handle), original)
  assert.equal(observers.calls.length, 2)
  assert.equal(JSON.stringify(original).includes(exact.input.podBearer), false)

  resourceVersion = 'synthetic-composition-rv2'
  const changedHandle = await prepare(exact)
  await assert.rejects(record(exact, changedHandle), error =>
    error instanceof DurableDatabaseError && error.code === 'EXECUTION_TARGET_IDENTITY_CONFLICT')
  assert.deepEqual(await read(exact), original)

  const stale = await seed(), staleHandle = await prepare(stale)
  await transaction(tx => tx.query("UPDATE durable_runtime.controller_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE scope=$1", [stale.context.controller.scope]))
  await assert.rejects(record(stale, staleHandle), error =>
    error instanceof DurableDatabaseError && error.code === 'COMMAND_AUTHORITY_STALE')
  assert.equal(await read(stale), null)

  const rollback = await seed(), rollbackHandle = await prepare(rollback)
  await assert.rejects(transaction(async tx => {
    const result = await service.record(tx, rollback.context, rollbackHandle)
    assert.equal(result.status, 'TRANSACTION_LOCAL')
    throw new DurableDatabaseError('SYNTHETIC_COMPOSITION_ROLLBACK')
  }), error => error instanceof DurableDatabaseError && error.code === 'SYNTHETIC_COMPOSITION_ROLLBACK')
  assert.equal(await read(rollback), null)

  assert.deepEqual(await ledger(), originalLedger)
  for (const table of tables) {
    const after = await rows(table)
    for (const originalRow of originalRows.get(table)) {
      const index = after.indexOf(originalRow)
      assert.notEqual(index, -1)
      after.splice(index, 1)
    }
  }
  console.log(JSON.stringify({ phase: 'COMPOSITION_PG_CASES', cases: [
    'prepare-outside-transaction-record-without-observer-calls', 'exact-read-replay-fixed-observation',
    'reobservation-conflict-preserves-original', 'stale-lease-refusal', 'caller-rollback',
    'ledger20-and-original-row-multisets-preserved'
  ], callbackCount: 1, syntheticObservers: true, schemaChanged: false }))
})
