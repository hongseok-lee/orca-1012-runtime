// Deferred PG fixture only. Every identity/proof below is synthetic, not provider authentication.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { appendSessionEvent } from '../journal/store.ts'
import { InputStoreError, type InputAuthority } from './types.ts'
import { executionFixture, fixed, inExecution, type ExecutionFixture } from './execution-fixtures.mts'
import { observeInputDeliveryInTransaction } from './observe.ts'
import { acceptInput } from './intake.ts'
import type { InputDeliveryObservation } from './observation-types.ts'
import { readObservedTurnTargetInTransaction } from './observed-turn-target.ts'

type SyntheticObservation = {
  state: 'ADMITTED' | 'SETTLED' | 'INTERRUPTED' | 'UNKNOWN'
  provider?: 'claude' | 'codex'
  nativeSession: string
  turn?: string
}
function observation(f: ExecutionFixture, deliveryId: string, input: SyntheticObservation): InputDeliveryObservation {
  const common = {
    evidenceRef: `synthetic-observed-turn-${randomUUID()}`,
    observedAt: new Date().toISOString()
  }
  // This assertion supplies only the fixture's opaque synthetic brand. Product has no proof issuer.
  if (input.state === 'UNKNOWN') {
    return {
      kind: 'UNKNOWN',
      uncertainty: { ...common, kind: 'INPUT_EFFECT_UNCERTAIN', reasonCode: 'SYNTHETIC_UNKNOWN', evidenceRefs: [] }
    } as unknown as InputDeliveryObservation
  }
  return {
    kind: input.state,
    proof: {
      ...common, ...fixed(f, deliveryId),
      kind: input.state === 'ADMITTED' ? 'PROVIDER_ADMISSION' :
        input.state === 'SETTLED' ? 'PROVIDER_TARGET_COMPLETED' : 'PROVIDER_TARGET_STOPPED',
      source: 'PROVIDER_PROTOCOL', targetMessageId: f.messageId,
      providerRef: {
        provider: input.provider ?? 'codex', nativeSessionRef: input.nativeSession,
        ...(input.turn === undefined ? {} : { nativeTurnId: input.turn })
      }
    }
  } as unknown as InputDeliveryObservation
}
async function delivery(pool: Pool, f: ExecutionFixture, status = 'EFFECT_POSSIBLE', providerRef: string | null = null) {
  const id = logicalId('delivery-attempt', randomUUID())
  // New fixture-owned row only; no existing history/trigger mutation.
  await inExecution(pool, f, (tx) => tx.query(
    `INSERT INTO durable_runtime.delivery_attempts
      (id,message_id,session_id,runtime_unit_id,attempt_id,execution_epoch,state,provider_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id,f.messageId,f.authority.sessionId,f.context.runtimeUnitId,f.attemptId,
      f.envelope.executionEpoch,status,providerRef]
  ))
  return id
}
async function observe(pool: Pool, f: ExecutionFixture, id: string, input: SyntheticObservation) {
  return inExecution(pool, f, (tx) => observeInputDeliveryInTransaction(
    tx,f.authority,fixed(f,id),observation(f,id,input)
  ))
}
async function snapshot(pool: Pool, fixtures: readonly ExecutionFixture[]) {
  const sessions = fixtures.map((f) => f.authority.sessionId)
  const units = fixtures.map((f) => f.context.runtimeUnitId)
  const principals = fixtures.map((f) => f.authority.principal)
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
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.outbox_events r WHERE r.aggregate_id=ANY($2::uuid[]) OR r.aggregate_id=ANY($1::uuid[])) AS outbox,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.runtime_units r WHERE r.id=ANY($2::uuid[])) AS units,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.attempts r WHERE r.runtime_unit_id=ANY($2::uuid[])) AS attempts,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.runtime_audit_events r WHERE r.session_id=ANY($1::uuid[])) AS audit,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.principal_id,r.session_scope,r.method,r.operation_key)
         FROM durable_runtime.rpc_receipts r WHERE r.principal_id=ANY($3::text[])) AS receipts`,
    [sessions,units,principals]
  )
  return result.rows[0]
}

await test('observed turn resolves only immutable original execution and preserves read boundaries', async (t) => {
  assert.equal(process.env.PGDATABASE, 'orca_observed_turn_20261014')
  assert.equal(process.env.ORCA_OBSERVED_TURN_PG_APPROVED, 'root-observed-turn-target')
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
  assert.equal(actual.database,'orca_observed_turn_20261014')
  assert.equal(actual.system_identifier,'7696101282789175327')
  assert.deepEqual(actual.datasets,['orca-1012-dev-v1'])
  assert.match(actual.database_oid,/^[1-9][0-9]*$/)
  assert.ok(Number.isInteger(actual.backend_pid) && actual.backend_pid > 0)
  const ledger = await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')
  assert.equal(ledger.rows.length, 19)
  const f = await executionFixture(pool)
  const other = await executionFixture(pool)
  const fixtures = [f,other]
  const namespace = `synthetic-observed-turn-${randomUUID()}`
  const turn = `${namespace}-turn`
  const nativeSession = `${namespace}-native`
  async function read(owner: ExecutionFixture, nativeTurn: string, expected: 'claude' | 'codex' = 'codex') {
    const before = await snapshot(pool,fixtures)
    try {
      return await inExecution(pool,owner,(tx) =>
        readObservedTurnTargetInTransaction(tx,owner.authority,expected,nativeTurn))
    } finally {
      assert.deepEqual(await snapshot(pool,fixtures),before,'resolver must not alter ledger/seed/input/cancel/context/journal/outbox/intent')
    }
  }
  const id = await delivery(pool,f)
  await observe(pool,f,id,{ state: 'ADMITTED', nativeSession, turn })
  await observe(pool,f,id,{ state: 'SETTLED', nativeSession, turn })
  const first = await read(f,turn)
  assert.equal(first.messageId,f.messageId)
  assert.equal(first.deliveryAttemptId,id)
  assert.equal(first.runtimeUnitId,f.context.runtimeUnitId)
  assert.equal(first.attemptId,f.attemptId)
  assert.equal(first.executionEpoch,f.envelope.executionEpoch)
  assert.equal(first.podUid,f.podUid)
  assert.equal(first.nativeSessionRef,nativeSession)
  assert.equal(first.nativeTurnId,turn)
  assert.deepEqual(first.provenance.map((p) => p.state),['ADMITTED','SETTLED'])
  assert.ok(first.provenance.every((p) => p.classification === 'ORIGINAL_EXECUTION'))
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.provenance))
  assert.ok(first.provenance.every(Object.isFrozen))
  assert.ok(!('proof' in first) && !('permission' in first) && !('cancelled' in first))
  const otherId = await delivery(pool,other)
  await observe(pool,other,otherId,{ state: 'ADMITTED', nativeSession: `${namespace}-other`, turn })
  assert.equal((await read(f,turn)).deliveryAttemptId,id,'same turn in another Session is isolated')
  assert.equal((await read(other,turn)).deliveryAttemptId,otherId)
  await observe(pool,f,id,{ state: 'INTERRUPTED', nativeSession, turn })
  const late = await read(f,turn)
  assert.equal(late.deliveryAttemptId,id)
  assert.equal(late.provenance[2].classification,'CONTRADICTORY_NO_PERMISSION')
  assert.equal(late.provenance[2].state,'INTERRUPTED')
  assert.ok(!('stoppedProof' in late),'late contradiction supplies no stop proof')
  await assert.rejects(read(f,turn,'claude'),{ code: 'OBSERVED_TURN_PROVIDER_MISMATCH' })
  const noLockBefore = await snapshot(pool,fixtures)
  await assert.rejects(withDurableTransaction(pool,(tx) =>
    readObservedTurnTargetInTransaction(tx,f.authority,'codex',turn)),{ code: 'INPUT_SESSION_LOCK_REQUIRED' })
  assert.deepEqual(await snapshot(pool,fixtures),noLockBefore)

  const mutable: InputAuthority = { ...f.authority, scope: { ...f.authority.scope } }
  const captureBefore = await snapshot(pool,fixtures)
  const captured = await inExecution(pool,f,async (tx) => {
    let scopeCalls = 0
    const borrowed = new Proxy(tx,{
      get(target,key) {
        if (key === 'query') {
          const ownerQuery = target.query.bind(target)
          return (sql: string, values: readonly unknown[]) => {
            const pending = ownerQuery(sql,values)
            if (sql === 'SELECT id FROM durable_runtime.sessions WHERE id=$1') {
              scopeCalls++
              mutable.sessionId = other.authority.sessionId
              mutable.scope = { kind: 'TERMINAL', terminalHandle: `${namespace}-wrong` }
              Reflect.set(target,'query',async () => { throw new Error('Borrowed query changed after first await') })
            }
            return pending
          }
        }
        const value = Reflect.get(target,key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const result = await readObservedTurnTargetInTransaction(borrowed,mutable,'codex',turn)
    assert.equal(scopeCalls,1)
    return result
  })
  assert.equal(captured.sessionId,f.authority.sessionId)
  assert.equal(captured.deliveryAttemptId,id)
  assert.deepEqual(await snapshot(pool,fixtures),captureBefore)

  const noTurn = `${namespace}-provider-ref-only`
  await delivery(pool,f,'EFFECT_POSSIBLE',noTurn)
  await assert.rejects(read(f,noTurn),{ code: 'OBSERVED_TURN_NOT_FOUND' })
  const clientOnly = `${namespace}-client-message-only`
  await acceptInput(pool,{ ...f.request, operationKey: randomUUID(),
    payload: { text: 'synthetic input with only clientMessageId', clientMessageId: clientOnly } })
  await assert.rejects(read(f,clientOnly),{ code: 'OBSERVED_TURN_NOT_FOUND' })
  const missingId = await delivery(pool,f)
  await observe(pool,f,missingId,{ state: 'ADMITTED', nativeSession: `${namespace}-missing` })
  await assert.rejects(read(f,`${namespace}-missing`),{ code: 'OBSERVED_TURN_NOT_FOUND' })
  const unknownId = await delivery(pool,f)
  await observe(pool,f,unknownId,{ state: 'UNKNOWN', nativeSession: `${namespace}-unknown` })
  await assert.rejects(read(f,`${namespace}-unknown`),{ code: 'OBSERVED_TURN_NOT_FOUND' })

  const ambiguous = `${namespace}-ambiguous`
  const normal = await delivery(pool,f)
  const conflict = await delivery(pool,f,'CANCELLED')
  await observe(pool,f,conflict,{ state: 'ADMITTED', nativeSession: `${namespace}-old`, turn: ambiguous })
  await assert.rejects(read(f,ambiguous),{ code: 'OBSERVED_TURN_NO_ORIGINAL' })
  await observe(pool,f,normal,{ state: 'ADMITTED', nativeSession, turn: ambiguous })
  await assert.rejects(read(f,ambiguous),{ code: 'OBSERVED_TURN_AMBIGUOUS' })
  const changedNative = `${namespace}-same-delivery-two-native`
  const sameDelivery = await delivery(pool,f)
  await observe(pool,f,sameDelivery,{ state: 'ADMITTED', nativeSession, turn: changedNative })
  await observe(pool,f,sameDelivery,{ state: 'ADMITTED', nativeSession: `${namespace}-changed`, turn: changedNative })
  await assert.rejects(read(f,changedNative),{ code: 'OBSERVED_TURN_AMBIGUOUS' })
  const twoDeliveries = `${namespace}-two-original-deliveries`
  for (let i = 0; i < 2; i++) {
    const newId = await delivery(pool,f)
    await observe(pool,f,newId,{ state: 'ADMITTED', nativeSession, turn: twoDeliveries })
  }
  await assert.rejects(read(f,twoDeliveries),{ code: 'OBSERVED_TURN_AMBIGUOUS' })

  // Explicit non-production malformed candidate: new append-only rows, never UPDATE/DELETE history.
  const malformed = `${namespace}-missing-context`
  await inExecution(pool,f,(tx) => appendSessionEvent(tx,{
    sessionId: f.authority.sessionId,
    source: { kind: 'NATIVE', sourceKind: 'INPUT_ADMITTED', provider: 'codex', lineage: id, nativeId: `${namespace}-orphan` },
    body: { kind: 'INPUT_OBSERVATION', state: 'ADMITTED', ...fixed(f,id),
      provider: 'codex', nativeSessionRef: nativeSession, nativeTurnId: malformed,
      evidenceRef: `${namespace}-orphan`, observedAt: new Date().toISOString() }
  }))
  await assert.rejects(read(f,malformed),InputStoreError)
  const afterLedger = await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')
  assert.deepEqual(afterLedger.rows,ledger.rows)
})
