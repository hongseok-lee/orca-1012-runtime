import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type { PoolClient } from 'pg'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { createDurablePool, DurableDatabaseError } from '../db/connection.ts'
import { readMigrations } from '../db/migrate.ts'
import type { AppliedMigration } from '../db/migrate.ts'
import type { OutboxClaim } from '../journal/publisher.ts'
import { createOpsReplayPublicationWorker, OPS_REPLAY_STREAM, publishClaimToReplay, readReplayPage } from './index.ts'
import { opsReplayErrorCode } from './claim.ts'
import { hookPool, gate } from './test-support.mts'
import { notificationRow, workerConfig } from './publication-worker-fixture.mts'

assert.match(process.env.PGDATABASE ?? '', /^orca_p125_publication_[a-z0-9_]+$/)
assert.ok(process.env.P125_PUBLICATION_MIGRATIONS)
const pool = createDurablePool({ max: 12 })
const cases: { name: string; entered: boolean; passed: boolean; code?: string }[] = []
const observations: Record<string, unknown> = {}
let ledger: AppliedMigration[] = []
before(async () => {
  const files = await readMigrations(process.env.P125_PUBLICATION_MIGRATIONS!)
  assert.equal(files.length, 19)
  ledger = (await pool.query<AppliedMigration>(
    'SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.deepEqual(ledger.map(({ version, checksum }) => ({ version, checksum })),
    files.map(({ version, checksum }) => ({ version, checksum })))
  assert.equal((await pool.query('SELECT count(*) AS n FROM durable_runtime.outbox_events')).rows[0].n, '0',
    'requires an empty, newly assigned owner DB, never dev/shared history')
})
after(async () => {
  try {
    const current = (await pool.query<AppliedMigration>(
      'SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
    assert.deepEqual(current, ledger)
    if (process.env.P125_PUBLICATION_EVIDENCE) {
      await writeFile(process.env.P125_PUBLICATION_EVIDENCE, `${JSON.stringify({
        scope: 'ACTUAL_PG_PUBLICATION_WORKER_WITH_SYNTHETIC_TRUSTED_SOURCE_METADATA',
        sourceRevision: process.env.P125_PUBLICATION_SOURCE_REVISION,
        baseRevision: process.env.P125_PUBLICATION_BASE_REVISION, recordedAt: new Date().toISOString(),
        migrations: ledger, migrationExecutionCount: 0, cases, observations,
        replyLossMode: 'driver hook discards reply after actual PG publication COMMIT',
        serverStartupConnected: false, authenticationVerified: false, providerVerified: false,
        physicalHaFencingVerified: false, previousSuccessfulSuitesRepeated: false
      }, null, 2)}\n`, { mode: 0o600 })
    }
  } finally { await pool.end() }
})
function check(name: string, body: () => Promise<void>): void {
  test(name, { timeout: 30000 }, async () => {
    const item: { name: string; entered: boolean; passed: boolean; code?: string } = { name, entered: true, passed: false }
    cases.push(item)
    try { await body(); item.passed = true }
    catch (error) { item.code = opsReplayErrorCode(error); throw error }
  })
}
async function seed(row: ReturnType<typeof notificationRow>): Promise<void> {
  await pool.query('INSERT INTO durable_runtime.outbox_events(id,aggregate_id,aggregate_kind,revision,event,created_at) VALUES($1,$2,$3,$4,$5,$6)',
    [row.id, row.aggregate_id, row.aggregate_kind, row.revision, JSON.stringify(row.event), row.created_at])
}
async function head(): Promise<string> {
  return (await pool.query('SELECT published_offset FROM durable_runtime.replay_stream_heads WHERE stream_id=$1',
    [OPS_REPLAY_STREAM])).rows[0]?.published_offset ?? '0'
}
async function page(offset: string) {
  const value = await readReplayPage(pool, { streamId: OPS_REPLAY_STREAM, epoch: '0', afterOffset: offset, limit: 100 })
  assert.equal(value.status, 'PAGE')
  if (value.status !== 'PAGE') { throw new DurableDatabaseError('FIXTURE_RESET') }
  return value
}
check('supported notification batch commits canonical cursor and PUBLISHED together; unsupported rows untouched', async () => {
  const supported = ['NOTIFICATION_OPENED', 'NOTIFICATION_OBSERVED', 'NOTIFICATION_READ', 'NOTIFICATION_RESOLVED'].map(kind => notificationRow(kind))
  const unsupported = ['CATALOG_CHANGED', 'INPUT_ACCEPTED', 'PROVIDER_STARTED', 'RUNTIME_EVENT_OUTCOME'].map(kind => notificationRow(kind))
  unsupported[3].event.outcome = 'RETRY'
  const liveSupported = notificationRow()
  for (const row of [...supported, ...unsupported, liveSupported]) { await seed(row) }
  await pool.query("UPDATE durable_runtime.outbox_events SET state='CLAIMED',claim_owner='expired-fixture-owner',claim_token=$2,claim_expires_at=clock_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])",
    [[supported[0].id, unsupported[0].id], randomUUID()])
  await pool.query("UPDATE durable_runtime.outbox_events SET state='CLAIMED',claim_owner='live-fixture-owner',claim_token=$2,claim_expires_at=clock_timestamp()+interval '10 minutes' WHERE id=$1",
    [liveSupported.id, randomUUID()])
  const ids = [...unsupported.map(row => row.id), liveSupported.id]
  const beforeRows = (await pool.query('SELECT * FROM durable_runtime.outbox_events WHERE id=ANY($1::uuid[]) ORDER BY id', [ids])).rows
  const beforeOffset = await head()
  const publicationIds = new Map<PoolClient, string>()
  const commitVisibility: { id: string; before: string; after: string }[] = []
  const checked = hookPool(pool, async (sql, client, execute) => {
    if (sql.includes('FROM durable_runtime.outbox_events WHERE id=$1 FOR UPDATE')) {
      const found = await execute(); publicationIds.set(client, found.rows[0].id); return found
    }
    const id = publicationIds.get(client)
    if (sql === 'COMMIT' && id) {
      const beforeState = (await pool.query('SELECT state FROM durable_runtime.outbox_events WHERE id=$1', [id])).rows[0].state
      assert.equal(beforeState, 'CLAIMED')
      assert.equal((await pool.query('SELECT count(*) AS n FROM durable_runtime.replay_events WHERE event_id=$1', [id])).rows[0].n, '0')
      const reply = await execute(); publicationIds.delete(client)
      const joined = (await pool.query('SELECT o.state,r.event_id FROM durable_runtime.outbox_events o JOIN durable_runtime.replay_events r ON r.event_id=o.id WHERE o.id=$1', [id])).rows[0]
      assert.equal(joined.state, 'PUBLISHED'); assert.equal(joined.event_id, id)
      commitVisibility.push({ id, before: beforeState, after: joined.state })
      return reply
    }
    return execute()
  })
  const worker = createOpsReplayPublicationWorker(checked, workerConfig('publication-supported'))
  try {
    const result = await worker.runPass()
    assert.equal(result.status, 'COMPLETED'); assert.equal(result.claimed.length, 4)
    assert.equal(result.published.length, 4); assert.equal(result.failures.length, 0)
    assert.equal(result.unsupported.length, 0)
    assert.deepEqual((await pool.query('SELECT * FROM durable_runtime.outbox_events WHERE id=ANY($1::uuid[]) ORDER BY id', [ids])).rows, beforeRows)
    const actual = await page(beforeOffset)
    assert.deepEqual(actual.events.map(event => event.sourceEventId).sort(), supported.map(row => row.id).sort())
    assert.equal(actual.nextCursor.offset, (BigInt(beforeOffset) + 4n).toString())
    assert.deepEqual(actual.nextCursor, actual.highWatermark)
    assert.equal(commitVisibility.length, 4)
    assert.equal(Object.values(result).some(value => JSON.stringify(value).includes('targetRef')), false)
    observations.supportedCommitVisibility = commitVisibility
    observations.unsupportedUnchangedIds = ids
  } finally { await worker.stop() }
  assert.equal((await pool.query('SELECT 1 AS usable')).rows[0].usable, 1)
})
check('two owners skip locked claims; committed publication reply loss replays the original identity without another offset', async () => {
  const sources = [notificationRow(), notificationRow()]
  for (const row of sources) { await seed(row) }
  const beforeOffset = await head()
  const held = gate()
  const captured: OutboxClaim[] = []
  const publishing = new Set<PoolClient>()
  let lost = false
  const ownerA = hookPool(pool, async (sql, client, execute) => {
    const reply = await execute()
    if (sql.includes('WITH candidates AS') && reply.rows.length > 0) {
      const row = reply.rows[0]
      const stored = (await client.query('SELECT claim_owner,claim_token FROM durable_runtime.outbox_events WHERE id=$1', [row.id])).rows[0]
      captured.push({ id: logicalId('event', row.id), event: row.event, aggregateId: row.aggregate_id,
        owner: stored.claim_owner, token: stored.claim_token, claimExpiresAt: row.claim_expires_at, attemptCount: row.attempt_count })
      held.signal(); await held.wait
    }
    if (sql.startsWith('INSERT INTO durable_runtime.replay_events')) { publishing.add(client) }
    if (sql === 'COMMIT' && publishing.delete(client) && !lost) {
      lost = true; throw new DurableDatabaseError('FIXTURE_PUBLICATION_REPLY_LOST')
    }
    return reply
  })
  const a = createOpsReplayPublicationWorker(ownerA, { ...workerConfig('publication-owner-a'), batchSize: 1 })
  const b = createOpsReplayPublicationWorker(pool, { ...workerConfig('publication-owner-b'), batchSize: 1 })
  const first = a.runPass()
  try {
    await held.entered
    const second = await b.runPass()
    assert.equal(second.published.length, 1)
    assert.notEqual(second.claimed[0].sourceEventId, captured[0].id)
    held.release()
    const result = await first
    assert.equal(result.status, 'PUBLICATION_FAILED')
    assert.equal(result.failures[0].code, 'FIXTURE_PUBLICATION_REPLY_LOST')
    assert.equal(result.failures[0].failureRecorded, false)
    assert.equal(result.failures[0].token, captured[0].token)
    assert.equal(lost, true)
    const replayed = await publishClaimToReplay(pool, { claim: captured[0] })
    assert.equal(replayed.status, 'REPLAYED')
    assert.equal((await a.runPass()).claimed.length, 0)
    const actual = await page(beforeOffset)
    assert.equal(actual.events.length, 2)
    assert.equal(new Set(actual.events.map(event => event.sourceEventId)).size, 2)
    assert.deepEqual(actual.events.map(event => event.sourceEventId).sort(), sources.map(row => row.id).sort())
    assert.equal(actual.nextCursor.offset, (BigInt(beforeOffset) + 2n).toString())
    observations.concurrentOwners = { lostReply: result.failures[0], otherClaim: second.claimed[0],
      replayed, duplicateOffsets: 0, skipLockedOverlapObserved: true }
  } finally { held.release(); await first; await a.stop(); await b.stop() }
})
// Last case leaves a malformed supported PENDING source for the next poll.
check('malformed supported source fails once while another canonical source publishes in the same finite batch', async () => {
  const ids = [randomUUID(), randomUUID()].sort()
  const bad = notificationRow('NOTIFICATION_OPENED', ids[0])
  bad.event.sourceEventId = randomUUID()
  const good = notificationRow('NOTIFICATION_OPENED', ids[1])
  await seed(bad); await seed(good)
  const beforeOffset = await head()
  const worker = createOpsReplayPublicationWorker(pool, workerConfig('publication-isolated-failure'))
  try {
    const result = await worker.runPass()
    assert.equal(result.status, 'PUBLICATION_FAILED')
    assert.equal(result.claimed.length, 2); assert.equal(result.failures.length, 1)
    assert.equal(result.failures[0].sourceEventId, bad.id)
    assert.equal(result.failures[0].code, 'REPLAY_SOURCE_METADATA')
    assert.equal(result.failures[0].failureRecorded, true)
    assert.deepEqual(result.published.map(value => value.sourceEventId), [good.id])
    const row = (await pool.query('SELECT state,attempt_count,last_error_code FROM durable_runtime.outbox_events WHERE id=$1', [bad.id])).rows[0]
    assert.deepEqual(row, { state: 'PENDING', attempt_count: '1', last_error_code: 'REPLAY_SOURCE_METADATA' })
    assert.deepEqual((await page(beforeOffset)).events.map(event => event.sourceEventId), [good.id])
    observations.isolatedFailure = result
  } finally { await worker.stop() }
})
