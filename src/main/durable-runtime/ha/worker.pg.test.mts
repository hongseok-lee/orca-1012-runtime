import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { PoolClient } from 'pg'
import { fixture, intent, executor } from '../lifecycle/verification-fixtures.mts'
import { requestUnitIntent } from '../lifecycle/intent.ts'
import type { ControllerPassRequest } from './pass.ts'
import { CONTROLLER_SCOPE } from './instance.ts'
import { createControllerWorker, type ControllerWorker } from './worker.ts'
import { ownedPool, observedPool, workerPolicy, gate, until } from './worker-fixtures.mts'

// Root prepares an owned schema-only DB first. This file never migrates/resets dev or duplicates the old HA suite.
if (process.env.ORCA_CONTROLLER_WORKER_APPROVED !== 'root-ready' ||
    !/^orca_p114_worker_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? '')) {
  throw new Error('Root worker source review and first owned PG execution assignment required')
}

await test('two actual workers elect ACTIVE/STANDBY; normal release permits higher-term pass authority and fresh local ownership', async () => {
  const a = ownedPool(), b = ownedPool(), observer = ownedPool()
  const owners: ControllerWorker[] = []
  try {
    const f = await fixture(observer, 1)
    await requestUnitIntent(observer, await intent(observer, f))
    let executionsA = 0, executionsB = 0, lookupsB = 0, firstClaimTerm = ''
    const planStep: NonNullable<ControllerPassRequest['planStep']> = (_operation, unit) => unit.id === f.unit
      ? { mutationKey: randomUUID(), step: 'ENSURE_ATTEMPT', executorId: executor, input: { workerFixtureOnly: true } } : null
    const first = createControllerWorker(a, workerPolicy(), { planStep,
      executeCommitted: async claim => { executionsA++; firstClaimTerm = claim.controllerTerm } })
    const standby = createControllerWorker(b, workerPolicy(), { planStep,
      executeCommitted: async () => { executionsB++ }, lookupOriginal: async () => { lookupsB++ } })
    const duplicate = createControllerWorker(a, workerPolicy())
    owners.push(first, standby, duplicate)
    assert.equal(first.start(), true)
    await until(() => executionsA === 1)
    const old = first.snapshot().confirmedLease; assert.ok(old); assert.equal(firstClaimTerm, old.term)
    assert.equal(duplicate.start(), false)
    assert.equal(standby.start(), true)
    await until(() => standby.snapshot().phase === 'STANDBY')
    assert.equal(standby.snapshot().lastPass, null); assert.equal(executionsB, 0); assert.equal(lookupsB, 0)
    assert.equal((await first.stop())?.status, 'RELEASED')
    await until(() => standby.snapshot().phase === 'ACTIVE' && lookupsB > 0)
    const next = standby.snapshot().confirmedLease; assert.ok(next)
    assert.notEqual(next.owner, old.owner); assert.equal(BigInt(next.term), BigInt(old.term) + 1n)
    const stored = (await observer.query('SELECT controller_term FROM durable_runtime.operations WHERE runtime_unit_id=$1 AND result IS NULL', [f.unit])).rows
    assert.equal(stored[0].controller_term, next.term, 'Actual pass gateway adoption must use the successor identity')
    assert.equal(executionsB, 0, 'An original pending command is looked up, never executed again')
    assert.equal((await standby.stop())?.status, 'RELEASED')
    const restarted = createControllerWorker(a, workerPolicy())
    try {
      assert.equal(restarted.start(), true); await until(() => restarted.snapshot().phase === 'ACTIVE')
      assert.notEqual(restarted.snapshot().confirmedLease?.owner, old.owner)
    } finally { await restarted.stop() }
    assert.equal((await a.query('SELECT 1 AS n')).rows[0].n, 1)
  } finally {
    await Promise.allSettled(owners.map(owner => owner.stop()))
    await Promise.all([a.end(), b.end(), observer.end()])
  }
  // Callback invocation is not physical provider execution, storage fencing or deployed HA evidence.
})

