import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { writeFile } from 'node:fs/promises'
import { DurableDatabaseError } from '../db/connection.ts'
import { createOpsReplayPublicationWorker } from './worker.ts'
import { opsReplayErrorCode } from './claim.ts'
import { notificationRow, workerConfig } from './publication-worker-fixture.mts'
import { controlPool, controlGate } from './publication-worker-control-support.mts'

const cases: { name: string; entered: boolean; passed: boolean; code?: string }[] = []
after(async () => {
  if (process.env.P125_PUBLICATION_LIFECYCLE_EVIDENCE) {
    await writeFile(process.env.P125_PUBLICATION_LIFECYCLE_EVIDENCE, `${JSON.stringify({
      scope: 'SIMULATED_SQL_LIFECYCLE_CONTROL_ONLY', cases,
      sourceRevision: process.env.P125_PUBLICATION_SOURCE_REVISION,
      actualPgVerified: false, authorityVerified: false, serverStartupConnected: false
    }, null, 2)}\n`, { mode: 0o600 })
  }
})
function check(name: string, body: () => Promise<void>): void {
  test(name, { timeout: 3000 }, async () => {
    const item: { name: string; entered: boolean; passed: boolean; code?: string } = { name, entered: true, passed: false }
    cases.push(item)
    try { await body(); item.passed = true }
    catch (error) { item.code = opsReplayErrorCode(error); throw error }
  })
}
check('config captured synchronously; manual pass and same-owner start cannot overlap', async () => {
  const gate = controlGate()
  const borrowed = controlPool([], undefined, gate)
  const config = { ...workerConfig('publication-control-snapshot'), batchSize: 7, claimLeaseMs: 12345 }
  const worker = createOpsReplayPublicationWorker(borrowed.pool, config)
  const sameOwner = createOpsReplayPublicationWorker(borrowed.pool, config)
  const first = worker.runPass()
  try {
    await gate.entered
    config.owner = 'mutated'; config.batchSize = 99; config.claimLeaseMs = 99999
    config.streamId = 'caller-mutated-stream'; config.pollIntervalMs = 1
    assert.equal((await worker.runPass()).status, 'BUSY'); assert.equal(worker.start(), false)
    assert.equal((await sameOwner.runPass()).status, 'BUSY'); assert.equal(sameOwner.start(), false)
    gate.release()
    assert.equal((await first).status, 'COMPLETED')
    assert.equal(borrowed.stats.claims[0][0], 7)
    assert.equal(borrowed.stats.claims[0][1], 'publication-control-snapshot')
    assert.match(String(borrowed.stats.claims[0][2]), /^[0-9a-f-]{36}$/)
    assert.equal(borrowed.stats.claims[0][3], 12345)
    assert.equal(borrowed.stats.connects, 1)
    for (const batchSize of [0, 101, 1.1]) {
      assert.throws(() => createOpsReplayPublicationWorker(borrowed.pool, { ...workerConfig('invalid'), batchSize }),
        error => error instanceof DurableDatabaseError && error.code === 'REPLAY_WORKER_CONFIG')
    }
    assert.throws(() => createOpsReplayPublicationWorker(borrowed.pool, { ...workerConfig('invalid'), streamId: 'invalid' }),
      error => error instanceof DurableDatabaseError && error.code === 'REPLAY_STREAM')
  } finally { gate.release(); await first; await worker.stop(); await sameOwner.stop() }
  assert.equal(borrowed.stats.endCalls, 0)
})
check('stop during acquisition drains returned claims without any publication and never ends borrowed Pool', async () => {
  const gate = controlGate()
  const borrowed = controlPool([notificationRow()], undefined, gate)
  const worker = createOpsReplayPublicationWorker(borrowed.pool, workerConfig('publication-control-acquire-stop'))
  const pass = worker.runPass()
  try {
    await gate.entered
    let drained = false
    const stopping = worker.stop().then(value => { drained = true; return value })
    await Promise.resolve(); assert.equal(drained, false)
    gate.release()
    const result = await pass
    assert.equal(result.status, 'STOPPED'); assert.equal(result.claimed.length, 1)
    assert.equal(result.deferred.length, 1); assert.equal(result.published.length, 0)
    assert.deepEqual(await stopping, result)
    assert.equal(borrowed.stats.publicationStarts, 0)
    assert.equal(borrowed.stats.endCalls, 0)
    assert.equal(worker.start(), false); assert.equal((await worker.runPass()).status, 'STOPPED')
  } finally { gate.release(); await pass; await worker.stop() }
})
check('stop retains an already-started publication result and defers remaining claims until natural expiry', async () => {
  const gate = controlGate()
  let firstPublication = true
  const borrowed = controlPool([notificationRow(), notificationRow()], async (sql, _values, execute) => {
    const reply = execute()
    if (firstPublication && sql.includes('FROM durable_runtime.outbox_events WHERE id=$1 FOR UPDATE')) {
      firstPublication = false; gate.signal(); await gate.wait
    }
    return reply
  })
  const worker = createOpsReplayPublicationWorker(borrowed.pool, workerConfig('publication-control-publication-stop'))
  const pass = worker.runPass()
  try {
    await gate.entered
    const stopping = worker.stop()
    gate.release()
    const result = await pass
    assert.equal(result.status, 'STOPPED')
    assert.equal(result.published.length, 1); assert.equal(result.deferred.length, 1)
    assert.equal(borrowed.stats.publicationStarts, 1); assert.equal(borrowed.stats.commits, 2)
    assert.deepEqual(await stopping, result)
    assert.equal(borrowed.stats.endCalls, 0)
  } finally { gate.release(); await pass; await worker.stop() }
})
check('failed poll finishes before a single bounded next timer; failure survives later empty success', async () => {
  const second = controlGate()
  let claims = 0, failedAt = 0, nextAt = 0
  const borrowed = controlPool([], async (sql, _values, execute) => {
    if (sql.includes('WITH candidates AS')) {
      claims++
      if (claims === 1) { failedAt = performance.now(); throw new DurableDatabaseError('FIXTURE_CLAIM_FAILURE') }
      nextAt = performance.now(); second.signal(); await second.wait
    }
    return execute()
  })
  const worker = createOpsReplayPublicationWorker(borrowed.pool, workerConfig('publication-control-poll'))
  try {
    assert.equal(worker.start(), true); assert.equal(worker.start(), false)
    assert.equal((await worker.runPass()).status, 'BUSY')
    await second.entered
    assert.equal(claims, 2); assert.ok(nextAt - failedAt >= 20)
    assert.equal(worker.lastFailure?.status, 'CLAIM_FAILED')
    assert.equal(worker.lastFailure?.claimFailure?.code, 'FIXTURE_CLAIM_FAILURE')
    const stopping = worker.stop(); second.release()
    await stopping
    assert.equal(worker.lastResult?.status, 'COMPLETED')
    assert.equal(worker.lastFailure?.claimFailure?.code, 'FIXTURE_CLAIM_FAILURE')
    assert.equal(borrowed.stats.maximumActive, 1); assert.equal(borrowed.stats.active, 0)
    assert.equal(borrowed.stats.endCalls, 0)
  } finally { second.release(); await worker.stop() }
})
