import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDurablePool, DurableDatabaseError } from '../db/connection.ts'
import { createControllerWorker } from './worker.ts'
import { workerPolicy } from './worker-fixtures.mts'

if (process.env.ORCA_CONTROLLER_WORKER_APPROVED !== 'root-ready') { throw new Error('Root first worker execution assignment required') }

await test('worker policy and callback surface cannot accept identity input; an unstarted owner performs no PG work', async () => {
  const pool = createDurablePool({ max: 1 })
  let connects = 0
  Object.defineProperty(pool, 'connect', { value: () => { connects++; throw new Error('unexpected fixture PG access') } })
  try {
    const policy = workerPolicy()
    assert.throws(() => createControllerWorker(pool, { ...policy, renewIntervalMs: policy.lease.durationMs }),
      error => error instanceof DurableDatabaseError && error.code === 'CONTROLLER_WORKER_POLICY')
    const injected = { planStep: () => null, controller: { owner: 'unverified-fixture-input' } }
    assert.throws(() => createControllerWorker(pool, policy, injected),
      error => error instanceof DurableDatabaseError && error.code === 'CONTROLLER_WORKER_CALLBACKS')
    const worker = createControllerWorker(pool, { ...policy, standbyPollIntervalMs: Number.MAX_SAFE_INTEGER,
      passPollIntervalMs: Number.MAX_SAFE_INTEGER })
    assert.equal(worker.snapshot().phase, 'NEW')
    const first = worker.stop(), second = worker.stop()
    assert.equal(first, second); assert.equal(await first, null)
    assert.equal(worker.start(), false); assert.equal(worker.snapshot().phase, 'STOPPED')
    assert.equal(worker.snapshot().confirmedLease, null); assert.equal(connects, 0)
  } finally { await pool.end() }
})
