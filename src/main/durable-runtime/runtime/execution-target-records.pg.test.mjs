import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from '../db/connection.ts'
import { recordExecutionTarget, readExecutionTarget } from './execution-target-records.ts'

// Synthetic controller/evidence references exercise storage only. No production
// VerifiedControllerIdentity issuer, provider, K8s or Compute authentication.
await test('execution target original records: isolated PG callback 1', async (t) => {
  const database = 'orca_execution_targets_20261015'
  assert.equal(process.env.PGDATABASE, database)
  assert.equal(process.env.ORCA_EXECUTION_TARGETS_APPROVED, 'root-first-verification')
  const pool = createDurablePool({ max: 6, application_name: 'execution-target-records-fixture' })
  t.after(() => pool.end())
  const identity = (await pool.query(`SELECT current_database() AS database,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system,
    pg_backend_pid() AS backend_pid,clock_timestamp() AS observed_at`)).rows[0]
  assert.equal(identity.database, database)
  assert.equal(identity.oid, process.env.ORCA_EXECUTION_TARGETS_OID)
  assert.equal(identity.system, '7696101282789175327')
  assert.deepEqual((await pool.query('SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows,
    [{ dataset_name: 'orca-1012-dev-v1' }])
  const ledgerBefore = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledgerBefore.length, 20)
  console.log(JSON.stringify({ phase: 'FIXTURE_IDENTITY_BEFORE_FIRST_SEED', ...identity, ledger: ledgerBefore }))
  const seen = []
  const transaction = (body) => withDurableTransaction(pool, body)
  const rejected = (body, code) => assert.rejects(body, error =>
    error instanceof DurableDatabaseError && error.code === code)
  async function fixture(overrides = {}) {
    const runtimeUnitId = randomUUID(), attemptId = randomUUID(), operationId = randomUUID()
    const controller = { scope: `synthetic-controller:${runtimeUnitId}`, owner: randomUUID(), term: '1' }
    const context = { runtimeUnitId, operationId, controller }
    const input = {
      attemptId, runtimeUnitId, executionEpoch: '1', podUid: `synthetic-pod:${attemptId}`,
      incarnation: randomUUID(), clusterIdentityRef: 'synthetic-cluster:execution-targets',
      namespace: 'synthetic-namespace', podName: 'same-pod-name', podResourceVersion: 'opaque/pod:rv',
      nodeName: 'same-node-name', nodeUid: 'synthetic-node:uid', nodeResourceVersion: 'opaque/node:rv',
      projectId: 'synthetic-project-id', projectNumber: '12345678901234567890', zone: 'synthetic-zone',
      instanceName: 'same-vm-name', numericInstanceId: '18446744073709551615',
      computeIdentityRef: 'synthetic-compute:identity', observedAt: '2026-10-15T00:00:00.123Z',
      kubernetesEvidenceRef: `synthetic-kubernetes:${attemptId}`,
      computeIdentityEvidenceRef: `synthetic-compute-evidence:${attemptId}`, observationDigest: 'a'.repeat(64), ...overrides
    }
    await transaction(async tx => {
      await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,intent_revision,execution_epoch,phase) VALUES($1,'RUNNING',1,1,'READY')", [runtimeUnitId])
      await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,1,'{}',1)", [runtimeUnitId])
      await tx.query(`INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,resource_profile_revision,effective_resources,status)
        VALUES($1,$2,1,'COLD',$3,$4,1,'{}','READY')`, [attemptId, runtimeUnitId, input.podUid, input.incarnation])
      await tx.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=$2 WHERE id=$1', [runtimeUnitId, attemptId])
      await tx.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,$2,1,clock_timestamp()+interval '20 minutes')", [controller.scope, controller.owner])
      await tx.query(`INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,step_revision,expected_pod_uid,execution_epoch)
        VALUES($1,$2,'SYNTHETIC_EXECUTION_TARGET',1,$3,1,'OBSERVE',0,$4,1)`, [operationId, runtimeUnitId, controller.scope, input.podUid])
    })
    return { input, context }
  }
  const record = f => transaction(tx => recordExecutionTarget(tx, f.context, f.input))
  const read = f => transaction(tx => readExecutionTarget(tx, f.input))
  const count = async f => (await pool.query('SELECT count(*)::int AS n FROM durable_runtime.execution_target_records WHERE attempt_id=$1', [f.input.attemptId])).rows[0].n

  const exact = await fixture()
  const original = await record(exact)
  assert.deepEqual(original, { ...exact.input, recordedAt: original.recordedAt })
  assert.ok(Object.isFrozen(original))
  assert.equal(Object.getPrototypeOf(original), Object.prototype)
  assert.equal(original.numericInstanceId, '18446744073709551615')
  assert.equal(original.projectNumber, '12345678901234567890')
  assert.deepEqual(await read(exact), original)
  assert.deepEqual(await record(exact), original)
  assert.equal(await count(exact), 1)
  for (const delta of [{ podUid: 'different' }, { incarnation: 'different' }, { executionEpoch: '2' }, { attemptId: randomUUID() }]) {
    assert.equal(await transaction(tx => readExecutionTarget(tx, { ...exact.input, ...delta })), null)
  }
  seen.push('exact-insert-read-idempotence-exact-historical-key')

  const identical = await fixture()
  const sameRace = await Promise.all([record(identical), record(identical)])
  assert.deepEqual(sameRace[0], sameRace[1])
  assert.equal(await count(identical), 1)
  const different = await fixture()
  const conflictRace = await Promise.allSettled([record(different), record({ ...different, input: { ...different.input, nodeUid: 'different-node' } })])
  assert.equal(conflictRace.filter(x => x.status === 'fulfilled').length, 1)
  assert.equal(conflictRace.filter(x => x.status === 'rejected' && x.reason.code === 'EXECUTION_TARGET_IDENTITY_CONFLICT').length, 1)
  assert.equal(await count(different), 1)
  for (const key of Object.keys(exact.input).filter(key => !['attemptId','runtimeUnitId'].includes(key))) {
    const change = key === 'executionEpoch' ? '2' : key === 'observedAt' ? '2026-10-15T00:00:00.124Z' : key === 'observationDigest' ? 'b'.repeat(64) : `${exact.input[key]}1`
    await rejected(() => record({ ...exact, input: { ...exact.input, [key]: change } }), 'EXECUTION_TARGET_IDENTITY_CONFLICT')
  }
  seen.push('concurrent-identical-and-conflicting-first-writer-every-original-field-conflict')

  await rejected(() => transaction(tx => tx.query('UPDATE durable_runtime.execution_target_records SET node_name=node_name WHERE attempt_id=$1', [exact.input.attemptId])), '23514')
  await rejected(() => transaction(tx => tx.query('DELETE FROM durable_runtime.execution_target_records WHERE attempt_id=$1', [exact.input.attemptId])), '23514')
  for (const [column, value] of [['pod_uid','replacement-pod'],['incarnation','replacement-incarnation'],['execution_epoch','2'],['runtime_unit_id',identical.input.runtimeUnitId]]) {
    await rejected(() => transaction(tx => tx.query(`UPDATE durable_runtime.attempts SET ${column}=$2 WHERE id=$1`, [exact.input.attemptId,value])), '23503')
  }
  await transaction(tx => tx.query("UPDATE durable_runtime.attempts SET status='STOPPED',reason='synthetic ordinary state' WHERE id=$1", [exact.input.attemptId]))
  assert.deepEqual(await read(exact), original)
  seen.push('append-only-update-delete-and-attempt-identity-fk-ordinary-status-update')

  const sourceRow = (await pool.query('SELECT to_jsonb(t) AS row FROM durable_runtime.execution_target_records t WHERE attempt_id=$1',[exact.input.attemptId])).rows[0].row
  const raw = row => transaction(tx => tx.query('INSERT INTO durable_runtime.execution_target_records SELECT * FROM jsonb_populate_record(NULL::durable_runtime.execution_target_records,$1::jsonb)', [JSON.stringify(row)]))
  for (const delta of [{ runtime_unit_id: randomUUID() },{ pod_uid: 'mismatched-pod' },{ incarnation: 'mismatched-incarnation' },{ execution_epoch: '2' }]) {
    const f = await fixture()
    await rejected(() => raw({ ...sourceRow, attempt_id:f.input.attemptId, runtime_unit_id:f.input.runtimeUnitId,
      pod_uid:f.input.podUid, incarnation:f.input.incarnation, cluster_identity_ref:randomUUID(), ...delta }), '23503')
    assert.equal(await count(f), 0)
  }
  const duplicate = await fixture({ podUid: exact.input.podUid, incarnation: exact.input.incarnation })
  await rejected(() => record(duplicate), 'EXECUTION_TARGET_IDENTITY_CONFLICT')
  assert.equal(await count(duplicate), 0)
  const otherIncarnation = await fixture({ podUid: exact.input.podUid })
  assert.equal((await record(otherIncarnation)).incarnation, otherIncarnation.input.incarnation)
  for (const delta of [{ project_number:'01' },{ numeric_instance_id:'0' },{ observation_digest:'BAD' },{ node_resource_version:'' }]) {
    const f = await fixture()
    await rejected(() => raw({ ...sourceRow, attempt_id:f.input.attemptId, runtime_unit_id:f.input.runtimeUnitId,
      pod_uid:f.input.podUid, incarnation:f.input.incarnation, cluster_identity_ref:randomUUID(), ...delta }), '23514')
  }
  seen.push('exact-unit-pod-incarnation-epoch-fk-cluster-tuple-unique-and-format-checks')

  const staleLease = await fixture()
  await transaction(tx => tx.query("UPDATE durable_runtime.controller_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE scope=$1", [staleLease.context.controller.scope]))
  await rejected(() => record(staleLease),'COMMAND_AUTHORITY_STALE')
  assert.equal(await count(staleLease),0)
  const inactive = await fixture()
  await transaction(tx => tx.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=NULL WHERE id=$1',[inactive.input.runtimeUnitId]))
  await rejected(() => record(inactive),'EXECUTION_TARGET_STALE')
  assert.equal(await count(inactive),0)
  for (const [sql, values] of [
    ['UPDATE durable_runtime.operations SET result=$2::jsonb WHERE id=$1',[null,'{}']],
    ['UPDATE durable_runtime.operations SET execution_epoch=2 WHERE id=$1',[null]]
  ]) {
    const f=await fixture()
    values[0]=f.context.operationId
    await transaction(tx=>tx.query(sql,values))
    await rejected(()=>record(f),'EXECUTION_TARGET_STALE')
    assert.equal(await count(f),0)
  }
  // An immutable mapping is readable after the current execution moved on.
  await transaction(tx=>tx.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=NULL,execution_epoch=2 WHERE id=$1',[exact.input.runtimeUnitId]))
  assert.deepEqual(await read(exact),original)
  assert.deepEqual(await record(exact),original)
  seen.push('stale-lease-inactive-attempt-finished-or-other-epoch-operation-no-first-write-historical-read')

  const rollback=await fixture()
  await rejected(()=>transaction(async tx=>{
    await recordExecutionTarget(tx,rollback.context,rollback.input)
    throw new DurableDatabaseError('SYNTHETIC_CALLER_ROLLBACK')
  }),'SYNTHETIC_CALLER_ROLLBACK')
  assert.equal(await count(rollback),0)
  const mutable=await fixture(),expected={...mutable.input}
  const captured=await transaction(async tx=>{
    const query=tx.query
    let first=true
    tx.query=async function(sql,values){
      if(first){first=false;mutable.input.nodeUid='mutated-after-first-await';mutable.input.projectNumber='9';mutable.context.controller.owner='mutated-owner'}
      return query.call(this,sql,values)
    }
    try{return await recordExecutionTarget(tx,mutable.context,mutable.input)}finally{tx.query=query}
  })
  assert.deepEqual(captured,{...expected,recordedAt:captured.recordedAt})
  const readKey={...expected}
  const capturedRead=await transaction(async tx=>{
    const query=tx.query
    tx.query=async function(sql,values){readKey.podUid='mutated-read-key';return query.call(this,sql,values)}
    try{return await readExecutionTarget(tx,readKey)}finally{tx.query=query}
  })
  assert.deepEqual(capturedRead,captured)
  seen.push('caller-rollback-and-first-await-observation-context-and-read-key-capture')
  const ledgerAfter=(await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.deepEqual(ledgerAfter,ledgerBefore)
  console.log(JSON.stringify({phase:'EXECUTION_TARGET_CALLBACK_COMPLETE',callbackCount:1,cases:seen,
    database:identity.database,oid:identity.oid,system:identity.system,ledgerUnchanged:true,
    qualification:'합성 controller/evidence 저장 검증이며 실제 observer 인증·물리 종료·grant·provider permit 증명이 아닙니다.'}))
})
