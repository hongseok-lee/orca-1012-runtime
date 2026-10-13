import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool, QueryResult } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { createDurablePool, DurableDatabaseError } from '../db/connection.ts'
import { applyMigrations, readMigrations } from '../db/migrate.ts'
import type { VerifiedControllerIdentity } from '../runtime/gateway/types.ts'
import type { VerifiedWorkloadIdentity } from '../runtime/runtime-evidence.ts'
import { enqueueRuntimeEvent, registerEventProducer, claimRuntimeEvent, processRuntimeEvent } from '../events/store.ts'
import { fixture, intent, stoppedMetadataAttempt, executor } from '../lifecycle/verification-fixtures.mts'
import { requestUnitIntent } from '../lifecycle/intent.ts'
import { prepareReconcileStep } from '../lifecycle/controller.ts'
import { CONTROLLER_SCOPE, ControllerInstance } from './instance.ts'
import { tryAcquireControllerLease, renewControllerLease, releaseControllerLease } from './lease.ts'
import { ControllerLeaseSession } from './session.ts'
import { readControllerTakeoverSnapshot } from './takeover.ts'
import { runControllerPass } from './pass.ts'

// Hard failure rather than skip/PASS without a real owned verification DB.
assert.match(process.env.PGDATABASE ?? '', /^orca_p114_[a-z0-9_]+$/)
assert.ok(process.env.P114_MIGRATIONS)
const pool = createDurablePool({ max: 8, application_name: 'orca-p114-core-fixtures',
  connectionTimeoutMillis: 5000, statement_timeout: 15000 })
const policy = Object.freeze({ revision: 'p114-fixture-v1', durationMs: 60000 })
const cases: { name: string; passed: boolean }[] = []
let migrations: { version: string; checksum: string }[] = []
before(async () => {
  const source = await readMigrations(process.env.P114_MIGRATIONS!)
  assert.equal(source.length, 12, 'exact main schema 001 through 012 required')
  migrations = (await applyMigrations(pool, source)).map(({ version, checksum }) => ({ version, checksum }))
  await pool.query('CREATE TABLE public.p114_effects(event_id uuid PRIMARY KEY)')
})
beforeEach(async () => {
  // Fixture-only clock setup between serial cases, never product/fault work.
  // Keep the row, bigint term/revision and immutable journal history.
  await pool.query(`UPDATE durable_runtime.controller_leases SET expires_at=clock_timestamp()-interval '1 second',
    revision=revision+1 WHERE scope=$1`, [CONTROLLER_SCOPE])
})
after(async () => {
  try {
    if (process.env.P114_EVIDENCE) await writeFile(process.env.P114_EVIDENCE, JSON.stringify({
      recordedAt: new Date().toISOString(), scope: 'ACTUAL_PG_CONTROLLER_LEASE_AND_ORIGINAL_MODULE_FIXTURES',
      sourceRevision: process.env.P114_SOURCE_REVISION, mainRevision: '8edb42e16caf0ddaa840dc16e4e886e6acaca328',
      lifecycleRevision: '4c516670a0fb8fc7204150a12863e15d758886d7', migrations, cases,
      commitLossMode: 'driver hook rejects after the actual COMMIT reply',
      authenticationVerified: false, physicalFencingVerified: false, providerVerified: false,
      deployedHA: false, publicRpcIntegrated: false, nativeIphoneVerified: false
    }, null, 2), { mode: 0o600 })
  } finally { await pool.end() }
})
function check(name: string, body: () => Promise<void>): void {
  test(name, { concurrency: false }, async () => { await body(); cases.push({ name, passed: true }) })
}
async function active() {
  const instance = new ControllerInstance(CONTROLLER_SCOPE)
  const session = new ControllerLeaseSession(pool, instance, policy)
  const acquired = await session.acquire()
  assert.equal(acquired.status, 'ACTIVE')
  assert.ok(session.lease)
  return { instance, session, lease: session.lease }
}
// Assertions of verified types are fixture-only, never authentication proof.
function controller(session: ControllerLeaseSession): VerifiedControllerIdentity {
  const lease = session.lease
  assert.ok(lease)
  return { scope: lease.scope, owner: lease.owner, term: lease.term } as VerifiedControllerIdentity
}
function queryHook(base: Pool, hook: (sql: string, actual: () => Promise<QueryResult>) => Promise<QueryResult>): Pool {
  return { query: base.query.bind(base), async connect() {
    const client = await base.connect()
    return { query: (sql: string, values?: unknown[]) => hook(sql, () => client.query(sql, values)),
      release: client.release.bind(client) }
  } } as unknown as Pool
}

