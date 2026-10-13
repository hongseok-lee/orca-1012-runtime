import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { createDurablePool, DurableDatabaseError } from '../db/connection.ts'
import { applyMigrations, readMigrations } from '../db/migrate.ts'
import { markOutboxPublished } from '../journal/publisher.ts'
import { observeNotification, markNotificationRead, resolveNotification, listNotifications } from '../notifications/index.ts'
import { OPS_REPLAY_STREAM, publishClaimToReplay, readReplayPage } from './index.ts'
import type { ReplayPage } from './types.ts'
import { authority, principal, receipt, fixture, source, notificationSource, claimFor, errorCode, hookPool, gate, waitForBlocking } from './test-support.mts'

assert.match(process.env.PGDATABASE ?? '', /^orca_p125_[a-z0-9_]+$/)
assert.ok(process.env.P125_MIGRATIONS)
const pool = createDurablePool({ max: 12 })
const cases: { name: string; passed: boolean }[] = []
const observations: Record<string, unknown> = {}
let migrations: { version: string; checksum: string }[] = []
before(async () => {
  const files = await readMigrations(process.env.P125_MIGRATIONS!)
  assert.equal(files.length, 12)
  migrations = (await applyMigrations(pool, files)).map(({ version, checksum }) => ({ version, checksum }))
})
after(async () => {
  if (process.env.P125_EVIDENCE) {
    await writeFile(process.env.P125_EVIDENCE, JSON.stringify({ scope: 'ACTUAL_PG_REPLAY_NOTIFICATION_MODULE_WITH_FIXTURE_SOURCES',
      recordedAt: new Date().toISOString(), sourceRevision: process.env.P125_SOURCE_REVISION,
      baseRevision: '7b7e32c281f674450a711fad17921d13fcb74cc1', migrations, cases, observations,
      authenticationVerified: false, providerRecoveryVerified: false, httpSseConnected: false,
      producerSpoolVerified: false, physicalHaFencingVerified: false,
      replyLossMode: 'driver hook discards reply after real PG COMMIT; not actual network loss',
      rollbackFaultMode: 'statement hook rejects before COMMIT; no shared PG/Pod/Node fault' }, null, 2)+'\n', { mode: 0o600 })
  }
  await pool.end()
})
function check(name: string, body: () => Promise<void>): void {
  test(name, { timeout: 120000 }, async () => { await body(); cases.push({ name, passed: true }) })
}
function page(result: ReplayPage): Extract<ReplayPage, { status: 'PAGE' }> {
  assert.equal(result.status, 'PAGE')
  if (result.status !== 'PAGE') { throw new Error('fixture reset') }
  return result
}
async function head(): Promise<string> {
  return (await pool.query('SELECT published_offset FROM durable_runtime.replay_stream_heads WHERE stream_id=$1', [OPS_REPLAY_STREAM])).rows[0]?.published_offset ?? '0'
}
async function read(offset = '0', unit?: string, limit = 100): Promise<Extract<ReplayPage, { status: 'PAGE' }>> {
  return page(await readReplayPage(pool, { streamId: OPS_REPLAY_STREAM, epoch: '0', afterOffset: offset, optionalUnitFilter: unit, limit }))
}
check('overlapping PG publisher transactions cannot expose later offset before earlier commit', async () => {
  const target = await fixture(pool)
  const a = await notificationSource(pool, target)
  const b = await notificationSource(pool, target)
  // A committed head lets B contend on the same stream row (not its creation).
  await pool.query('INSERT INTO durable_runtime.replay_stream_heads(stream_id,epoch) VALUES($1,0) ON CONFLICT DO NOTHING', [OPS_REPLAY_STREAM])
  const prior = await head(); const holdA = gate(); const holdB = gate(); const startedB = gate()
  let pidA = 0; let pidB = 0
  const publisherA = hookPool(pool, async (sql, client, execute) => {
    if (!pidA) { pidA = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid }
    const result = await execute()
    if (sql.startsWith('UPDATE durable_runtime.replay_stream_heads')) { holdA.signal(); await holdA.wait }
    return result
  })
  const publisherB = hookPool(pool, async (sql, client, execute) => {
    if (!pidB) { pidB = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid }
    if (sql.startsWith('INSERT INTO durable_runtime.replay_stream_heads')) { startedB.signal() }
    const result = await execute()
    if (sql.startsWith('SELECT epoch,published_offset')) { holdB.signal(); await holdB.wait }
    return result
  })
  const runA = publishClaimToReplay(publisherA, { claim: a.claim })
  await holdA.entered
  const runB = publishClaimToReplay(publisherB, { claim: b.claim })
  try {
    await startedB.entered
    observations.publicationOverlap = await waitForBlocking(pool, pidB, pidA)
    assert.equal(await head(), prior)
    assert.equal((await read(prior)).events.length, 0)
    holdA.release()
    const first = await runA
    assert.equal(first.status, 'PUBLISHED')
    await holdB.entered
    const visible = await read(prior)
    assert.deepEqual(visible.events.map(e => e.sourceEventId), [a.claim.id])
    holdB.release()
    const second = await runB
    assert.equal(second.status, 'PUBLISHED')
    assert.deepEqual((await read(prior)).events.map(e => e.sourceEventId), [a.claim.id, b.claim.id])
    observations.earlierCommitVisibleBeforeSecond = true
  } finally { holdA.release(); holdB.release(); await Promise.allSettled([runA, runB]) }
})
check('source occurred in the past is published after previously read cursor100', async () => {
  const target = await fixture(pool)
  while (BigInt(await head()) < 100n) {
    const item = await notificationSource(pool, target)
    assert.equal((await publishClaimToReplay(pool, { claim: item.claim })).status, 'PUBLISHED')
  }
  const before = await read('0', undefined, 100)
  assert.equal(before.nextCursor.offset, '100')
  const late = await notificationSource(pool, target, { occurredAt: new Date('2001-01-01T00:00:00.000Z') })
  const result = await publishClaimToReplay(pool, { claim: late.claim })
  assert.equal(result.status, 'PUBLISHED')
  const tail = await read('100')
  assert.equal(tail.events[0].cursor.offset, '101')
  assert.equal(tail.events[0].sourceEventId, late.claim.id)
  assert.equal(tail.events[0].occurredAt.toISOString(), '2001-01-01T00:00:00.000Z')
})
check('PG original payload wins; after-real-COMMIT reply loss replays the same cursor', async () => {
  const item = await notificationSource(pool, await fixture(pool))
  let discarded = false
  const lost = hookPool(pool, async (sql, _client, execute) => {
    const result = await execute()
    if (sql === 'COMMIT' && !discarded) { discarded = true; throw new Error('fixture discards committed reply') }
    return result
  })
  await errorCode(() => publishClaimToReplay(lost, { claim: { ...item.claim, event: { kind: 'UNSUPPORTED_FIXTURE', raw: 'must not copy' }, aggregateId: randomUUID() } }), 'DB_FAILURE')
  const replay = await publishClaimToReplay(pool, { claim: item.claim })
  assert.equal(replay.status, 'REPLAYED')
  const stored = (await pool.query('SELECT stream_id,epoch,"offset",payload FROM durable_runtime.replay_events WHERE event_id=$1', [item.claim.id])).rows[0]
  assert.equal(stored.payload.kind, 'NOTIFICATION_OPENED')
  assert.equal(stored.payload.raw, undefined)
  if (replay.status === 'REPLAYED') { assert.equal(replay.cursor.offset, stored.offset) }
  assert.equal((await pool.query('SELECT state,claim_token FROM durable_runtime.outbox_events WHERE id=$1', [item.claim.id])).rows[0].state, 'PUBLISHED')
})
check('publication rollback restores head/replay/outbox and stale claims cannot publish', async () => {
  const item = await notificationSource(pool, await fixture(pool)); const before = await head()
  const broken = hookPool(pool, async (sql, _client, execute) => {
    if (sql.startsWith('UPDATE durable_runtime.outbox_events SET state=\'PUBLISHED\'')) { throw new DurableDatabaseError('P125_STATEMENT_FAULT') }
    return execute()
  })
  await errorCode(() => publishClaimToReplay(broken, { claim: item.claim }), 'P125_STATEMENT_FAULT')
  assert.equal(await head(), before)
  assert.equal((await pool.query('SELECT count(*) AS n FROM durable_runtime.replay_events WHERE event_id=$1', [item.claim.id])).rows[0].n, '0')
  assert.equal((await pool.query('SELECT state FROM durable_runtime.outbox_events WHERE id=$1', [item.claim.id])).rows[0].state, 'CLAIMED')
  await errorCode(() => publishClaimToReplay(pool, { claim: { ...item.claim, token: randomUUID() } }), 'REPLAY_STALE_CLAIM')
  assert.equal((await publishClaimToReplay(pool, { claim: item.claim })).status, 'PUBLISHED')
  const expired = await notificationSource(pool, await fixture(pool))
  await pool.query('UPDATE durable_runtime.outbox_events SET claim_expires_at=clock_timestamp()-interval \'1 second\' WHERE id=$1', [expired.claim.id])
  await errorCode(() => publishClaimToReplay(pool, { claim: expired.claim }), 'REPLAY_STALE_CLAIM')
})
check('unsupported and foreign publication are explicit; mismatched canonical replay conflicts', async () => {
  const id = randomUUID()
  await pool.query("INSERT INTO durable_runtime.outbox_events(id,aggregate_id,aggregate_kind,revision,event,created_at) VALUES($1,$2,'fixture',0,$3,clock_timestamp())", [id, randomUUID(), JSON.stringify({ kind: 'UNSUPPORTED_FIXTURE', text: 'not ops metadata' })])
  const unsupported = await publishClaimToReplay(pool, { claim: await claimFor(pool, id) })
  assert.equal(unsupported.status, 'UNSUPPORTED_SOURCE')
  assert.equal((await pool.query('SELECT state FROM durable_runtime.outbox_events WHERE id=$1', [id])).rows[0].state, 'CLAIMED')
  const foreign = await notificationSource(pool, await fixture(pool))
  assert.equal(await markOutboxPublished(pool, foreign.claim), true)
  assert.equal((await publishClaimToReplay(pool, { claim: foreign.claim })).status, 'NOT_PUBLISHED_HERE')
  const conflict = await notificationSource(pool, await fixture(pool))
  await pool.query('INSERT INTO durable_runtime.replay_stream_heads(stream_id,epoch,published_offset) VALUES($1,0,1)', [`fixture-other:${randomUUID()}`]).then(async result => { assert.equal(result.rowCount, 1) })
  const other = (await pool.query("SELECT stream_id FROM durable_runtime.replay_stream_heads WHERE stream_id LIKE 'fixture-other:%' LIMIT 1")).rows[0].stream_id
  await pool.query('INSERT INTO durable_runtime.replay_events(stream_id,epoch,"offset",event_id,occurred_at,payload) VALUES($1,0,1,$2,$3,$4)', [other, conflict.claim.id, new Date('2020-01-01'), JSON.stringify({ conflict: true })])
  await errorCode(() => publishClaimToReplay(pool, { claim: conflict.claim }), 'REPLAY_SOURCE_CONFLICT')
})
check('bounded global filter scan advances excluded offsets; page/tail/reset/errors do not mutate state', async () => {
  const a = await fixture(pool); const b = await fixture(pool); const start = await head()
  const first = await notificationSource(pool, a); const second = await notificationSource(pool, b)
  await publishClaimToReplay(pool, { claim: first.claim }); await publishClaimToReplay(pool, { claim: second.claim })
  const snapshot = (await pool.query('SELECT row_to_json(n) AS row FROM durable_runtime.notifications n WHERE id=$1', [first.notificationId])).rows[0].row
  const skipped = await read(start, b.runtimeUnitId, 1)
  assert.equal(skipped.events.length, 0); assert.equal(skipped.scanned, 1)
  assert.equal(skipped.nextCursor.offset, (BigInt(start)+1n).toString())
  const tail = await read(skipped.nextCursor.offset, b.runtimeUnitId, 1)
  assert.deepEqual(tail.events.map(e => e.sourceEventId), [second.claim.id])
  assert.equal((await read(start, a.runtimeUnitId, 1)).events[0].sourceEventId, first.claim.id)
  const reset = await readReplayPage(pool, { streamId: OPS_REPLAY_STREAM, epoch: '1', afterOffset: '0', limit: 1 })
  assert.equal(reset.status, 'RESET_REQUIRED')
  if (reset.status === 'RESET_REQUIRED') { assert.equal(reset.currentEpoch, '0'); assert.equal(reset.minimumOffset, '1'); assert.equal(reset.latestOffset, await head()) }
  await errorCode(() => readReplayPage(pool, { streamId: OPS_REPLAY_STREAM, epoch: '0', afterOffset: '-1', limit: 1 }), 'REPLAY_CURSOR')
  const future = (BigInt(await head())+1n).toString()
  await errorCode(() => read(future), 'REPLAY_FUTURE_CURSOR')
  await listNotifications(pool, { optionalUnitFilter: a.runtimeUnitId, state: 'OPEN', limit: 1 })
  assert.deepEqual((await pool.query('SELECT row_to_json(n) AS row FROM durable_runtime.notifications n WHERE id=$1', [first.notificationId])).rows[0].row, snapshot)
})
check('notification incident dedup, monotone seen/retry, read is not resolution, verified-source resolve does not reopen', async () => {
  const target = await fixture(pool); const input = source(target)
  const created = await observeNotification(pool, input); const initial = receipt(created)
  const again = await observeNotification(pool, input); assert.equal(again.status, 'REPLAYED'); assert.deepEqual(receipt(again), initial)
  const repeat = { ...input, sourceEventId: logicalId('event', randomUUID()), occurredAt: new Date('2026-10-12T13:00:00Z'), retryCount: '3' }
  await observeNotification(pool, repeat)
  await observeNotification(pool, { ...input, sourceEventId: logicalId('event', randomUUID()), occurredAt: new Date('2020-01-01'), retryCount: '1', reasonCode: 'OLDER_FAILURE' })
  let row = (await pool.query('SELECT * FROM durable_runtime.notifications WHERE id=$1', [initial.notificationId])).rows[0]
  assert.equal(row.first_seen_at.toISOString(), input.occurredAt.toISOString()); assert.equal(row.last_seen_at.toISOString(), repeat.occurredAt.toISOString()); assert.equal(row.retry_count, '3'); assert.equal(row.reason, input.reasonCode)
  const readRequest = { principal, authorizationRef: 'fixture-auth-ref', operationKey: randomUUID(), notificationId: row.id, incidentKey: input.incidentKey, targetRef: target, expectedRevision: row.revision }
  const marked = await markNotificationRead(pool, readRequest)
  assert.equal(receipt(marked).state, 'OPEN'); assert.equal(receipt(marked).resolvedAt, null)
  assert.deepEqual(receipt(await markNotificationRead(pool, readRequest)), receipt(marked))
  row = (await pool.query('SELECT * FROM durable_runtime.notifications WHERE id=$1', [row.id])).rows[0]
  const recovery = { authority, sourceEventId: logicalId('event', randomUUID()), notificationId: row.id, incidentKey: input.incidentKey,
    targetRef: target, expectedRevision: row.revision, occurredAt: new Date('2026-10-12T14:00:00Z'), condition: 'RECOVERED' as const, recoveryEvidenceRef: 'fixture-recovery-source-ref' }
  const resolved = await resolveNotification(pool, recovery); assert.equal(receipt(resolved).state, 'RESOLVED')
  assert.deepEqual(receipt(await resolveNotification(pool, recovery)), receipt(resolved))
  await observeNotification(pool, { ...input, sourceEventId: logicalId('event', randomUUID()), occurredAt: new Date('2020-01-01') })
  row = (await pool.query('SELECT * FROM durable_runtime.notifications WHERE id=$1', [row.id])).rows[0]
  assert.equal(row.state, 'RESOLVED'); assert.equal(row.revision, receipt(resolved).revision)
  assert.equal((await pool.query('SELECT count(*) AS n FROM durable_runtime.notifications WHERE incident_key=$1', [input.incidentKey])).rows[0].n, '1')
})
check('Agent-only simultaneous same receipt and incident creation dedup after rank6 key lock', async () => {
  const full = await fixture(pool); const input = source({ agentId: full.agentId })
  const [a,b] = await Promise.all([observeNotification(pool, input), observeNotification(pool, input)])
  assert.deepEqual(receipt(a), receipt(b)); assert.ok(a.status === 'REPLAYED' || b.status === 'REPLAYED')
  const unique = (await pool.query('SELECT count(*) AS n FROM durable_runtime.notifications WHERE incident_key=$1', [input.incidentKey])).rows[0].n
  assert.equal(unique, '1')
  const newIncident = source({ agentId: full.agentId })
  const updates = await Promise.all([observeNotification(pool, newIncident), observeNotification(pool, { ...newIncident, sourceEventId: logicalId('event', randomUUID()), retryCount: '1' })])
  assert.equal(receipt(updates[0]).notificationId, receipt(updates[1]).notificationId)
})
check('notification expectedRevision/payload races and pre-receipt rollback leave no partial audit/outbox/state', async () => {
  const target = await fixture(pool); const input = source(target); const opened = receipt(await observeNotification(pool, input))
  const request = { principal, authorizationRef: 'fixture-auth-ref', operationKey: randomUUID(), notificationId: String(opened.notificationId), incidentKey: input.incidentKey, targetRef: target, expectedRevision: String(opened.revision) }
  const results = await Promise.allSettled([markNotificationRead(pool, request), markNotificationRead(pool, { ...request, operationKey: randomUUID() })])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter(r => r.status === 'rejected').length, 1)
  const fulfilled = results[0].status === 'fulfilled' ? results[0] : results[1]
  assert.ok(fulfilled.status === 'fulfilled')
  await errorCode(() => observeNotification(pool, { ...input, reasonCode: 'CONFLICT' }), 'RECEIPT_PAYLOAD_CONFLICT')
  const rollback = source(target)
  const broken = hookPool(pool, async (sql, _client, execute) => {
    if (sql.startsWith('INSERT INTO durable_runtime.rpc_receipts')) { throw new DurableDatabaseError('P125_RECEIPT_FAULT') }
    return execute()
  })
  await errorCode(() => observeNotification(broken, rollback), 'P125_RECEIPT_FAULT')
  assert.equal((await pool.query('SELECT count(*) AS n FROM durable_runtime.notifications WHERE incident_key=$1', [rollback.incidentKey])).rows[0].n, '0')
  assert.equal((await pool.query('SELECT count(*) AS n FROM durable_runtime.outbox_events WHERE id=$1', [rollback.sourceEventId])).rows[0].n, '0')
  assert.equal((await pool.query("SELECT count(*) AS n FROM durable_runtime.runtime_audit_events WHERE next_state->>'sourceEventId'=$1", [rollback.sourceEventId])).rows[0].n, '0')
  await observeNotification(pool, rollback)
})
check('unavailable own client cannot produce empty-page or durable notification success', async () => {
  const target = await fixture(pool)
  const unavailable = createDurablePool({ host: '127.0.0.1', port: 1, connectionTimeoutMillis: 100 })
  try {
    await errorCode(() => readReplayPage(unavailable, { streamId: OPS_REPLAY_STREAM, epoch: '0', afterOffset: '0', limit: 1 }), 'DB_FAILURE')
    await errorCode(() => observeNotification(unavailable, source(target)), 'DB_FAILURE')
  } finally { await unavailable.end() }
})
check('actual P112 canonical FAILED sources keep original identity and metadata without raw payload', async () => {
  const target = await fixture(pool); const eventId = logicalId('event', randomUUID()); const attempt = randomUUID()
  const producer = randomUUID(); const incarnation = `p125-source-${randomUUID()}`; const pod = `fixture-pod-${randomUUID()}`
  const notificationId = randomUUID(); const journalId = randomUUID(); const incidentKey = `runtime-event-failed:${eventId}`
  const at = new Date('2026-10-12T11:00:00.000Z')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,\'{}\',0)', [target.runtimeUnitId])
    await client.query("INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,resource_profile_revision,effective_resources,status) VALUES($1,$2,1,'COLD',$3,$4,0,'{}','FIXTURE')", [attempt, target.runtimeUnitId, pod, incarnation])
    await client.query('INSERT INTO durable_runtime.runtime_event_producers(producer_id,incarnation,agent_id,runtime_unit_id,attempt_id,pod_uid,execution_epoch,committed_through) VALUES($1,$2,$3,$4,$5,$6,1,1)', [producer, incarnation, target.agentId, target.runtimeUnitId, attempt, pod])
    await client.query("INSERT INTO durable_runtime.runtime_event_queue(event_id,producer_id,incarnation,producer_seq,agent_id,payload,state,attempt_count,retry_count,last_error,terminal_at) VALUES($1,$2,$3,1,$4,$5,'FAILED',6,5,'FIXTURE_EXHAUSTED',$6)", [eventId, producer, incarnation, target.agentId, JSON.stringify({ text: 'fixture prompt must not publish', credentials: 'fixture sentinel' }), at])
    const session = target.sessionIds![0]; const contextId = randomUUID()
    await client.query('INSERT INTO durable_runtime.runtime_event_targets(event_id,session_id,agent_id) VALUES($1,$2,$3)', [eventId, session, target.agentId])
    await client.query("INSERT INTO durable_runtime.session_context_records(id,session_id,revision,kind,target_event_id,body_ref) VALUES($1,$2,1,'RUNTIME_EVENT_FAILED',$3,$4)", [contextId, session, eventId, JSON.stringify({ originalEventRef: `runtime-event:${eventId}` })])
    await client.query('INSERT INTO durable_runtime.runtime_event_failure_contexts(event_id,session_id,context_record_id) VALUES($1,$2,$3)', [eventId, session, contextId])
    const originalTarget = { eventId, agentId: target.agentId!, sessionIds: [session] }
    await client.query("INSERT INTO durable_runtime.notifications(id,incident_key,target_ref,reason,state,first_seen_at,last_seen_at,retry_count) VALUES($1,$2,$3,'FIXTURE_EXHAUSTED','OPEN',$4,$4,5)", [notificationId, incidentKey, JSON.stringify(originalTarget), at])
    await client.query("INSERT INTO durable_runtime.outbox_events(id,aggregate_id,aggregate_kind,revision,event,created_at) VALUES($1,$2,'notification',0,$3,$4)", [notificationId, notificationId, JSON.stringify({ kind: 'RUNTIME_EVENT_FAILED', eventId, incidentKey }), at])
    await client.query("INSERT INTO durable_runtime.outbox_events(id,aggregate_id,aggregate_kind,revision,event,created_at) VALUES($1,$2,'session',1,$3,$4)", [journalId, session, JSON.stringify({ kind: 'RUNTIME_EVENT_OUTCOME', eventId, outcome: 'FAILED', attempts: 6, retryCount: 5 }), at])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  const prior = await head()
  await publishClaimToReplay(pool, { claim: await claimFor(pool, notificationId) })
  await publishClaimToReplay(pool, { claim: await claimFor(pool, journalId) })
  const found = await read(prior, target.runtimeUnitId)
  assert.equal(found.events.length, 2)
  assert.deepEqual(found.events.map(e => e.sourceEventId), [notificationId, journalId])
  const bodies = found.events.map(e => e.payload)
  assert.match(JSON.stringify(bodies), /RUNTIME_EVENT_FAILED/)
  assert.match(JSON.stringify(bodies), /RUNTIME_EVENT_OUTCOME/)
  assert.match(JSON.stringify(bodies), new RegExp(incidentKey))
  assert.doesNotMatch(JSON.stringify(bodies), /fixture prompt|credentials|fixture sentinel|QUEUE_EVENT_FAILED/)
  const originalTarget = { eventId, agentId: target.agentId!, sessionIds: target.sessionIds! }
  const marked = await markNotificationRead(pool, { principal, authorizationRef: 'fixture-auth-ref', operationKey: randomUUID(), notificationId, incidentKey, targetRef: originalTarget, expectedRevision: '0' })
  assert.equal(receipt(marked).state, 'OPEN')
  assert.equal((await listNotifications(pool, { optionalUnitFilter: target.runtimeUnitId, limit: 1000 })).notifications.some(n => n.id === notificationId), true)
  observations.p112SourceScope = 'Actual PG rows constrained by owner 001–012 with canonical P112 outbox shapes; no P112 suite/handler/auth/provider acceptance repeated'
})
check('caller mutation after first await cannot change observation/read/resolve hashes, locks, SQL or publication source', async () => {
  const target = await fixture(pool)
  const sessions = [...target.sessionIds!]
  const input = source({ ...target, sessionIds: sessions }, { authority: { ...authority } })
  const originalId = input.sourceEventId; const originalKey = input.incidentKey
  const originalTime = input.occurredAt.toISOString()
  function pausedBusiness() {
    const pause = gate(); let once = true
    return { pause, connection: hookPool(pool, async (sql, _client, execute) => {
      const result = await execute()
      if (once && sql.startsWith('SELECT id FROM durable_runtime.sessions')) { once = false; pause.signal(); await pause.wait }
      return result
    }) }
  }
  const observing = pausedBusiness()
  const observed = observeNotification(observing.connection, input)
  await observing.pause.entered
  let opened: ReturnType<typeof receipt>
  try {
    input.sourceEventId = logicalId('event', randomUUID()); input.incidentKey = 'caller-mutated-incident'
    input.reasonCode = 'CALLER_MUTATED'; input.retryCount = '99'; input.occurredAt.setTime(0)
    input.authority.actorId = 'caller-mutated-source'; input.authority.verificationRef = 'caller-mutated-ref'
    input.targetRef.runtimeUnitId = logicalId('runtime-unit', randomUUID()); sessions.push(logicalId('session', randomUUID()))
    observing.pause.release(); opened = receipt(await observed)
  } finally { observing.pause.release() }
  const row = (await pool.query('SELECT * FROM durable_runtime.notifications WHERE id=$1', [opened.notificationId])).rows[0]
  assert.equal(row.incident_key, originalKey); assert.equal(row.reason, 'FIXTURE_FAILED')
  assert.equal(row.first_seen_at.toISOString(), originalTime); assert.equal(row.retry_count, '0')
  assert.equal((await pool.query('SELECT principal_id FROM durable_runtime.rpc_receipts WHERE operation_key=$1', [originalId])).rows[0].principal_id, authority.actorId)
  assert.equal((await pool.query('SELECT count(*) AS n FROM durable_runtime.notifications WHERE incident_key=$1', [input.incidentKey])).rows[0].n, '0')

  const readInput = { principal, authorizationRef: 'fixture-read-authorization', operationKey: randomUUID(), notificationId: row.id,
    incidentKey: originalKey, targetRef: { ...target, sessionIds: [...target.sessionIds!] }, expectedRevision: row.revision }
  const readKey = readInput.operationKey; const reading = pausedBusiness()
  const readResult = markNotificationRead(reading.connection, readInput)
  await reading.pause.entered
  let readReceipt: ReturnType<typeof receipt>
  try {
    readInput.operationKey = randomUUID(); readInput.notificationId = randomUUID(); readInput.expectedRevision = '999'
    readInput.principal = principal
    readInput.authorizationRef = 'caller-mutated-auth-ref'
    readInput.targetRef.runtimeUnitId = logicalId('runtime-unit', randomUUID())
    reading.pause.release(); readReceipt = receipt(await readResult)
  } finally { reading.pause.release() }
  assert.equal(readReceipt.notificationId, row.id); assert.equal(readReceipt.state, 'OPEN')
  assert.equal((await pool.query('SELECT count(*) AS n FROM durable_runtime.rpc_receipts WHERE operation_key=$1', [readKey])).rows[0].n, '1')

  const recovery = { authority: { ...authority }, sourceEventId: logicalId('event', randomUUID()), notificationId: row.id,
    incidentKey: originalKey, targetRef: { ...target, sessionIds: [...target.sessionIds!] }, expectedRevision: String(readReceipt.revision),
    occurredAt: new Date('2026-10-12T14:00:00Z'), condition: 'RECOVERED' as const, recoveryEvidenceRef: 'fixture-condition-confirmed' }
  const resolving = pausedBusiness(); const resolveResult = resolveNotification(resolving.connection, recovery)
  await resolving.pause.entered
  try {
    recovery.occurredAt.setTime(0); recovery.authority.actorId = 'mutated-recovery-source'
    recovery.notificationId = randomUUID(); recovery.expectedRevision = '999'; recovery.recoveryEvidenceRef = ''
    Object.assign(recovery, { condition: 'UNKNOWN' })
    resolving.pause.release()
    const value = receipt(await resolveResult)
    assert.equal(value.notificationId, row.id); assert.equal(value.state, 'RESOLVED'); assert.equal(value.resolvedAt, '2026-10-12T14:00:00.000Z')
  } finally { resolving.pause.release() }

  const actualClaim = await claimFor(pool, originalId)
  const claim = { ...actualClaim }; const publishing = gate()
  const publication = publishClaimToReplay(hookPool(pool, async (sql, _client, execute) => {
    const result = await execute()
    if (sql.includes('FROM durable_runtime.outbox_events') && sql.includes('FOR UPDATE')) { publishing.signal(); await publishing.wait }
    return result
  }), { claim })
  await publishing.entered
  try {
    claim.id = logicalId('event', randomUUID()); claim.owner = 'mutated-publisher'; claim.token = randomUUID()
    publishing.release()
    const published = await publication; assert.equal(published.status, 'PUBLISHED')
    assert.equal((await pool.query('SELECT count(*) AS n FROM durable_runtime.replay_events WHERE event_id=$1', [originalId])).rows[0].n, '1')
  } finally { publishing.release() }
  observations.mutableInputSnapshotBoundary = 'Caller-owned Date/authority/target/key/claim mutations after actual SQL await do not change the frozen validated request; first execution only, no auth/provider proof'
})
