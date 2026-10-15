// Deferred PG fixture. All authority and provider proofs are synthetic, not provider authentication.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { runDurableMutation } from '../db/atomic.ts'
import { lockAggregates } from '../db/locks.ts'
import { recordInputCancel, recordObservedTurnCancel } from './cancel.ts'
import type { ObservedTurnCancelRequest } from './cancel-types.ts'
import { inputPayloadHash, inputScopeKey } from './canonical.ts'
import { executionFixture, fixed, inExecution, type ExecutionFixture } from './execution-fixtures.mts'
import { observeInputDeliveryInTransaction } from './observe.ts'
import type { InputDeliveryObservation } from './observation-types.ts'
import { InputStoreError } from './types.ts'

function request(f: ExecutionFixture, turn: string): ObservedTurnCancelRequest {
  return {
    authority: { ...f.authority, scope: { ...f.authority.scope } },
    provider: 'codex', nativeTurnId: turn,
    method: 'synthetic.observed-turn-cancel', operationKey: randomUUID(),
    originalPayload: { turnId: turn, scope: 'root' }
  }
}
async function delivery(pool: Pool, f: ExecutionFixture, state = 'EFFECT_POSSIBLE', providerRef: string | null = null) {
  const id = logicalId('delivery-attempt', randomUUID())
  await inExecution(pool, f, (tx) => tx.query(
    `INSERT INTO durable_runtime.delivery_attempts
      (id,message_id,session_id,runtime_unit_id,attempt_id,execution_epoch,state,provider_ref,effect_possible_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())`,
    [id,f.messageId,f.authority.sessionId,f.context.runtimeUnitId,f.attemptId,
      f.envelope.executionEpoch,state,providerRef]
  ))
  return id
}
async function observe(
  pool: Pool, f: ExecutionFixture, id: string, turn: string,
  state: 'ADMITTED' | 'SETTLED' | 'INTERRUPTED', nativeSession = `synthetic-native-${f.authority.sessionId}`
) {
  // Only this fixture supplies the opaque synthetic brand; product issues no proof.
  const observation = {
    kind: state,
    proof: {
      ...fixed(f,id), targetMessageId: f.messageId,
      kind: state === 'ADMITTED' ? 'PROVIDER_ADMISSION' :
        state === 'SETTLED' ? 'PROVIDER_TARGET_COMPLETED' : 'PROVIDER_TARGET_STOPPED',
      source: 'PROVIDER_PROTOCOL', evidenceRef: `synthetic-fixed-cancel-${randomUUID()}`,
      observedAt: new Date().toISOString(),
      providerRef: { provider: 'codex', nativeSessionRef: nativeSession, nativeTurnId: turn }
    }
  } as unknown as InputDeliveryObservation
  return inExecution(pool,f,(tx) => observeInputDeliveryInTransaction(tx,f.authority,fixed(f,id),observation))
}
async function snapshot(pool: Pool, fixtures: readonly ExecutionFixture[]) {
  const result = await pool.query(
    `SELECT
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.version) FROM durable_runtime.schema_migrations r) AS ledger,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.sessions r WHERE r.id=ANY($1::uuid[])) AS sessions,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.messages r WHERE r.session_id=ANY($1::uuid[])) AS messages,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.input_components r WHERE r.session_id=ANY($1::uuid[])) AS inputs,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.delivery_attempts r WHERE r.session_id=ANY($1::uuid[])) AS deliveries,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.operation_id) FROM durable_runtime.cancel_intents r WHERE r.session_id=ANY($1::uuid[])) AS cancels,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.session_context_records r WHERE r.session_id=ANY($1::uuid[])) AS contexts,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.journal_epoch,r.seq) FROM durable_runtime.session_events r WHERE r.session_id=ANY($1::uuid[])) AS journal,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.outbox_events r WHERE r.aggregate_id=ANY($1::uuid[]) OR r.aggregate_id=ANY($2::uuid[])) AS outbox,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.runtime_units r WHERE r.id=ANY($2::uuid[])) AS units,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.attempts r WHERE r.runtime_unit_id=ANY($2::uuid[])) AS attempts,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.execution_grants r WHERE r.runtime_unit_id=ANY($2::uuid[])) AS grants,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.runtime_audit_events r WHERE r.session_id=ANY($1::uuid[])) AS audit,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.principal_id,r.session_scope,r.method,r.operation_key)
        FROM durable_runtime.rpc_receipts r WHERE r.principal_id=ANY($3::text[])) AS receipts`,
    [fixtures.map((f) => f.authority.sessionId),fixtures.map((f) => f.context.runtimeUnitId),
      fixtures.map((f) => f.authority.principal)]
  )
  return result.rows[0]
}
async function inspect(pool: Pool, operationId: string) {
  const result = await pool.query(
    `SELECT ci.*,cr.body_ref,e.event_id,e.journal_epoch,e.seq,o.event AS outbox
     FROM durable_runtime.cancel_intents ci
     JOIN durable_runtime.session_context_records cr
       ON cr.session_id=ci.session_id AND cr.kind='CANCEL_INTENT'
      AND cr.body_ref->>'operationId'=ci.operation_id::text
     JOIN durable_runtime.session_events e
       ON e.session_id=ci.session_id AND e.body=cr.body_ref
     LEFT JOIN durable_runtime.outbox_events o ON o.id=e.event_id
     WHERE ci.operation_id=$1`, [operationId]
  )
  assert.equal(result.rowCount,1)
  return result.rows[0]
}