check('simultaneous process owners elect exactly one winner; live duplicate does not change term or journal', async () => {
  const a = new ControllerInstance(CONTROLLER_SCOPE), b = new ControllerInstance(CONTROLLER_SCOPE)
  assert.notEqual(a.owner, b.owner)
  const results = await Promise.all([tryAcquireControllerLease(pool, a, policy), tryAcquireControllerLease(pool, b, policy)])
  assert.equal(results.filter(r => r.status === 'ACTIVE').length, 1)
  assert.equal(results.filter(r => r.status === 'STANDBY').length, 1)
  const index = results.findIndex(r => r.status === 'ACTIVE')
  const result = results[index]
  assert.equal(result.status, 'ACTIVE')
  if (result.status !== 'ACTIVE') throw new Error('Winner missing')
  const before = await pool.query('SELECT count(*)::text AS n FROM durable_runtime.runtime_audit_events')
  const duplicate = await tryAcquireControllerLease(pool, [a, b][index], policy)
  assert.deepEqual(duplicate, { ...result, transition: 'ALREADY_OWNED' })
  assert.deepEqual((await pool.query('SELECT count(*)::text AS n FROM durable_runtime.runtime_audit_events')).rows, before.rows)
})

check('post-lock DB clock admits expired takeover with term plus one; application clock skew does not decide expiry', async () => {
  const a = new ControllerInstance(CONTROLLER_SCOPE), b = new ControllerInstance(CONTROLLER_SCOPE)
  const first = await tryAcquireControllerLease(pool, a, { ...policy, durationMs: 400 })
  assert.equal(first.status, 'ACTIVE')
  if (first.status !== 'ACTIVE') throw new Error('Active missing')
  const lock = await pool.connect()
  await lock.query('BEGIN')
  await lock.query('SELECT scope FROM durable_runtime.controller_leases WHERE scope=$1 FOR UPDATE', [CONTROLLER_SCOPE])
  let replied = false
  const competing = tryAcquireControllerLease(pool, b, policy).then(r => { replied = true; return r })
  try {
    await delay(700)
    assert.equal(replied, false)
    await lock.query('COMMIT')
  } finally { lock.release() }
  const next = await competing
  assert.equal(next.status, 'ACTIVE')
  if (next.status !== 'ACTIVE') throw new Error('Takeover missing')
  assert.equal(BigInt(next.lease.term), BigInt(first.lease.term) + 1n)
  const now = Date.now
  Date.now = () => 1
  try {
    const renewed = await renewControllerLease(pool, b, next.lease, policy)
    assert.equal(renewed.status, 'ACTIVE')
    const clock = (await pool.query(`SELECT expires_at>clock_timestamp() AS live,
      extract(epoch FROM expires_at-clock_timestamp())::float8 AS remaining
      FROM durable_runtime.controller_leases WHERE scope=$1`, [CONTROLLER_SCOPE])).rows[0]
    assert.equal(clock.live, true)
    assert.ok(clock.remaining > 0 && clock.remaining <= 60)
  } finally { Date.now = now }
})

check('stale revision, expired renewal and late old-owner release cannot alter the successor lease', async () => {
  const a = await active()
  const renewed = await renewControllerLease(pool, a.instance, a.lease, policy)
  assert.equal(renewed.status, 'ACTIVE')
  assert.deepEqual(await renewControllerLease(pool, a.instance, a.lease, policy), { status: 'LOST', reason: 'REVISION_CHANGED' })
  if (renewed.status !== 'ACTIVE') throw new Error('Renewal missing')
  await releaseControllerLease(pool, a.instance, renewed.lease)
  assert.deepEqual(await renewControllerLease(pool, a.instance, {
    ...renewed.lease, revision: counter('row:controller', BigInt(renewed.lease.revision) + 1n)
  }, policy), { status: 'LOST', reason: 'EXPIRED' })
  const b = await active()
  const before = (await pool.query('SELECT * FROM durable_runtime.controller_leases WHERE scope=$1', [CONTROLLER_SCOPE])).rows
  assert.deepEqual(await releaseControllerLease(pool, a.instance, renewed.lease), { status: 'LOST', reason: 'OWNER_CHANGED' })
  assert.deepEqual((await pool.query('SELECT * FROM durable_runtime.controller_leases WHERE scope=$1', [CONTROLLER_SCOPE])).rows, before)
  assert.ok(BigInt(b.lease.term) > BigInt(a.lease.term))
})

