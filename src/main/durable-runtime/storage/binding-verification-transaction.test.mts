import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { DurableDatabaseError } from '../db/connection.ts'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { BindingVerificationInput } from './binding-verification.ts'
import { verifyBindingWithPreparedPin } from './binding-verification-transaction.ts'
import type { PreparedBindingPinOwner, PreparedBindingPinLease, BindingVerificationTransactionResult } from './binding-verification-transaction.ts'
import type { StorageEvidenceAuthority, VerifiedDirectoryEvidence } from './evidence.ts'

// Real engine/Store/verifier, synthetic prepared authority and SQL transport.
// Existing VERIFIED exact replay isolates pin lifetime without repeating PG seeds.
function fixture(options: {
  checkoutError?: Error; commitError?: Error; rollbackError?: Error; cleanupError?: Error;
  bodyError?: Error; bodyGate?: Promise<void>; bodyStarted?: () => void;
  commitGate?: Promise<void>; commitStarted?: () => void;
  rollbackGate?: Promise<void>; rollbackStarted?: () => void;
  releaseGate?: Promise<void>; releaseStarted?: () => void; releaseError?: Error; takeError?: Error;
  invalidHandoff?: 'evidence-getter' | 'release-getter' | 'mutable';
} = {}) {
  const events: string[] = [], sql: string[] = [], connectionReleases: boolean[] = []
  const state = { pinHeld: true, taken: false, takes: 0, releases: 0, connectCalls: 0, leaseGetterReads: 0 }
  const unit = logicalId('runtime-unit', randomUUID()), member = logicalId('session', randomUUID())
  const binding = logicalId('storage-binding', randomUUID()), ref = `synthetic-held:${randomUUID()}`
  // SAFETY: fixture-only immutable prepared evidence; it is not a physical pin
  // issuer, authenticated observation, mount permission or production authority.
  const evidence = Object.freeze({ evidenceRef: ref, topologyPinId: `synthetic-pin:${randomUUID()}`,
    candidate: Object.freeze({ domain: Object.freeze({ backendId: 'synthetic-backend', exportId: 'synthetic-export', pvUid: 'synthetic-pv' }),
      canonicalDirectory: '/synthetic-held-leaf', podUid: 'synthetic-server', generation: 'synthetic-1', device: '1', inode: '2' })
  }) as VerifiedDirectoryEvidence
  const authority: StorageEvidenceAuthority = Object.freeze({
    directory(reference: string) { assert.equal(this, authority); return reference === ref ? evidence : null },
    directoryPinValid(held: VerifiedDirectoryEvidence) { assert.equal(this, authority); return held === evidence && state.pinHeld },
    mount() { return null }, mountPinValid() { return false }, executionTarget() { return null },
    executionTargetPinValid() { return false }, permanentComputeStop() { return null }, computeStopPinValid() { return false }
  })
  const release = async function (this: PreparedBindingPinLease) {
    assert.equal(this, lease); assert.equal(state.pinHeld, true)
    state.releases++; events.push('PIN_RELEASE_REQUEST'); options.releaseStarted?.()
    await options.releaseGate
    if (options.releaseError) { throw options.releaseError }
    state.pinHeld = false; events.push('PIN_RELEASED')
  }
  const lease: PreparedBindingPinLease = options.invalidHandoff === 'evidence-getter'
    ? Object.freeze({ get evidence(): VerifiedDirectoryEvidence {
      state.leaseGetterReads++; throw new Error('synthetic evidence getter throws after transfer')
    }, release })
    : options.invalidHandoff === 'release-getter'
      ? Object.freeze({ evidence, get release(): () => Promise<void> {
        state.leaseGetterReads++; throw new Error('synthetic release getter throws after transfer')
      } })
      : options.invalidHandoff === 'mutable' ? { evidence, release } : Object.freeze({ evidence, release })
  const owner: PreparedBindingPinOwner = Object.freeze({
    takePreparedPin(held: VerifiedDirectoryEvidence) {
      assert.equal(this, owner); assert.equal(held, evidence); assert.equal(state.pinHeld, true)
      if (options.takeError) { throw options.takeError }
      assert.equal(state.taken, false, 'trusted owner hands off exclusively once')
      state.taken = true; state.takes++; events.push('PIN_TAKEN'); return lease
    }
  })
  const row = { id: binding, backend_id: 'synthetic-backend', export_id: 'synthetic-export',
    canonical_directory: '/synthetic-held-leaf', identity_proof_ref: ref, identity_verified_at: new Date(0),
    epoch: '0', revision: '1', access_state: 'VERIFIED', writer_attempt_id: null, seal_id: null }
  const client = {
    async query(statement: string) {
      assert.equal(state.pinHeld, true, 'pin must remain held for every transaction query')
      sql.push(statement)
      if (statement.startsWith('BEGIN')) { events.push('BEGIN'); return { command: 'BEGIN', rowCount: 0, rows: [] } }
      if (statement === 'COMMIT') {
        events.push('COMMIT_WAIT'); options.commitStarted?.(); await options.commitGate
        if (options.commitError) { throw options.commitError }
        events.push('COMMIT_ACK'); return { command: 'COMMIT', rowCount: 0, rows: [] }
      }
      if (statement === 'ROLLBACK') {
        events.push('ROLLBACK_WAIT'); options.rollbackStarted?.(); await options.rollbackGate
        if (options.rollbackError) { throw options.rollbackError }
        events.push('ROLLBACK_ACK'); return { command: 'ROLLBACK', rowCount: 0, rows: [] }
      }
      if (statement.startsWith('SELECT s.lifecycle')) {
        events.push('VERIFIER_BODY'); options.bodyStarted?.(); await options.bodyGate
        if (options.bodyError) { throw options.bodyError }
        return { command: 'SELECT', rowCount: 1, rows: [{ lifecycle: 'OPEN', revision: '0', member: true }] }
      }
      if (statement.startsWith('SELECT * FROM durable_runtime.storage_bindings')) {
        return { command: 'SELECT', rowCount: 1, rows: [row] }
      }
      if (statement.startsWith('SELECT EXISTS(')) {
        return { command: 'SELECT', rowCount: 1, rows: [{ grants: false, mounts: false }] }
      }
      if (statement.startsWith('SELECT id FROM durable_runtime.sessions')) { return { command: 'SELECT', rowCount: 1, rows: [{ id: member }] } }
      if (statement.startsWith('SELECT id FROM durable_runtime.runtime_units')) { return { command: 'SELECT', rowCount: 1, rows: [{ id: unit }] } }
      if (statement.startsWith('SELECT backend_id FROM durable_runtime.storage_domains')) {
        return { command: 'SELECT', rowCount: 1, rows: [{ backend_id: row.backend_id }] }
      }
      throw new Error('Unexpected synthetic SQL: mutation must not be needed for exact replay')
    },
    release(destroy: boolean) {
      assert.equal(state.pinHeld, true); events.push('CLIENT_RELEASE'); connectionReleases.push(destroy)
      if (options.cleanupError) { throw options.cleanupError }
    }
  }
  const poolObject = {
    async connect() {
      assert.equal(this, poolObject); assert.equal(state.taken, true); assert.equal(state.pinHeld, true)
      state.connectCalls++; events.push('CHECKOUT')
      if (options.checkoutError) { throw options.checkoutError }
      // SAFETY: focused synthetic query/release surface for the real engine;
      // no socket, database server or unimplemented PoolClient API is consumed.
      return client as PoolClient
    }
  }
  // SAFETY: only captured connect is consumed. This fixture has no real pool,
  // credentials, physical authority or implicit pool.end lifecycle.
  const pool = poolObject as Pool
  const input: BindingVerificationInput = { sessionId: member, unitId: unit, bindingId: binding,
    expectedUnitRevision: counter('row:runtime-unit', '0'), expectedBindingRevision: counter('row:storage-binding', '0'),
    directoryEvidenceRef: ref, actorId: 'synthetic-pin-owner' }
  const run = () => verifyBindingWithPreparedPin(pool, input, authority, owner)
  return { run, state, events, sql, connectionReleases, poolObject, input, owner, lease, binding }
}