await test('observed cancel fixes original A and preserves transaction, replay and legacy boundaries', async (t) => {
  // Root supplies the execution DB/OID later. No implicit DB choice, migration or reset.
  assert.equal(process.env.ORCA_FIXED_TURN_CANCEL_PG_APPROVED,'root-fixed-turn-cancel')
  assert.ok(process.env.ORCA_FIXED_TURN_CANCEL_DATABASE)
  assert.notEqual(process.env.ORCA_FIXED_TURN_CANCEL_DATABASE,'orca_dev')
  assert.equal(process.env.PGDATABASE,process.env.ORCA_FIXED_TURN_CANCEL_DATABASE)
  assert.match(process.env.ORCA_FIXED_TURN_CANCEL_DATABASE_OID ?? '',/^[1-9][0-9]*$/)
  const pool = createDurablePool({ database: process.env.PGDATABASE, max: 3 })
  t.after(async () => { await pool.end() })
  const identity = await pool.query(
    `SELECT current_database() AS database,
      (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
      pg_backend_pid() AS backend_pid,
      (SELECT jsonb_agg(dataset_name ORDER BY dataset_name) FROM durable_runtime.dataset_metadata) AS datasets`
  )
  assert.equal(identity.rowCount,1)
  const actual = identity.rows[0]
  t.diagnostic(JSON.stringify({ phase: 'before-seed', ...actual }))
  assert.equal(actual.database,process.env.ORCA_FIXED_TURN_CANCEL_DATABASE)
  assert.equal(actual.database_oid,process.env.ORCA_FIXED_TURN_CANCEL_DATABASE_OID)
  assert.equal(actual.system_identifier,'7696101282789175327')
  assert.deepEqual(actual.datasets,['orca-1012-dev-v1'])
  assert.ok(Number.isInteger(actual.backend_pid) && actual.backend_pid > 0)
  const ledger = await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')
  assert.equal(ledger.rows.length,19)
  const f = await executionFixture(pool)
  const other = await executionFixture(pool)
  const terminal = await executionFixture(pool)
  const stopped = await executionFixture(pool)
  const ambiguous = await executionFixture(pool)
  const legacy = await executionFixture(pool)
  const unproven = await executionFixture(pool)
  const fixtures = [f,other,terminal,stopped,ambiguous,legacy,unproven]
  const prefix = `synthetic-fixed-cancel-${randomUUID()}`
  const turnA = `${prefix}-A`
  // Fixture-owned Message is active before production observations update it.
  await inExecution(pool,f,(tx) => tx.query(
    "UPDATE durable_runtime.messages SET intake_status='EFFECT_POSSIBLE' WHERE id=$1",[f.messageId]
  ))
  const a = await delivery(pool,f,'EFFECT_POSSIBLE',`synthetic-native-${f.authority.sessionId}`)
  await observe(pool,f,a,turnA,'ADMITTED')
  // B belongs to the same Message but a newer attempt/epoch. No current-attempt fallback is permitted.
  const nextAttempt = logicalId('attempt',randomUUID())
  const nextPod = `synthetic-next-pod-${nextAttempt}` as ExecutionFixture['podUid']
  await inExecution(pool,f,async (tx) => {
    // Synthetic fixture initialization only: not Compute/Storage fencing or a product proof issuer.
    // This callback owns the new A grant; preserve its identity and every existing DB/history row.
    const revoked = await tx.query(
      `UPDATE durable_runtime.execution_grants SET state='REVOKED',revoked_at=clock_timestamp(),stopped_proof_ref=$4
       WHERE runtime_unit_id=$1 AND attempt_id=$2 AND execution_epoch=$3 AND state='ACTIVE'`,
      [f.context.runtimeUnitId,f.attemptId,f.envelope.executionEpoch,`synthetic-fixture-stopped-proof:${f.attemptId}`]
    )
    assert.equal(revoked.rowCount,1)
    await tx.query(
      `INSERT INTO durable_runtime.attempts
       (id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,resource_profile_revision,effective_resources,status)
       VALUES ($1,$2,2,'COLD',$3,'synthetic-next',0,'{}','READY')`,
      [nextAttempt,f.context.runtimeUnitId,nextPod]
    )
    await tx.query('UPDATE durable_runtime.runtime_units SET execution_epoch=2,active_attempt_id=$2 WHERE id=$1',
      [f.context.runtimeUnitId,nextAttempt])
    const granted = await tx.query(
      `INSERT INTO durable_runtime.execution_grants(id,runtime_unit_id,attempt_id,execution_epoch,state)
       VALUES ($1,$2,$3,2,'ACTIVE')`,[randomUUID(),f.context.runtimeUnitId,nextAttempt]
    )
    assert.equal(granted.rowCount,1)
  })
  const newer: ExecutionFixture = {
    ...f, attemptId: nextAttempt, podUid: nextPod,
    envelope: { ...f.envelope, executionEpoch: counter('execution-epoch','2') }
  }
  const b = await delivery(pool,newer)
  await observe(pool,newer,b,`${prefix}-B`,'SETTLED')
  const pending = await delivery(pool,newer,'STAGED')
  const foreign = await delivery(pool,other)
  await observe(pool,other,foreign,turnA,'ADMITTED')
  const before = await snapshot(pool,fixtures)
  const messageBefore = before.messages.find((row: { id: string }) => row.id === f.messageId)
  assert.equal(messageBefore.intake_status,'SETTLED','B has settled the Message while A has no original terminal observation')
  const currentUnit = before.units.find((row: { id: string }) => row.id === f.context.runtimeUnitId)
  assert.equal(currentUnit.active_attempt_id,nextAttempt)
  assert.equal(currentUnit.execution_epoch,2)
  const ownGrants = before.grants.filter((row: { runtime_unit_id: string }) => row.runtime_unit_id === f.context.runtimeUnitId)
  assert.equal(ownGrants.length,2)
  const originalGrant = ownGrants.find((row: { attempt_id: string }) => row.attempt_id === f.attemptId)
  const currentGrant = ownGrants.find((row: { attempt_id: string }) => row.attempt_id === nextAttempt)
  assert.equal(originalGrant.state,'REVOKED')
  assert.equal(originalGrant.execution_epoch,1)
  assert.ok(originalGrant.revoked_at)
  assert.equal(originalGrant.stopped_proof_ref,`synthetic-fixture-stopped-proof:${f.attemptId}`)
  assert.equal(currentGrant.state,'ACTIVE')
  assert.equal(currentGrant.execution_epoch,2)
  assert.equal(currentGrant.revoked_at,null)
  assert.equal(before.deliveries.find((row: { id: string }) => row.id === a).provider_ref,
    `synthetic-native-${f.authority.sessionId}`,'stored native Session is not a native turn selector')
  const result = await inExecution(pool,f,(tx) => recordObservedTurnCancel(tx,request(f,turnA),f.context.runtimeUnitId))
  assert.equal(result.interruptStatus,'REQUESTED')
  assert.equal(result.target.deliveryAttemptId,a)
  assert.equal(result.target.attemptId,f.attemptId)
  assert.equal(result.target.executionEpoch,'1')
  assert.equal(result.targetMessageRevision,String(messageBefore.revision))
  const stored = await inspect(pool,result.operationId)
  const exact = {
    deliveryAttemptId: a, runtimeUnitId: f.context.runtimeUnitId, attemptId: f.attemptId,
    executionEpoch: '1', providerTurnRef: turnA, provider: 'codex',
    nativeSessionRef: `synthetic-native-${f.authority.sessionId}`, nativeTurnId: turnA, podUid: f.podUid
  }
  assert.deepEqual(stored.body_ref.fixedDelivery,exact)
  assert.deepEqual(stored.outbox.fixedDelivery,exact)
  assert.equal(stored.outbox.kind,'INTERRUPT_FIXED_DELIVERY')
  assert.equal(stored.target_provider_turn_ref,turnA)
  assert.equal(stored.target_runtime_unit_id,exact.runtimeUnitId)
  assert.equal(stored.target_attempt_id,exact.attemptId)
  assert.equal(stored.target_execution_epoch,exact.executionEpoch)
  assert.equal(stored.event_id,result.eventId)
  assert.equal(stored.journal_epoch,result.journalEpoch)
  assert.equal(stored.seq,result.sequence)
  assert.deepEqual(stored.body_ref.observedTurnProvenance,result.target.provenance)
  assert.ok(result.target.provenance.every((p) => p.eventId && p.contextId))
  const after = await snapshot(pool,fixtures)
  assert.deepEqual(after.deliveries,before.deliveries,'A/B and unrelated pre-effect deliveries must remain unchanged')
  assert.deepEqual(after.units,before.units)
  assert.deepEqual(after.attempts,before.attempts)
  assert.deepEqual(after.grants,before.grants)
  assert.deepEqual(after.inputs,before.inputs)
  assert.deepEqual(after.receipts,before.receipts)
  assert.equal(after.deliveries.find((row: { id: string }) => row.id === pending).state,'STAGED')
  assert.deepEqual(after.messages.filter((row: { id: string }) => row.id !== f.messageId),
    before.messages.filter((row: { id: string }) => row.id !== f.messageId))
  const foreignResult = await inExecution(pool,other,(tx) =>
    recordObservedTurnCancel(tx,request(other,turnA),other.context.runtimeUnitId))
  assert.equal(foreignResult.target.deliveryAttemptId,foreign)
  assert.equal(foreignResult.target.sessionId,other.authority.sessionId)

  async function rejectedUnchanged(action: () => Promise<unknown>, code: string) {
    const previous = await snapshot(pool,fixtures)
    await assert.rejects(action,{ code })
    assert.deepEqual(await snapshot(pool,fixtures),previous,'failure must leave cancellation/context/journal/outbox unchanged')
  }
  await rejectedUnchanged(() => withDurableTransaction(pool,(tx) =>
    recordObservedTurnCancel(tx,request(f,turnA),f.context.runtimeUnitId)), 'INPUT_SESSION_LOCK_REQUIRED')
  await rejectedUnchanged(() => withDurableTransaction(pool,async (tx) => {
    await lockAggregates(tx,{ sessionIds: [f.authority.sessionId] })
    return recordObservedTurnCancel(tx,request(f,turnA),f.context.runtimeUnitId)
  }), 'CANCEL_UNIT_LOCK_REQUIRED')
  await rejectedUnchanged(() => withDurableTransaction(pool,async (tx) => {
    await lockAggregates(tx,{ sessionIds: [f.authority.sessionId],runtimeUnitIds: [other.context.runtimeUnitId] })
    return recordObservedTurnCancel(tx,request(f,turnA),other.context.runtimeUnitId)
  }), 'CANCEL_MEMBERSHIP_CHANGED')
  await rejectedUnchanged(() => inExecution(pool,f,(tx) =>
    recordObservedTurnCancel(tx,request(f,`${prefix}-missing`),f.context.runtimeUnitId)), 'OBSERVED_TURN_NOT_FOUND')
  const badTurn = `${prefix}-only-contradiction`
  const noOriginal = await delivery(pool,ambiguous,'CANCELLED')
  await observe(pool,ambiguous,noOriginal,badTurn,'ADMITTED')
  await rejectedUnchanged(() => inExecution(pool,ambiguous,(tx) =>
    recordObservedTurnCancel(tx,request(ambiguous,badTurn),ambiguous.context.runtimeUnitId)), 'OBSERVED_TURN_NO_ORIGINAL')
  const conflicting = await delivery(pool,ambiguous)
  await observe(pool,ambiguous,conflicting,badTurn,'ADMITTED')
  await rejectedUnchanged(() => inExecution(pool,ambiguous,(tx) =>
    recordObservedTurnCancel(tx,request(ambiguous,badTurn),ambiguous.context.runtimeUnitId)), 'OBSERVED_TURN_AMBIGUOUS')

  const terminalTurn = `${prefix}-terminal`
  const terminalId = await delivery(pool,terminal)
  await observe(pool,terminal,terminalId,terminalTurn,'SETTLED')
  await observe(pool,terminal,terminalId,terminalTurn,'INTERRUPTED') // Contradictory late stop, no confirmation.
  const terminalBefore = await snapshot(pool,fixtures)
  const terminalResult = await inExecution(pool,terminal,(tx) =>
    recordObservedTurnCancel(tx,request(terminal,terminalTurn),terminal.context.runtimeUnitId))
  assert.equal(terminalResult.interruptStatus,'ALREADY_SETTLED')
  assert.equal(terminalResult.target.provenance.at(-1)?.classification,'CONTRADICTORY_NO_PERMISSION')
  const terminalIntent = await inspect(pool,terminalResult.operationId)
  assert.equal(terminalIntent.interrupt_status,'ALREADY_SETTLED')
  assert.equal(terminalIntent.interrupt_evidence_ref,null)
  assert.equal(terminalIntent.outbox,null)
  assert.deepEqual((await snapshot(pool,fixtures)).outbox,terminalBefore.outbox)
  const stopTurn = `${prefix}-stop`
  const stopId = await delivery(pool,stopped)
  await observe(pool,stopped,stopId,stopTurn,'ADMITTED')
  const stopRequest = await inExecution(pool,stopped,(tx) =>
    recordObservedTurnCancel(tx,request(stopped,stopTurn),stopped.context.runtimeUnitId))
  await observe(pool,stopped,stopId,stopTurn,'INTERRUPTED')
  assert.equal((await inspect(pool,stopRequest.operationId)).interrupt_status,'CONFIRMED')
  const stopBefore = await snapshot(pool,fixtures)
  const stopResult = await inExecution(pool,stopped,(tx) =>
    recordObservedTurnCancel(tx,request(stopped,stopTurn),stopped.context.runtimeUnitId))
  assert.equal(stopResult.interruptStatus,'ALREADY_SETTLED')
  assert.equal((await inspect(pool,stopResult.operationId)).outbox,null)
  assert.deepEqual((await snapshot(pool,fixtures)).outbox,stopBefore.outbox)

  // Negative fixture-only state: no verified original completion/stop exists.
  // Change only this callback's new mutable rows; never rewrite observation/context history.
  const unprovenTurn = `${prefix}-unproven`
  const unprovenId = await delivery(pool,unproven)
  await observe(pool,unproven,unprovenId,unprovenTurn,'ADMITTED')
  const unprovenRequest = await inExecution(pool,unproven,(tx) =>
    recordObservedTurnCancel(tx,request(unproven,unprovenTurn),unproven.context.runtimeUnitId))
  assert.equal(unprovenRequest.interruptStatus,'REQUESTED')
  await inExecution(pool,unproven,async (tx) => {
    await tx.query(
      `UPDATE durable_runtime.delivery_attempts SET state='SETTLED',completed_at=clock_timestamp()
       WHERE id=$1 AND session_id=$2`,[unprovenId,unproven.authority.sessionId]
    )
    await tx.query(
      `UPDATE durable_runtime.cancel_intents SET interrupt_status='CONFIRMED',
       interrupt_evidence_ref=$3,updated_at=clock_timestamp()
       WHERE operation_id=$1 AND session_id=$2`,
      [unprovenRequest.operationId,unproven.authority.sessionId,`${prefix}-bare-evidence`]
    )
  })
  // The production observation entry classifies this stop as contradictory to bare SETTLED state.
  await observe(pool,unproven,unprovenId,unprovenTurn,'INTERRUPTED')
  const unprovenBefore = await snapshot(pool,fixtures)
  const unprovenResult = await inExecution(pool,unproven,(tx) =>
    recordObservedTurnCancel(tx,request(unproven,unprovenTurn),unproven.context.runtimeUnitId))
  assert.equal(unprovenResult.interruptStatus,'REQUESTED',
    'bare delivery state/CONFIRMED evidence and late contradiction must not settle the original turn')
  assert.equal(unprovenResult.target.deliveryAttemptId,unprovenId)
  assert.deepEqual(unprovenResult.target.provenance.map((p) => [p.state,p.classification]),[
    ['ADMITTED','ORIGINAL_EXECUTION'],['INTERRUPTED','CONTRADICTORY_NO_PERMISSION']
  ])
  const unprovenIntent = await inspect(pool,unprovenResult.operationId)
  assert.equal(unprovenIntent.interrupt_status,'REQUESTED')
  assert.equal(unprovenIntent.interrupt_evidence_ref,null)
  assert.equal(unprovenIntent.outbox.kind,'INTERRUPT_FIXED_DELIVERY')
  assert.equal(unprovenIntent.outbox.fixedDelivery.deliveryAttemptId,unprovenId)
  assert.equal(unprovenIntent.outbox.fixedDelivery.nativeTurnId,unprovenTurn)
  const unprovenAfter = await snapshot(pool,fixtures)
  assert.equal(unprovenAfter.outbox.length,unprovenBefore.outbox.length+1)
  assert.deepEqual(unprovenAfter.deliveries,unprovenBefore.deliveries)
  assert.deepEqual(unprovenAfter.units,unprovenBefore.units)
  assert.deepEqual(unprovenAfter.attempts,unprovenBefore.attempts)
  assert.deepEqual(unprovenAfter.grants,unprovenBefore.grants)
  assert.deepEqual(unprovenAfter.cancels.find((row: { operation_id: string }) =>
    row.operation_id === unprovenRequest.operationId),
    unprovenBefore.cancels.find((row: { operation_id: string }) => row.operation_id === unprovenRequest.operationId))
  for (const previous of unprovenBefore.contexts) {
    assert.deepEqual(unprovenAfter.contexts.find((row: { id: string }) => row.id === previous.id),previous)
  }
  for (const previous of unprovenBefore.journal) {
    assert.deepEqual(unprovenAfter.journal.find((row: { event_id: string }) => row.event_id === previous.event_id),previous)
  }

  // Two distinct original requests remain fixed to A, even after another independent Message exists.
  const independentMessage = logicalId('message',randomUUID())
  await inExecution(pool,f,(tx) => tx.query(
    `INSERT INTO durable_runtime.messages(id,session_id,seq,body_or_blob_ref,intake_status)
     SELECT $1,$2,max(seq)+1,'{}','DURABLE' FROM durable_runtime.messages WHERE session_id=$2`,
    [independentMessage,f.authority.sessionId]
  ))
  const independentBefore = await pool.query('SELECT * FROM durable_runtime.messages WHERE id=$1',[independentMessage])
  const rapidOne = await inExecution(pool,f,(tx) => recordObservedTurnCancel(tx,request(f,turnA),f.context.runtimeUnitId))
  const rapidTwo = await inExecution(pool,f,(tx) => recordObservedTurnCancel(tx,request(f,turnA),f.context.runtimeUnitId))
  assert.notEqual(rapidOne.operationId,rapidTwo.operationId)
  assert.deepEqual(rapidOne.target,rapidTwo.target)
  assert.equal(rapidTwo.target.deliveryAttemptId,a)
  assert.deepEqual((await pool.query('SELECT * FROM durable_runtime.messages WHERE id=$1',[independentMessage])).rows,
    independentBefore.rows)

  // Fixture-only outer receipt. This is not a public RPC implementation or wire-support test.
  const receiptRequest = request(f,turnA)
  const receiptIdentity = {
    key: { principalId: f.authority.principal,sessionScope: inputScopeKey(f.authority),
      method: receiptRequest.method,operationKey: receiptRequest.operationKey },
    payloadHash: inputPayloadHash(receiptRequest.originalPayload),
    locks: { sessionIds: [f.authority.sessionId],runtimeUnitIds: [f.context.runtimeUnitId] }
  }
  let callbacks = 0
  const submit = () => runDurableMutation(pool,receiptIdentity,async (tx) => {
    callbacks++
    const value = await recordObservedTurnCancel(tx,receiptRequest,f.context.runtimeUnitId)
    return JSON.parse(JSON.stringify(value))
  })
  const first = await submit()
  assert.equal(first.status,'COMMITTED')
  const replayBefore = await snapshot(pool,fixtures)
  const replay = await submit()
  assert.equal(replay.status,'REPLAYED')
  assert.equal(callbacks,1)
  if (first.status !== 'UNCERTAIN' && replay.status !== 'UNCERTAIN') {
    assert.deepEqual(replay.receipt.response,first.receipt.response)
  }
  assert.deepEqual(await snapshot(pool,fixtures),replayBefore)
  await rejectedUnchanged(() => runDurableMutation(pool,
    { ...receiptIdentity,payloadHash: inputPayloadHash({ turnId: `${prefix}-different`,scope: 'root' }) },
    async () => { throw new Error('Conflicting receipt must not enter business callback') }), 'RECEIPT_PAYLOAD_CONFLICT')
  await rejectedUnchanged(() => inExecution(pool,f,async (tx) => {
    await recordObservedTurnCancel(tx,request(f,turnA),f.context.runtimeUnitId)
    throw new InputStoreError('SYNTHETIC_CANCEL_ROLLBACK')
  }), 'SYNTHETIC_CANCEL_ROLLBACK')

  // Mutate authority/request/query during the first SQL await, then restore owner method before COMMIT.
  const mutable = { ...request(f,turnA),originalPayload: { turnId: turnA,scope: 'root' } }
  const capturedBefore = await snapshot(pool,fixtures)
  let calls = 0
  const captured = await inExecution(pool,f,async (tx) => {
    const originalQuery = tx.query
    const ownerQuery = tx.query.bind(tx)
    const borrowed = new Proxy(tx,{
      get(owner,key) {
        if (key === 'query') {
          return (sql: string,values: readonly unknown[]) => {
            const pendingQuery = ownerQuery(sql,values)
            if (sql === 'SELECT id FROM durable_runtime.sessions WHERE id=$1') {
              calls++
              mutable.authority.principal = other.authority.principal
              mutable.authority.sessionId = other.authority.sessionId
              mutable.authority.scope = { kind: 'TERMINAL',terminalHandle: `${prefix}-wrong` }
              mutable.provider = 'claude'
              mutable.nativeTurnId = `${prefix}-wrong`
              mutable.method = 'synthetic.changed'
              mutable.operationKey = randomUUID()
              mutable.originalPayload.turnId = `${prefix}-wrong`
              Reflect.set(owner,'query',async () => { throw new Error('Borrowed query replaced after first await') })
            }
            return pendingQuery
          }
        }
        const value = Reflect.get(owner,key)
        return typeof value === 'function' ? value.bind(owner) : value
      }
    })
    try {
      return await recordObservedTurnCancel(borrowed,mutable,f.context.runtimeUnitId)
    } finally {
      Reflect.set(tx,'query',originalQuery)
    }
  })
  assert.ok(calls >= 1)
  assert.equal(captured.target.sessionId,f.authority.sessionId)
  assert.equal(captured.target.deliveryAttemptId,a)
  assert.equal((await inspect(pool,captured.operationId)).requested_by,f.authority.principal)
  const capturedAfter = await snapshot(pool,fixtures)
  assert.deepEqual(capturedAfter.deliveries,capturedBefore.deliveries)
  assert.deepEqual(capturedAfter.units,capturedBefore.units)
  assert.deepEqual(capturedAfter.attempts,capturedBefore.attempts)
  assert.deepEqual(capturedAfter.grants,capturedBefore.grants)

  // One regression for shared persistence: original Message-wide pre-effect behavior stays intact.
  const legacyDelivery = await delivery(pool,legacy,'STAGED')
  const legacyBefore = await snapshot(pool,fixtures)
  const old = await inExecution(pool,legacy,(tx) => recordInputCancel(tx,{
    authority: legacy.authority,method: 'synthetic.message-cancel',operationKey: randomUUID(),
    targetMessageId: legacy.messageId,originalPayload: {}
  },legacy.context.runtimeUnitId))
  assert.equal(old.interruptStatus,'NOT_REQUIRED')
  assert.deepEqual(Object.keys(old).sort(),[
    'operationId','targetMessageId','targetMessageRevision','cancelRevision','interruptStatus','contextRevision'
  ].sort())
  const legacyAfter = await snapshot(pool,fixtures)
  assert.equal(legacyAfter.messages.find((row: { id: string }) => row.id === legacy.messageId).intake_status,'CANCELLED')
  assert.equal(legacyAfter.deliveries.find((row: { id: string }) => row.id === legacyDelivery).state,'CANCELLED')
  assert.deepEqual(legacyAfter.outbox,legacyBefore.outbox)
  assert.deepEqual(legacyAfter.units,legacyBefore.units)
  assert.deepEqual(legacyAfter.attempts,legacyBefore.attempts)
  assert.deepEqual(legacyAfter.grants,legacyBefore.grants)
  assert.deepEqual(legacyAfter.ledger,before.ledger)
  assert.deepEqual((await pool.query(
    'SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version'
  )).rows,ledger.rows)
})