check('actual acquisition COMMIT followed by driver response loss leaves scheduling and watch execution at zero', async () => {
  let dropped = false
  const loss = queryHook(pool, async (sql, actual) => {
    const result = await actual()
    if (sql === 'COMMIT' && !dropped) { dropped = true; throw Object.assign(new Error('fixture response loss'), { code: 'ECONNRESET' }) }
    return result
  })
  const instance = new ControllerInstance(CONTROLLER_SCOPE)
  const session = new ControllerLeaseSession(loss, instance, policy)
  const result = await session.acquire()
  assert.equal(result.status, 'UNCERTAIN')
  assert.equal(session.lease, null)
  const row = (await pool.query('SELECT owner,term FROM durable_runtime.controller_leases WHERE scope=$1', [CONTROLLER_SCOPE])).rows[0]
  assert.equal(row.owner, instance.owner) // Readback is not scheduling permission.
  let effects = 0
  const pass = await runControllerPass(pool, session, { maximumWork: 1, externalBudgetMs: 100,
    controller: { scope: CONTROLLER_SCOPE, owner: instance.owner, term: counter('controller-term', row.term) } as VerifiedControllerIdentity,
    inventory: { transport: { list: async () => { effects++; return { resourceVersion: '1', objects: [] } },
      watch: async () => { effects++; return { status: 'EVENTS', resourceVersion: '1', events: [] } }, get: async () => null },
      sink: async () => { effects++ } } })
  assert.equal(pass.status, 'STOPPED'); assert.equal(effects, 0)
})

check('DB renewal failure revokes local scheduling; a concurrent stop cannot be undone by a late successful reply', async () => {
  let unavailable = false, wait: (() => void) | undefined, resume: (() => void) | undefined
  const suspended = new Promise<void>(resolve => { resume = resolve })
  const waiting = new Promise<void>(resolve => { wait = resolve })
  let holdCommit = false
  const hooked = queryHook(pool, async (sql, actual) => {
    if (unavailable) throw new DurableDatabaseError('FIXTURE_DB_UNAVAILABLE')
    const result = await actual()
    if (sql === 'COMMIT' && holdCommit) { wait!(); await suspended }
    return result
  })
  const session = new ControllerLeaseSession(hooked, new ControllerInstance(CONTROLLER_SCOPE), policy)
  assert.equal((await session.acquire()).status, 'ACTIVE')
  holdCommit = true
  const renewal = session.renew()
  await waiting
  session.stop()
  resume!()
  await renewal
  assert.equal(session.lease, null)
  holdCommit = false
  assert.equal((await session.acquire()).status, 'ACTIVE')
  unavailable = true
  assert.equal((await session.renew()).status, 'UNAVAILABLE')
  assert.equal(session.lease, null)
  const pass = await runControllerPass(pool, session, { controller: {
    scope: CONTROLLER_SCOPE, owner: session.instance.owner, term: counter('controller-term', '0')
  } as VerifiedControllerIdentity, maximumWork: 1, externalBudgetMs: 1 })
  assert.equal(pass.status, 'STOPPED'); assert.deepEqual(pass.items, [])
})

