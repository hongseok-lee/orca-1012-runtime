import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDurablePool, DurableDatabaseError } from '../db/connection.ts'
import { counter } from '../../../shared/durable-runtime/identity.ts'
import { controller as fixtureController } from '../lifecycle/verification-fixtures.mts'
import { ControllerInstance, CONTROLLER_SCOPE, type LeaseRecord } from './instance.ts'
import { ControllerLeaseSession } from './session.ts'
import { runControllerPass } from './pass.ts'
import type { ControllerTakeoverSnapshot } from './takeover.ts'

await test('one failing hook is that item\'s result; the pass goes on and the lease session is not stopped', async () => {
  // Scheduling-only synthetic fixture, as in input-owner-loss.value.test.mts.
  const pool = createDurablePool({ max: 1 })
  Object.defineProperty(pool, 'query', { value: async () => ({ rows: [], rowCount: 1 }) })
  Object.defineProperty(pool, 'connect', { value: () => { throw new Error('unexpected PG connection') } })
  try {
    const identity = await fixtureController(pool, 'synthetic-contained-owner', '2')
    const lease: LeaseRecord = { ...identity, revision: counter('row:controller', '1'), expiresAt: new Date(Date.now() + 60000).toISOString() }
    const snapshot: ControllerTakeoverSnapshot = { lease, readAt: new Date().toISOString(),
      operations: [], units: [], commands: [], producers: [], queueHeads: [] }
    class SyntheticSession extends ControllerLeaseSession {
      stops = 0
      override get lease(): LeaseRecord { return lease }
      override assertCurrent(): Promise<LeaseRecord> { return Promise.resolve(lease) }
      override readTakeoverSnapshot(): Promise<ControllerTakeoverSnapshot> { return Promise.resolve(snapshot) }
      override stop(): void { this.stops++; super.stop() }
    }
    const session = new SyntheticSession(pool, new ControllerInstance(CONTROLLER_SCOPE), { revision: 'synthetic-contained', durationMs: 60000 })
    let adopted = 0
    const result = await runControllerPass(pool, session, { controller: identity, maximumWork: 10, externalBudgetMs: 1000,
      reconcileOrphans: async () => { throw new DurableDatabaseError('ORPHAN_RECONCILE_SYNTHETIC') },
      adoptRuntimes: async () => { adopted++; return 1 } })
    assert.equal(result.status, 'FINISHED')
    assert.equal(session.stops, 0)
    assert.equal(adopted, 1)
    assert.deepEqual(result.items.map(item => item.disposition), ['FAILED_ORPHAN_RECONCILE_SYNTHETIC', 'HANDLED_1'])
    const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
    const budgeted = await runControllerPass(pool, session, { controller: identity, maximumWork: 10, externalBudgetMs: 1000,
      reconcileOrphans: async () => { await delay(700); return 1 },
      adoptRuntimes: async () => { await delay(700); return 1 } })
    assert.equal(budgeted.status, 'FINISHED')
    assert.equal(budgeted.reason, 'EXTERNAL_BUDGET')
    assert.equal(session.stops, 0)
    assert.deepEqual(budgeted.items.map(item => item.disposition), ['HANDLED_1', 'HANDLED_1'])
    const timeout = await runControllerPass(pool, session, { controller: identity, maximumWork: 10, externalBudgetMs: 20,
      reconcileOrphans: async signal => { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once:true})); return 0 } })
    assert.equal(timeout.status, 'STOPPED')
    assert.equal(timeout.reason, 'CONTROLLER_EXTERNAL_TIMEOUT')
    assert.equal(session.stops, 1)
  } finally { await pool.end() }
})