await test('long pass renews independently; stop drains a late callback and confirmed renewal before exact release', async () => {
  const actual = ownedPool(), list = gate(), renewal = gate(), renewalClients = new WeakSet<PoolClient>()
  let renewals = 0, heldRenewal = false, lists = 0, watches = 0, replacements = 0, simultaneous = 0, maximum = 0
  const pool = observedPool(actual, async (sql, values, client, execute) => {
    if (sql.includes('SET revision=revision+1') && Number(values[4]) > 0) { renewalClients.add(client) }
    const result = await execute()
    if (sql === 'COMMIT' && renewalClients.delete(client)) {
      renewals++
      if (renewals === 2) { heldRenewal = true; renewal.signal(); await renewal.wait }
    }
    return result
  })
  let observedSignal: AbortSignal | undefined
  const transport = {
    receiver: 'original',
    async list(signal: AbortSignal) {
      assert.equal(this.receiver, 'original'); observedSignal = signal
      lists++; simultaneous++; maximum = Math.max(maximum, simultaneous); list.signal()
      try { await list.wait; return { resourceVersion: '1', objects: [] } } finally { simultaneous-- }
    },
    async watch() { watches++; return { status: 'EVENTS' as const, resourceVersion: '2', events: [] } },
    async get() { return null }
  }
  const mutablePolicy = { ...workerPolicy(), lease: { ...workerPolicy().lease } }
  const callbacks = { inventory: { transport, sink: async () => {} } }
  const worker = createControllerWorker(pool, mutablePolicy, callbacks), duplicate = createControllerWorker(pool, workerPolicy())
  try {
    mutablePolicy.lease.durationMs = 1; mutablePolicy.renewIntervalMs = 0
    transport.list = async () => { replacements++; return { resourceVersion: 'changed', objects: [] } }
    assert.equal(worker.start(), true); await list.entered
    await renewal.entered
    assert.ok(worker.snapshot().lastRenew?.status === 'ACTIVE'); assert.ok(heldRenewal)
    const confirmed = worker.snapshot().confirmedLease; assert.ok(confirmed)
    const stop1 = worker.stop(), stop2 = worker.stop(); assert.equal(stop1, stop2)
    let stopped = false; void stop1.then(() => { stopped = true })
    await until(() => worker.snapshot().lastPass?.status === 'STOPPED')
    assert.equal(observedSignal?.aborted, true); assert.equal(stopped, false)
    assert.equal(worker.snapshot().inFlight.callbacks, 1); assert.equal(duplicate.start(), false)
    list.release(); await delay(20); assert.equal(stopped, false, 'A real renewal COMMIT reply is still pending')
    renewal.release(); const released = await stop1
    assert.equal(released?.status, 'RELEASED')
    assert.ok(BigInt(worker.snapshot().confirmedLease!.revision) > BigInt(confirmed.revision))
    assert.equal(worker.snapshot().lastRenew?.status, 'ACTIVE')
    await delay(150)
    assert.deepEqual({ lists, watches, replacements, maximum }, { lists: 1, watches: 0, replacements: 0, maximum: 1 })
    assert.equal(worker.snapshot().inFlight.callbacks, 0)
    assert.equal((await actual.query('SELECT 1 AS n')).rows[0].n, 1)
  } finally {
    list.release(); renewal.release(); await Promise.allSettled([worker.stop(), duplicate.stop()]); await actual.end()
  }
})