check('real lease takeover preserves original operation, executing command, queue third attempt and PG deadlines', async () => {
  const first = await active(), f = await fixture(pool)
  await requestUnitIntent(pool, await intent(pool, f))
  const op = (await pool.query('SELECT * FROM durable_runtime.operations WHERE runtime_unit_id=$1', [f.unit])).rows[0]
  const unit = (await pool.query('SELECT * FROM durable_runtime.runtime_units WHERE id=$1', [f.unit])).rows[0]
  const prepared = await prepareReconcileStep(pool, { context: { controller: controller(first.session),
    operationId: logicalId('operation', op.id), runtimeUnitId: f.unit }, mutationKey: randomUUID(), executorId: executor,
    expectedUnitRevision: counter('row:runtime-unit', unit.revision), expectedIntentRevision: counter('intent-revision', unit.intent_revision),
    expectedStepRevision: counter('step-revision', op.step_revision), step: 'ENSURE_ATTEMPT', input: { fixture: true } })
  assert.equal(prepared.execution.disposition, 'COMMITTED_EXECUTE')
  // Historical producer metadata is fixture-only and never physical proof.
  const attempt = await stoppedMetadataAttempt(pool, f, false)
  const agent = (await pool.query('SELECT agent_id FROM durable_runtime.sessions WHERE id=$1', [f.sessions[0]])).rows[0].agent_id
  const producerId = logicalId('producer', randomUUID())
  const workload = { attemptId: attempt.attempt, producerId, incarnation: 'fixture', podUid: attempt.podUid,
    executionEpoch: counter('execution-epoch', '0'), principalRef: 'fixture-only', authenticationEvidenceRef: 'fixture-only' } as VerifiedWorkloadIdentity
  const producer = { workload, agentId: logicalId('agent', agent), runtimeUnitId: f.unit }
  const stream = { producerId, incarnation: workload.incarnation }
  await registerEventProducer(pool, producer)
  const eventId = logicalId('event', randomUUID())
  await enqueueRuntimeEvent(pool, producer, { eventId, sequence: counter('sequence:producer', '1'), payload: { fixture: true }, targetSessionIds: f.sessions })
  for (let n = 1; n <= 3; n++) {
    const claim = await claimRuntimeEvent(pool, stream, controller(first.session), { claimDurationMs: 60000 })
    assert.equal(claim.status, 'CLAIMED')
    if (claim.status !== 'CLAIMED') throw new Error('Claim missing')
    assert.equal(claim.claim.attemptCount, n)
    if (n < 3) {
      assert.equal((await processRuntimeEvent(pool, claim.claim, async () => { throw new DurableDatabaseError('FIXTURE_RETRY') })).status, 'RETRY')
      const ms = (await pool.query(`SELECT greatest(0,extract(epoch FROM next_retry_at-clock_timestamp())*1000)::float8 AS ms
        FROM durable_runtime.runtime_event_queue WHERE event_id=$1`, [eventId])).rows[0].ms
      await delay(Math.ceil(ms) + 20)
    }
  }
  const before = await readControllerTakeoverSnapshot(pool, first.session.lease!)
  await first.session.release()
  const next = await active()
  const after = await readControllerTakeoverSnapshot(pool, next.lease)
  assert.deepEqual(after.operations, before.operations)
  assert.deepEqual(after.units, before.units)
  assert.deepEqual(after.commands, before.commands)
  assert.deepEqual(after.queueHeads, before.queueHeads)
  assert.deepEqual(after.producers, before.producers)
  let executions = 0, lookups = 0
  const pass = await runControllerPass(pool, next.session, { controller: controller(next.session), maximumWork: 100, externalBudgetMs: 10000,
    planStep: () => ({ mutationKey: randomUUID(), step: 'ENSURE_ATTEMPT', executorId: executor, input: { fixture: true } }),
    executeCommitted: async () => { executions++ }, lookupOriginal: async command => {
      assert.equal(command.id, before.commands[0].id); assert.equal(command.execution_token, before.commands[0].execution_token); lookups++
    } })
  assert.equal(pass.status, 'FINISHED'); assert.equal(executions, 0); assert.equal(lookups, 1)
  const unchanged = (await readControllerTakeoverSnapshot(pool, next.session.lease!)).queueHeads
  assert.deepEqual(unchanged, after.queueHeads) // No handler: no claim or DONE.
  const claim = await claimRuntimeEvent(pool, stream, controller(next.session), { claimDurationMs: 60000 })
  assert.equal(claim.status, 'CLAIMED')
  if (claim.status !== 'CLAIMED') throw new Error('Takeover claim missing')
  assert.equal(claim.claim.attemptCount, 4)
  const done = await processRuntimeEvent(pool, claim.claim, async (tx, event) => {
    await tx.query('INSERT INTO public.p114_effects(event_id) VALUES($1)', [event.eventId])
  })
  assert.equal(done.status, 'DONE')
  assert.equal((await pool.query('SELECT count(*)::text AS n FROM public.p114_effects WHERE event_id=$1', [eventId])).rows[0].n, '1')
  const preserved = (await pool.query('SELECT id,external_resource_name,deadline_at,retry_at FROM durable_runtime.operations WHERE id=$1', [op.id])).rows[0]
  assert.deepEqual(preserved, { id: op.id, external_resource_name: op.external_resource_name, deadline_at: op.deadline_at, retry_at: op.retry_at })
})

check('a hung external inventory is cancelled within caller budget without blocking an independent DB renewal', async () => {
  const current = await active()
  let invoked: (() => void) | undefined
  const started = new Promise<void>(resolve => { invoked = resolve })
  let cancelled = false
  const pass = runControllerPass(pool, current.session, { controller: controller(current.session), maximumWork: 100, externalBudgetMs: 2000,
    inventory: { transport: { list: async signal => {
      invoked!(); signal.addEventListener('abort', () => { cancelled = true }, { once: true })
      return new Promise(() => {})
    }, watch: async () => ({ status: 'EVENTS', resourceVersion: '1', events: [] }), get: async () => null }, sink: async () => {} } })
  await Promise.race([started, pass.then(() => { throw new Error('Inventory was never invoked') })])
  assert.equal((await current.session.renew()).status, 'ACTIVE')
  const stopped = await pass
  assert.equal(stopped.status, 'STOPPED'); assert.equal(cancelled, true)
  assert.equal(current.session.lease, null)
})
