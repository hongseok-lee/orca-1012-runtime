import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { DurableDatabaseError, runDurableTransaction, withDurableTransaction } from './connection.ts'
import type { DurableTransaction, DurableTransactionResult } from './connection.ts'

// Controllable transport responses only; no PostgreSQL/socket failure is reproduced.
function transport(options: {
  checkoutError?: unknown; beginError?: unknown; commitError?: unknown; rollbackError?: unknown;
  cleanupError?: unknown; commitGate?: Promise<void>; commitStarted?: () => void;
  rollbackGate?: Promise<void>; rollbackStarted?: () => void;
  beginResult?: unknown; commitResult?: unknown; rollbackResult?: unknown;
} = {}) {
  const sql: string[] = [], releases: boolean[] = []
  const events: string[] = []
  let connects = 0
  const client = {
    async query(statement: string) {
      sql.push(statement); events.push(statement)
      if (statement.startsWith('BEGIN') && options.beginError) { throw options.beginError }
      if (statement === 'COMMIT') {
        options.commitStarted?.(); await options.commitGate
        if (options.commitError) { throw options.commitError }
        events.push('COMMIT_ACK')
      }
      if (statement === 'ROLLBACK') {
        options.rollbackStarted?.(); await options.rollbackGate
        if (options.rollbackError) { throw options.rollbackError }
        events.push('ROLLBACK_ACK')
      }
      if (statement.startsWith('BEGIN') && Object.hasOwn(options, 'beginResult')) { return options.beginResult }
      if (statement === 'COMMIT' && Object.hasOwn(options, 'commitResult')) { return options.commitResult }
      if (statement === 'ROLLBACK' && Object.hasOwn(options, 'rollbackResult')) { return options.rollbackResult }
      return { command: statement.startsWith('BEGIN') ? 'BEGIN' : statement, rowCount: 0, oid: 0, fields: [], rows: [] }
    },
    release(destroy: boolean) {
      releases.push(destroy); events.push('RELEASE')
      if (options.cleanupError) { throw options.cleanupError }
    }
  }
  const borrowedPool = {
    async connect() {
      connects++; events.push('CHECKOUT')
      if (options.checkoutError) { throw options.checkoutError }
      // SAFETY: this focused fixture implements the query/release surface used
      // by the real engine; it is a synthetic transport, never a live PG client.
      return client as PoolClient
    }
  }
  // SAFETY: only connect is consumed by the real transaction engine. No other
  // Pool methods, connection credentials, server or authority are supplied.
  const pool = borrowedPool as Pool
  return { pool, sql, releases, events, connects: () => connects }
}
function failure<T>(outcome: DurableTransactionResult<T>) {
  assert.equal(outcome.ok, false)
  if (outcome.ok) { throw new Error('Expected failed transaction fixture result') }
  assert.ok(Object.isFrozen(outcome))
  assert.ok(outcome.error instanceof DurableDatabaseError)
  assert.equal('value' in outcome, false)
  assert.equal('cause' in outcome, false)
  return outcome
}
const begin = 'BEGIN ISOLATION LEVEL READ COMMITTED'