await test('actual renewal COMMIT reply loss stops scheduling; late callback cannot convert uncertain authority into release success', async () => {
  const actual = ownedPool(), list = gate(), renewalClients = new WeakSet<PoolClient>()
  let renewalAttempts = 0, lists = 0, watches = 0
  const pool = observedPool(actual, async (sql, values, client, execute) => {
    if (sql.includes('SET revision=revision+1') && Number(values[4]) > 0) { renewalClients.add(client) }
    const result = await execute()
    if (sql === 'COMMIT' && renewalClients.delete(client)) {
      renewalAttempts++
      throw Object.assign(new Error('owned fixture loses the real renewal COMMIT reply'), { code: 'ECONNRESET' })
    }
    return result
  })
  const worker = createControllerWorker(pool, { ...workerPolicy(), lease: { revision: 'worker-loss-fixture', durationMs: 1500 } },
    { inventory: { transport: { list: async () => { lists++; list.signal(); await list.wait; return { resourceVersion: '1', objects: [] } },
      watch: async () => { watches++; return { status: 'EVENTS', resourceVersion: '2', events: [] } }, get: async () => null }, sink: async () => {} } })
  try {
    assert.equal(worker.start(), true); await list.entered
    await until(() => worker.snapshot().lastRenew?.status === 'UNCERTAIN')
    assert.equal(worker.snapshot().phase, 'STOPPED'); assert.equal(worker.snapshot().stoppedBy?.stage, 'RENEW')
    const confirmed = worker.snapshot().confirmedLease; assert.ok(confirmed)
    let stopped = false; const stopping = worker.stop(); void stopping.then(() => { stopped = true })
    await delay(30); assert.equal(stopped, false); assert.equal(worker.snapshot().inFlight.callbacks, 1)
    list.release(); const released = await stopping
    assert.equal(released?.status, 'LOST')
    if (released?.status === 'LOST') { assert.equal(released.reason, 'REVISION_CHANGED') }
    assert.equal(worker.snapshot().lastRenew?.status, 'UNCERTAIN')
    await delay(150); assert.deepEqual({ renewalAttempts, lists, watches }, { renewalAttempts: 1, lists: 1, watches: 0 })
    assert.equal(worker.start(), false)
    const next = createControllerWorker(pool, workerPolicy())
    try {
      assert.equal(next.start(), true); await until(() => next.snapshot().phase === 'ACTIVE')
      assert.notEqual(next.snapshot().confirmedLease?.owner, confirmed.owner)
      assert.ok(BigInt(next.snapshot().confirmedLease!.term) > BigInt(confirmed.term))
      assert.equal(worker.snapshot().phase, 'STOPPED')
    } finally { await next.stop() }
    assert.equal((await actual.query('SELECT 1 AS n')).rows[0].n, 1)
  } finally {
    list.release()
    try { await worker.stop() } finally { await actual.end() }
  }
})

await test('stop drains a late successful acquisition and releases exactly that process lease without starting a pass', async () => {
  const actual = ownedPool(), commit = gate(), acquireClients = new WeakSet<PoolClient>()
  let delayed = false, effects = 0
  const pool = observedPool(actual, async (sql, _values, client, execute) => {
    if (sql.includes('INSERT INTO durable_runtime.controller_leases(')) { acquireClients.add(client) }
    const result = await execute()
    if (sql === 'COMMIT' && acquireClients.delete(client) && !delayed) { delayed = true; commit.signal(); await commit.wait }
    return result
  })
  const worker = createControllerWorker(pool, workerPolicy(), { planStep: () => { effects++; return null } })
  try {
    assert.equal(worker.start(), true); await commit.entered
    const stored = (await actual.query('SELECT owner,term,revision FROM durable_runtime.controller_leases WHERE scope=$1', [CONTROLLER_SCOPE])).rows[0]
    assert.equal(worker.snapshot().confirmedLease, null)
    const first = worker.stop(), second = worker.stop(); assert.equal(first, second)
    let stopped = false; void first.then(() => { stopped = true }); await delay(20); assert.equal(stopped, false)
    commit.release(); assert.equal((await first)?.status, 'RELEASED')
    const confirmed = worker.snapshot().confirmedLease; assert.ok(confirmed)
    assert.deepEqual({ owner: confirmed.owner, term: confirmed.term, revision: confirmed.revision }, stored)
    assert.equal(worker.snapshot().lastPass, null); assert.equal(effects, 0)
    const released = (await actual.query('SELECT expires_at<=clock_timestamp() AS expired FROM durable_runtime.controller_leases WHERE scope=$1', [CONTROLLER_SCOPE])).rows[0]
    assert.equal(released.expired, true); assert.equal((await actual.query('SELECT 1 AS n')).rows[0].n, 1)
  } finally {
    commit.release()
    try { await worker.stop() } finally { await actual.end() }
  }
})
