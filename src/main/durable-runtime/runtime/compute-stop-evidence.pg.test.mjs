import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createDurablePool, DurableTransaction, withDurableTransaction } from '../db/connection.ts'
import { recordExecutionTarget } from './execution-target-records.ts'
import { createComputeStopEvidence, ComputeStopEvidenceError } from './compute-stop-evidence.ts'
import { stopFixtureRow, stopFixtureInput } from './compute-stop-evidence-fixtures.mts'
import { deletionEntries, fixtureInput } from './compute-deletion-audit-fixtures.mts'
import { auditWire, closedStreams } from './compute-deletion-audit-transport-fixtures.mts'

// Real isolated PG visibility; synthetic HTTPS only. No schema/reset/old-row changes or live Cloud.
await test('compute stop evidence: isolated PG callback 1', async t => {
  assert.equal(process.env.PGDATABASE, 'orca_execution_targets_20261015')
  assert.equal(process.env.ORCA_COMPUTE_STOP_EVIDENCE_APPROVED, 'root-first-verification')
  const pool = createDurablePool({ max: 4, application_name: 'compute-stop-evidence-fixture' })
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
  assert.equal(originalLedger.at(-1).version, '020-execution-target-records.sql')
  assert.equal(originalLedger.at(-1).checksum, '85fc2a7494dc1066c2e168948560a3114d043c0dbcdc6ab5d1177adf706565b1')
  const tables = ['dataset_metadata', 'runtime_units', 'resource_profiles', 'attempts',
    'operations', 'controller_leases', 'execution_target_records']
  const rows = async table => (await pool.query(`SELECT to_jsonb(t) AS row FROM durable_runtime.${table} t`)).rows
    .map(value => JSON.stringify(value.row)).sort()
  const originalRows = new Map()
  for (const table of tables) { originalRows.set(table, await rows(table)) }
  console.log(JSON.stringify({ phase: 'COMPUTE_STOP_IDENTITY_BEFORE_SEED', ...identity,
    ledgerRows: originalLedger.length, originalRows: [...originalRows.values()].reduce((sum, value) => sum + value.length, 0) }))

  const source = stopFixtureRow()
  source.attempt_id = randomUUID(); source.runtime_unit_id = randomUUID()
  source.pod_uid = `synthetic-stop-pod:${source.attempt_id}`; source.incarnation = randomUUID()
  const input = stopFixtureInput(source)
  const context = { runtimeUnitId: source.runtime_unit_id, operationId: randomUUID(),
    controller: { scope: `synthetic-stop-controller:${randomUUID()}`, owner: randomUUID(), term: '1' } }
  await withDurableTransaction(pool, async tx => {
    await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,intent_revision,execution_epoch,phase) VALUES($1,'RUNNING',1,1,'READY')", [context.runtimeUnitId])
    await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,1,'{}',1)", [context.runtimeUnitId])
    await tx.query(`INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,resource_profile_revision,effective_resources,status)
      VALUES($1,$2,1,'COLD',$3,$4,1,'{}','READY')`, [source.attempt_id, context.runtimeUnitId, source.pod_uid, source.incarnation])
    await tx.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=$2 WHERE id=$1', [context.runtimeUnitId, source.attempt_id])
    await tx.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,$2,1,clock_timestamp()+interval '20 minutes')", [context.controller.scope, context.controller.owner])
    await tx.query(`INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,step_revision,expected_pod_uid,execution_epoch)
      VALUES($1,$2,'SYNTHETIC_COMPUTE_STOP',1,$3,1,'OBSERVE',0,$4,1)`,
    [context.operationId, context.runtimeUnitId, context.controller.scope, source.pod_uid])
  })
  const observation = { attemptId: source.attempt_id, runtimeUnitId: source.runtime_unit_id,
    executionEpoch: source.execution_epoch, podUid: source.pod_uid, incarnation: source.incarnation,
    clusterIdentityRef: source.cluster_identity_ref, namespace: source.namespace,
    podName: source.pod_name, podResourceVersion: source.pod_resource_version, nodeName: source.node_name,
    nodeUid: source.node_uid, nodeResourceVersion: source.node_resource_version,
    projectId: source.project_id, projectNumber: source.project_number, zone: source.zone,
    instanceName: source.instance_name, numericInstanceId: source.numeric_instance_id,
    computeIdentityRef: source.compute_identity_ref, observedAt: source.observed_at.toISOString(),
    kubernetesEvidenceRef: source.kubernetes_evidence_ref,
    computeIdentityEvidenceRef: source.compute_identity_evidence_ref, observationDigest: source.observation_digest }

  const phases = [], wire = auditWire({ json: { entries: deletionEntries() } })
  let checkedOut = 0
  const nativeConnect = pool.connect.bind(pool)
  const observedPool = { async connect() {
    assert.equal(this, observedPool)
    const client = await nativeConnect()
    checkedOut++
    phases.push('CONNECT')
    const query = client.query.bind(client), release = client.release.bind(client)
    let returned = false
    const tracked = { async query(sql, values) {
      assert.equal(this, tracked)
      phases.push(sql)
      return query(sql, values)
    }, release(destroy) {
      assert.equal(this, tracked); assert.equal(returned, false)
      returned = true; checkedOut--; phases.push(destroy ? 'DESTROY' : 'RELEASE')
      return release(destroy)
    } }
    return tracked
  } }
  const service = createComputeStopEvidence({ pool: observedPool, datasetName: 'orca-1012-dev-v1',
    clusterIdentityRef: source.cluster_identity_ref, namespace: source.namespace,
    projectId: fixtureInput.scope.projectId, projectNumber: fixtureInput.scope.projectNumber,
    timeoutMs: 5000, audit: { https: wire.holder, tokenProvider: { async getAccessToken() {
      assert.equal(checkedOut, 0)
      assert.equal(phases.at(-1), 'RELEASE')
      phases.push('AUDIT_TOKEN')
      return 'synthetic-stop-token'
    } } } })
  const writer = await nativeConnect(), writeTx = new DurableTransaction(writer)
  let committed = false
  try {
    await writeTx.query('BEGIN')
    await recordExecutionTarget(writeTx, context, observation)
    await assert.rejects(service.prepare(input, new AbortController().signal), error =>
      error instanceof ComputeStopEvidenceError && error.code === 'TARGET_NOT_FOUND')
    assert.equal(wire.requests.length, 0); assert.equal(checkedOut, 0)
    await writeTx.query('COMMIT'); committed = true
  } finally {
    if (!committed) { await writer.query('ROLLBACK') }
    writeTx.close(); writer.release()
  }
  // This historical row remains usable even after the current Unit projection changes.
  await pool.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=NULL WHERE id=$1', [context.runtimeUnitId])
  const caller = new AbortController(), owner = await service.prepare(input, caller.signal)
  const target = owner.executionTarget(source.attempt_id, source.pod_uid, source.incarnation, source.execution_epoch)
  const stopped = owner.permanentComputeStop(owner.reference)
  assert.ok(target && stopped)
  assert.equal(owner.executionTargetPinValid(target), true)
  assert.equal(owner.computeStopPinValid(stopped), true)
  assert.equal(stopped.numericInstanceId, source.numeric_instance_id)
  assert.equal(stopped.proof.evidenceRef, owner.reference)
  assert.equal(wire.requests.length, 1); assert.equal(checkedOut, 0)
  const sibling = await service.prepare(input, new AbortController().signal)
  assert.equal(sibling.reference, owner.reference)
  assert.equal(sibling.executionTargetPinValid(target), false)
  caller.abort(); owner.release(); owner.release(); sibling.release()
  assert.equal(owner.computeStopPinValid(stopped), false)
  assert.equal(owner.permanentComputeStop(owner.reference), null)
  assert.equal(checkedOut, 0)
  await closedStreams()
  assert.deepEqual(await ledger(), originalLedger)
  for (const table of tables) {
    const after = await rows(table)
    for (const original of originalRows.get(table)) {
      const index = after.indexOf(original)
      assert.notEqual(index, -1)
      after.splice(index, 1)
    }
  }
  console.log(JSON.stringify({ phase: 'COMPUTE_STOP_PG_CASES', callbackCount: 1,
    cases: ['uncommitted-target-invisible-Cloud0', 'commit-visible-historical-target',
      'read-only-connection-return-before-Audit', 'stable-reference-owner-pins-release-abort',
      'ledger20-original-row-multisets-preserved'],
    syntheticHTTPS: true, schemaChanges: 0, phases }))
})