await test('Transaction settlement: consumer-visible ACK, uncertainty and cleanup boundaries', async () => {
  const commit = Promise.withResolvers<void>(), enteredCommit = Promise.withResolvers<void>()
  const pendingTransport = transport({ commitGate: commit.promise, commitStarted: () => enteredCommit.resolve() })
  const marker = Object.freeze({ value: 'fixture-body-value' })
  let delivered = false, escaped: DurableTransaction | undefined
  const pending = runDurableTransaction(pendingTransport.pool, async tx => {
    escaped = tx
    pendingTransport.events.push('BODY_RETURN')
    return marker
  }).then(outcome => { delivered = true; pendingTransport.events.push('RESULT'); return outcome })
  await enteredCommit.promise
  await Promise.resolve()
  assert.equal(delivered, false, 'body return is not transaction settlement')
  assert.deepEqual(pendingTransport.releases, [])
  assert.equal(pendingTransport.events.includes('COMMIT_ACK'), false)
  commit.resolve()
  const committed = await pending
  assert.deepEqual(committed, { ok: true, settlement: 'COMMITTED', commitOutcome: 'ACKNOWLEDGED', value: marker, cleanupFailed: false })
  assert.ok(Object.isFrozen(committed)); assert.deepEqual(pendingTransport.sql, [begin, 'COMMIT'])
  assert.deepEqual(pendingTransport.releases, [false]); assert.equal(pendingTransport.connects(), 1)
  assert.ok(pendingTransport.events.indexOf('RESULT') > pendingTransport.events.indexOf('RELEASE'))
  assert.ok(escaped)
  await assert.rejects(escaped.query('SELECT fixture_after_close'), error =>
    error instanceof DurableDatabaseError && error.code === 'TX_CLOSED')
  assert.deepEqual(pendingTransport.sql, [begin, 'COMMIT'])

  const commitFailure = new DurableDatabaseError('40001')
  const rollback = Promise.withResolvers<void>(), enteredRollback = Promise.withResolvers<void>()
  const commitLost = transport({ commitError: commitFailure, rollbackGate: rollback.promise,
    rollbackStarted: () => enteredRollback.resolve() })
  let unknownDelivered = false
  const unknownPending = runDurableTransaction(commitLost.pool, async () => marker)
    .then(outcome => { unknownDelivered = true; return outcome })
  await enteredRollback.promise; await Promise.resolve()
  assert.equal(unknownDelivered, false, 'COMMIT error does not confirm termination before ROLLBACK ACK')
  assert.deepEqual(commitLost.releases, [])
  rollback.resolve()
  const rolledBackAfterCommit = failure(await unknownPending)
  assert.equal(rolledBackAfterCommit.settlement, 'ROLLED_BACK')
  assert.equal(rolledBackAfterCommit.commitOutcome, 'UNKNOWN')
  assert.equal(rolledBackAfterCommit.error, commitFailure)
  assert.equal(rolledBackAfterCommit.cleanupFailed, false)
  assert.deepEqual(commitLost.sql, [begin, 'COMMIT', 'ROLLBACK'])
  assert.deepEqual(commitLost.releases, [false])

  for (const commitAttempted of [false, true]) {
    const primary = new DurableDatabaseError(commitAttempted ? '40001' : 'STORAGE_FIXTURE_BODY')
    const broken = transport({ commitError: commitAttempted ? primary : undefined,
      rollbackError: new Error('synthetic rollback transport loss'), cleanupError: new Error('synthetic cleanup failure') })
    const unconfirmed = failure(await runDurableTransaction(broken.pool, async () => {
      if (!commitAttempted) { throw primary }
      return marker
    }))
    assert.equal(unconfirmed.settlement, 'UNCONFIRMED')
    assert.equal(unconfirmed.commitOutcome, commitAttempted ? 'UNKNOWN' : 'NOT_ATTEMPTED')
    assert.equal(unconfirmed.error, primary)
    assert.equal(unconfirmed.cleanupFailed, true)
    assert.deepEqual(broken.releases, [true], 'destroy request does not prove server termination')
    assert.deepEqual(broken.sql, commitAttempted ? [begin, 'COMMIT', 'ROLLBACK'] : [begin, 'ROLLBACK'])
  }

  const noCheckout = transport({ checkoutError: { code: '08006', message: 'synthetic raw checkout details' } })
  let checkoutBodyCalls = 0
  const notStarted = failure(await runDurableTransaction(noCheckout.pool, async () => { checkoutBodyCalls++; return marker }))
  assert.equal(notStarted.settlement, 'NOT_STARTED'); assert.equal(notStarted.commitOutcome, 'NOT_ATTEMPTED')
  assert.equal(notStarted.cleanupFailed, false); assert.equal(notStarted.error.code, '08006')
  assert.equal(notStarted.error.message, 'Durable database operation failed (08006)')
  assert.equal(checkoutBodyCalls, 0); assert.deepEqual(noCheckout.sql, []); assert.deepEqual(noCheckout.releases, [])

  for (const phase of ['BEGIN', 'BODY'] as const) {
    const original = new DurableDatabaseError(phase === 'BEGIN' ? '08006' : 'STORAGE_FIXTURE_BODY')
    const fake = transport({ beginError: phase === 'BEGIN' ? original : undefined })
    let bodyCalls = 0
    const rolledBack = failure(await runDurableTransaction(fake.pool, async () => {
      bodyCalls++; throw original
    }))
    assert.equal(rolledBack.settlement, 'ROLLED_BACK'); assert.equal(rolledBack.commitOutcome, 'NOT_ATTEMPTED')
    assert.equal(rolledBack.error, original); assert.equal(rolledBack.cleanupFailed, false)
    assert.equal(bodyCalls, phase === 'BEGIN' ? 0 : 1)
    assert.deepEqual(fake.sql, [begin, 'ROLLBACK']); assert.deepEqual(fake.releases, [false])
    const wrapperFake = transport({ beginError: phase === 'BEGIN' ? original : undefined })
    await assert.rejects(withDurableTransaction(wrapperFake.pool, async () => { throw original }), error => error === original)
    assert.deepEqual(wrapperFake.sql, [begin, 'ROLLBACK']); assert.deepEqual(wrapperFake.releases, [false])
  }

  const rawBody = transport({ rollbackError: new Error('synthetic private rollback details') })
  const sanitizedBody = failure(await runDurableTransaction(rawBody.pool, async () => {
    throw { code: '23514', message: 'synthetic SQL and credential details' }
  }))
  assert.equal(sanitizedBody.settlement, 'UNCONFIRMED')
  assert.equal(sanitizedBody.commitOutcome, 'NOT_ATTEMPTED')
  assert.equal(sanitizedBody.error.code, '23514')
  assert.equal(sanitizedBody.error.message, 'Durable database operation failed (23514)')
  assert.equal('cause' in sanitizedBody.error, false)
  assert.deepEqual(rawBody.releases, [true])

  const successCleanup = transport({ cleanupError: new Error('synthetic private cleanup text') })
  const ackWithFailedCleanup = await runDurableTransaction(successCleanup.pool, async () => marker)
  assert.deepEqual(ackWithFailedCleanup, { ok: true, settlement: 'COMMITTED', commitOutcome: 'ACKNOWLEDGED',
    value: marker, cleanupFailed: true })
  assert.ok(Object.isFrozen(ackWithFailedCleanup))
  assert.deepEqual(successCleanup.events, ['CHECKOUT', begin, 'COMMIT', 'COMMIT_ACK', 'RELEASE'])
  assert.equal('error' in ackWithFailedCleanup, false)
  const rollbackPrimary = new DurableDatabaseError('STORAGE_FIXTURE_BODY')
  const rollbackCleanup = transport({ cleanupError: new Error('synthetic cleanup text') })
  const rollbackAck = failure(await runDurableTransaction(rollbackCleanup.pool, async () => { throw rollbackPrimary }))
  assert.equal(rollbackAck.settlement, 'ROLLED_BACK'); assert.equal(rollbackAck.commitOutcome, 'NOT_ATTEMPTED')
  assert.equal(rollbackAck.cleanupFailed, true); assert.equal(rollbackAck.error, rollbackPrimary)
  const wrapperCleanup = transport({ cleanupError: new Error('synthetic raw cleanup details') })
  await assert.rejects(withDurableTransaction(wrapperCleanup.pool, async () => marker), error =>
    error instanceof DurableDatabaseError && error.code === 'DB_FAILURE' && !error.message.includes('synthetic'))
  const wrapperPrimary = transport({ cleanupError: new Error('synthetic raw cleanup details') })
  await assert.rejects(withDurableTransaction(wrapperPrimary.pool, async () => { throw rollbackPrimary }), error => error === rollbackPrimary)

  // An aborted transaction can answer COMMIT with a ROLLBACK command tag.
  const commitRolledBack = transport({ commitResult: { command: 'ROLLBACK' } })
  const notCommitted = failure(await runDurableTransaction(commitRolledBack.pool, async () => marker))
  assert.equal(notCommitted.settlement, 'ROLLED_BACK'); assert.equal(notCommitted.commitOutcome, 'NOT_COMMITTED')
  assert.equal(notCommitted.error.code, 'TX_NOT_COMMITTED'); assert.equal(notCommitted.cleanupFailed, false)
  assert.deepEqual(commitRolledBack.sql, [begin, 'COMMIT'], 'ROLLBACK command ACK needs no second rollback')
  assert.deepEqual(commitRolledBack.releases, [false])
  const wrapperNotCommitted = transport({ commitResult: { command: 'ROLLBACK' } })
  await assert.rejects(withDurableTransaction(wrapperNotCommitted.pool, async () => marker), error =>
    error instanceof DurableDatabaseError && error.code === 'TX_NOT_COMMITTED')
  assert.deepEqual(wrapperNotCommitted.sql, [begin, 'COMMIT'])
  const rolledBackCleanup = transport({ commitResult: { command: 'ROLLBACK' }, cleanupError: new Error('synthetic cleanup') })
  const notCommittedCleanup = failure(await runDurableTransaction(rolledBackCleanup.pool, async () => marker))
  assert.equal(notCommittedCleanup.settlement, 'ROLLED_BACK'); assert.equal(notCommittedCleanup.commitOutcome, 'NOT_COMMITTED')
  assert.equal(notCommittedCleanup.error.code, 'TX_NOT_COMMITTED'); assert.equal(notCommittedCleanup.cleanupFailed, true)

  const invalidAcks = [undefined, null, {}, { command: 'SELECT' }, [{ command: 'COMMIT' }]]
  for (const invalidAck of invalidAcks) {
    const wrongCommit = transport({ commitResult: invalidAck })
    const unknownCommit = failure(await runDurableTransaction(wrongCommit.pool, async () => marker))
    assert.equal(unknownCommit.settlement, 'ROLLED_BACK'); assert.equal(unknownCommit.commitOutcome, 'UNKNOWN')
    assert.equal(unknownCommit.error.code, 'TX_COMMIT_UNCONFIRMED')
    assert.deepEqual(wrongCommit.sql, [begin, 'COMMIT', 'ROLLBACK']); assert.deepEqual(wrongCommit.releases, [false])
    const wrongBegin = transport({ beginResult: invalidAck })
    let wrongBeginBodyCalls = 0
    const beginUnconfirmed = failure(await runDurableTransaction(wrongBegin.pool, async () => { wrongBeginBodyCalls++; return marker }))
    assert.equal(beginUnconfirmed.settlement, 'ROLLED_BACK'); assert.equal(beginUnconfirmed.commitOutcome, 'NOT_ATTEMPTED')
    assert.equal(beginUnconfirmed.error.code, 'TX_BEGIN_UNCONFIRMED'); assert.equal(wrongBeginBodyCalls, 0)
    assert.deepEqual(wrongBegin.sql, [begin, 'ROLLBACK'])
    for (const commitAttempted of [false, true]) {
      const first = new DurableDatabaseError(commitAttempted ? '40001' : 'STORAGE_FIXTURE_BODY')
      const wrongRollback = transport({ rollbackResult: invalidAck, commitError: commitAttempted ? first : undefined })
      const unconfirmed = failure(await runDurableTransaction(wrongRollback.pool, async () => {
        if (!commitAttempted) { throw first }
        return marker
      }))
      assert.equal(unconfirmed.settlement, 'UNCONFIRMED')
      assert.equal(unconfirmed.commitOutcome, commitAttempted ? 'UNKNOWN' : 'NOT_ATTEMPTED')
      assert.equal(unconfirmed.error, first); assert.deepEqual(wrongRollback.releases, [true])
    }
  }
  const ambiguousBoth = transport({ commitResult: { command: 'OTHER' }, rollbackResult: [] })
  const ambiguousResult = failure(await runDurableTransaction(ambiguousBoth.pool, async () => marker))
  assert.equal(ambiguousResult.settlement, 'UNCONFIRMED'); assert.equal(ambiguousResult.commitOutcome, 'UNKNOWN')
  assert.equal(ambiguousResult.error.code, 'TX_COMMIT_UNCONFIRMED'); assert.deepEqual(ambiguousBoth.releases, [true])

  const wrapperSuccess = transport()
  assert.equal(await withDurableTransaction(wrapperSuccess.pool, async () => marker), marker)
  assert.deepEqual(wrapperSuccess.sql, [begin, 'COMMIT']); assert.deepEqual(wrapperSuccess.releases, [false])
  assert.equal(wrapperSuccess.connects(), 1)
  const wrapperConnect = transport({ checkoutError: new DurableDatabaseError('08006') })
  await assert.rejects(withDurableTransaction(wrapperConnect.pool, async () => marker), error =>
    error instanceof DurableDatabaseError && error.code === '08006')
  assert.deepEqual(wrapperConnect.sql, []); assert.deepEqual(wrapperConnect.releases, [])
})