function observed(result: BindingVerificationTransactionResult): asserts result is BindingVerificationTransactionResult & {
  database: NonNullable<BindingVerificationTransactionResult['database']>
} {
  assert.equal(result.engineError, null)
  assert.ok(result.database)
}

await test('Prepared binding pin: actual transaction settlement gates ownership release', async () => {
  const commit = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const delayedCommit = fixture({ commitGate: commit.promise, commitStarted: () => entered.resolve() })
  let delivered = false
  const pending = delayedCommit.run().then(result => { delivered = true; return result })
  assert.equal(delayedCommit.state.taken, true, 'handoff occurs before first await')
  await entered.promise; await Promise.resolve()
  assert.equal(delivered, false); assert.equal(delayedCommit.state.releases, 0); assert.equal(delayedCommit.state.pinHeld, true)
  // Borrowed connect and the input were captured before the checkout await.
  delayedCommit.poolObject.connect = async () => { throw new Error('late borrowed method replacement') }
  Object.assign(delayedCommit.input, { directoryEvidenceRef: 'changed-after-await', actorId: 'changed', bindingId: logicalId('storage-binding', randomUUID()) })
  commit.resolve()
  const committed = await pending; observed(committed)
  assert.equal(committed.database.ok, true); assert.equal(committed.database.settlement, 'COMMITTED')
  assert.equal(committed.database.commitOutcome, 'ACKNOWLEDGED'); assert.equal(committed.database.cleanupFailed, false)
  if (committed.database.ok) { assert.equal(committed.database.value.id, delayedCommit.binding) }
  assert.equal(committed.pin.disposition, 'RELEASED'); assert.equal(delayedCommit.state.releases, 1)
  assert.equal(delayedCommit.state.pinHeld, false); assert.equal(committed.physicalPinIssuerImplemented, false)
  assert.ok(Object.isFrozen(committed)); assert.ok(Object.isFrozen(committed.pin))
  assert.ok(delayedCommit.events.indexOf('PIN_RELEASE_REQUEST') > delayedCommit.events.indexOf('CLIENT_RELEASE'))
  assert.ok(delayedCommit.events.indexOf('CLIENT_RELEASE') > delayedCommit.events.indexOf('COMMIT_ACK'))

  for (const abort of [false, true]) {
    const body = Promise.withResolvers<void>(), rollback = Promise.withResolvers<void>()
    const bodyEntered = Promise.withResolvers<void>(), rollbackEntered = Promise.withResolvers<void>()
    const controller = new AbortController()
    const first = new DurableDatabaseError(abort ? 'STORAGE_FIXTURE_ABORTED' : 'STORAGE_FIXTURE_CALLBACK_FAILED')
    const delayedRollback = fixture({ bodyGate: body.promise, bodyStarted: () => bodyEntered.resolve(),
      bodyError: first, rollbackGate: rollback.promise, rollbackStarted: () => rollbackEntered.resolve() })
    if (abort) { controller.signal.addEventListener('abort', () => body.reject(first), { once: true }) }
    const result = delayedRollback.run()
    await bodyEntered.promise
    if (abort) { controller.abort() }
    assert.equal(delayedRollback.state.releases, 0); assert.equal(delayedRollback.state.pinHeld, true)
    if (!abort) { body.resolve() }
    await rollbackEntered.promise
    assert.equal(delayedRollback.state.releases, 0, 'callback failure/abort is not a release boundary')
    assert.equal(delayedRollback.state.pinHeld, true)
    rollback.resolve()
    const rolledBack = await result; observed(rolledBack)
    assert.equal(rolledBack.database.settlement, 'ROLLED_BACK'); assert.equal(rolledBack.database.commitOutcome, 'NOT_ATTEMPTED')
    if (!rolledBack.database.ok) { assert.equal(rolledBack.database.error, first) }
    assert.equal(rolledBack.pin.disposition, 'RELEASED'); assert.equal(delayedRollback.state.releases, 1)
    assert.ok(delayedRollback.events.indexOf('PIN_RELEASE_REQUEST') > delayedRollback.events.indexOf('ROLLBACK_ACK'))
  }

  const checkoutError = new DurableDatabaseError('08006'), noCheckout = fixture({ checkoutError })
  const notStarted = await noCheckout.run(); observed(notStarted)
  assert.equal(notStarted.database.settlement, 'NOT_STARTED'); assert.equal(notStarted.database.commitOutcome, 'NOT_ATTEMPTED')
  assert.deepEqual(noCheckout.sql, []); assert.deepEqual(noCheckout.connectionReleases, [])
  assert.equal(notStarted.pin.disposition, 'RELEASED'); assert.equal(noCheckout.state.releases, 1)

  const rollback = Promise.withResolvers<void>(), rollbackEntered = Promise.withResolvers<void>()
  const commitError = new DurableDatabaseError('08006')
  const unknown = fixture({ commitError, rollbackGate: rollback.promise, rollbackStarted: () => rollbackEntered.resolve(),
    cleanupError: new Error('synthetic client cleanup error') })
  const unknownPending = unknown.run(); await rollbackEntered.promise
  assert.equal(unknown.state.pinHeld, true); assert.equal(unknown.state.releases, 0)
  rollback.resolve()
  const terminatedUnknown = await unknownPending; observed(terminatedUnknown)
  assert.equal(terminatedUnknown.database.settlement, 'ROLLED_BACK'); assert.equal(terminatedUnknown.database.commitOutcome, 'UNKNOWN')
  assert.equal(terminatedUnknown.database.cleanupFailed, true)
  if (!terminatedUnknown.database.ok) { assert.equal(terminatedUnknown.database.error, commitError) }
  assert.equal(terminatedUnknown.pin.disposition, 'RELEASED'); assert.equal(unknown.state.releases, 1)

  const uncertain = fixture({ commitError, rollbackError: new Error('synthetic rollback transport failure') })
  const retained = await uncertain.run(); observed(retained)
  assert.equal(retained.database.settlement, 'UNCONFIRMED'); assert.equal(retained.database.commitOutcome, 'UNKNOWN')
  assert.deepEqual(uncertain.connectionReleases, [true]); assert.equal(uncertain.state.releases, 0)
  assert.equal(uncertain.state.pinHeld, true); assert.equal(retained.pin.disposition, 'RETAINED')
  if (retained.pin.disposition === 'RETAINED') {
    assert.equal(retained.pin.reason, 'UNCONFIRMED'); assert.equal(retained.pin.retainedOwner, uncertain.owner)
    assert.equal(retained.pin.retainedLease, uncertain.lease); assert.equal(retained.pin.releaseError, null)
  }

  const releaseGate = Promise.withResolvers<void>(), releaseStarted = Promise.withResolvers<void>()
  const releaseError = new Error('synthetic private release details')
  const failedRelease = fixture({ releaseGate: releaseGate.promise, releaseStarted: () => releaseStarted.resolve(),
    releaseError, cleanupError: new Error('synthetic cleanup') })
  const releasePending = failedRelease.run()
  // Wait on the release request rather than a fixed sleep or completion shortcut.
  await releaseStarted.promise
  assert.equal(failedRelease.state.pinHeld, true); assert.equal(failedRelease.state.releases, 1)
  releaseGate.resolve()
  const commitWithRetainedPin = await releasePending; observed(commitWithRetainedPin)
  assert.equal(commitWithRetainedPin.database.settlement, 'COMMITTED'); assert.equal(commitWithRetainedPin.database.commitOutcome, 'ACKNOWLEDGED')
  assert.equal(commitWithRetainedPin.database.cleanupFailed, true); assert.equal(commitWithRetainedPin.pin.disposition, 'RETAINED')
  assert.equal(failedRelease.state.releases, 1, 'no automatic second release')
  if (commitWithRetainedPin.pin.disposition === 'RETAINED') {
    assert.equal(commitWithRetainedPin.pin.reason, 'RELEASE_FAILED')
    assert.equal(commitWithRetainedPin.pin.retainedOwner, failedRelease.owner); assert.equal(commitWithRetainedPin.pin.retainedLease, failedRelease.lease)
    assert.equal(commitWithRetainedPin.pin.releaseError?.code, 'STORAGE_PIN_RELEASE_FAILED')
    assert.equal(commitWithRetainedPin.pin.releaseError?.message.includes('private'), false)
  }

  for (const invalidHandoff of ['evidence-getter', 'release-getter', 'mutable'] as const) {
    const invalid = fixture({ invalidHandoff })
    const invalidResult = await invalid.run(); observed(invalidResult)
    assert.equal(invalid.state.taken, true); assert.equal(invalid.state.pinHeld, true)
    assert.equal(invalid.state.connectCalls, 0); assert.deepEqual(invalid.sql, [])
    assert.equal(invalid.state.releases, 0); assert.equal(invalid.state.leaseGetterReads, 0)
    assert.equal(invalidResult.database.settlement, 'NOT_STARTED')
    if (invalidResult.pin.disposition === 'RETAINED') {
      assert.equal(invalidResult.pin.reason, 'INVALID_HANDOFF')
      assert.equal(invalidResult.pin.retainedOwner, invalid.owner); assert.equal(invalidResult.pin.retainedLease, invalid.lease)
    } else { assert.fail('invalid post-take lease must retain the same owner and handle') }
  }

  // The engine sanitizer itself can reject when a hostile error.code getter
  // throws after checkout rejection. No transaction outcome was then returned.
  const hostileCheckoutError = Object.defineProperty(new Error('synthetic checkout failure'), 'code', {
    get() { throw new Error('synthetic private escaped sanitizer details') }
  })
  const escaped = fixture({ checkoutError: hostileCheckoutError })
  const escapedResult = await escaped.run()
  assert.equal(escapedResult.database, null)
  assert.equal(escapedResult.engineError?.code, 'STORAGE_TRANSACTION_ENGINE_REJECTED')
  assert.equal(escapedResult.engineError?.message.includes('private'), false)
  assert.equal(escaped.state.pinHeld, true); assert.equal(escaped.state.releases, 0)
  assert.deepEqual(escaped.sql, []); assert.deepEqual(escaped.connectionReleases, [])
  if (escapedResult.pin.disposition === 'RETAINED') {
    assert.equal(escapedResult.pin.reason, 'ENGINE_REJECTED')
    assert.equal(escapedResult.pin.retainedOwner, escaped.owner); assert.equal(escapedResult.pin.retainedLease, escaped.lease)
  } else { assert.fail('escaped engine failure must retain its transferred pin handle') }

  const noTake = fixture({ takeError: new Error('synthetic atomic owner rejection') })
  const failedTake = await noTake.run(); observed(failedTake)
  assert.equal(failedTake.database.settlement, 'NOT_STARTED'); assert.equal(noTake.state.connectCalls, 0)
  assert.equal(noTake.state.pinHeld, true); assert.equal(noTake.state.releases, 0)
  if (failedTake.pin.disposition === 'RETAINED') {
    assert.equal(failedTake.pin.reason, 'TAKE_FAILED'); assert.equal(failedTake.pin.retainedOwner, noTake.owner)
    assert.equal(failedTake.pin.retainedLease, null)
  } else { assert.fail('failed atomic take must retain its original owner') }
})
