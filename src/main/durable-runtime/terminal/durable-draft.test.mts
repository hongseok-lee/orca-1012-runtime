import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { pairedDeviceAttachmentPrincipal, attachmentUploadId } from '../attachments/types.ts'
import { saveAttachmentImage } from '../attachments/store.ts'
import { buildAgentTuiClearInputForText } from '../../../shared/agent-tui-input-clear'
import { encodeTerminalStreamText } from '../../../shared/terminal-stream-protocol'
import { claimTerminalFloorInTransaction } from './floor-repository'
import { reattachTerminalFloorInTransaction } from './floor-reattach'
import { applyManagedTerminalIngress, managedTerminalIngressWireResult } from './managed-ingress'
import { prepareManagedTerminalIngress, requireCurrentTerminalIngress } from './managed-preparation'
import { terminalFixture, unaryRequest, binaryRequest, readStored, originalTexts,
  counts, instrumentPool } from './durable-verification-fixtures.mts'

let pool: Pool
before(async () => {
  assert.equal(process.cwd(), process.env.ORCA_P118_EXECUTION_ROOT, 'Owned verifier execution root is required')
  assert.match(process.env.PGDATABASE ?? '', /^orca_p118_[a-z0-9_]+$/)
  pool = createDurablePool({ database: process.env.PGDATABASE, max: 6 })
  const schema = await pool.query(
    "SELECT version FROM durable_runtime.schema_migrations WHERE version='018-terminal-input-floor.sql'"
  )
  assert.equal(schema.rowCount, 1, 'Exact owner-provided 018 must already be applied')
})
after(async () => { await pool?.end() })

test('snapshot keeps the original callback receiver and method after an await', async () => {
  const f = await terminalFixture(pool)
  const request = await unaryRequest(pool, f, 'original callback scope')
  let current = false
  let originalCalls = 0
  let replacementCalls = 0
  const receiver = { ...request.snapshot, isCurrent(): boolean {
    assert.equal(this, receiver)
    originalCalls++
    return current
  } }
  const prepared = prepareManagedTerminalIngress({ ...request, snapshot: receiver })
  await Promise.resolve()
  receiver.isCurrent = function (): boolean {
    replacementCalls++
    return true
  }
  assert.throws(() => requireCurrentTerminalIngress(prepared), { code: 'TERMINAL_STALE_CONNECTION' })
  current = true
  requireCurrentTerminalIngress(prepared)
  assert.equal(originalCalls, 2)
  assert.equal(replacementCalls, 0)
})

test('Mac clear body and separate CR recover from PG without a process-local draft', async () => {
  const f = await terminalFixture(pool)
  await applyManagedTerminalIngress(pool, await unaryRequest(pool, f, buildAgentTuiClearInputForText('old')))
  await applyManagedTerminalIngress(pool, await unaryRequest(pool, f, '\x1b[200~첫 줄\nsecond\x1b[201~'))
  const beforeSubmit = await counts(pool, f.request.authority, f.unitId)
  assert.equal(beforeSubmit.inputs, '0')
  assert.equal(beforeSubmit.intent, '0')
  // A fresh request/entry reads codec state from PG. No earlier reducer object is supplied.
  const submitted = await applyManagedTerminalIngress(pool, await unaryRequest(pool, f, '\r'))
  assert.equal(submitted.status, 'COMMITTED')
  assert.deepEqual(await originalTexts(pool, f), ['첫 줄\nsecond'])
  const stored = await readStored(pool, f)
  assert.equal(stored.draft?.draft.revision, '3')
  assert.deepEqual(stored.draft?.draft.chunks, [])
  const observed = await counts(pool, f.request.authority, f.unitId)
  assert.equal(observed.inputs, '1')
  assert.equal(observed.receipts, '3')
  assert.equal(observed.journal, '1')
  assert.equal(observed.outbox, '1')
})

test('iPhone body plus Enter records the original and exposes success only after observed COMMIT', async () => {
  const f = await terminalFixture(pool)
  const request = await unaryRequest(pool, f, 'iPhone 原 본문\n😀', true)
  const accepted = await applyManagedTerminalIngress(pool, request)
  assert.equal(accepted.status, 'COMMITTED')
  assert.deepEqual(managedTerminalIngressWireResult(accepted),
    { send: { handle: f.terminalHandle, accepted: true, bytesWritten: 0 } })
  assert.deepEqual(await originalTexts(pool, f), ['iPhone 原 본문\n😀'])
  assert.deepEqual((await readStored(pool, f)).draft?.draft.chunks, [])
})

test('owner takeover and mode change require a new generation and keep the old floor draft', async () => {
  const f = await terminalFixture(pool)
  await applyManagedTerminalIngress(pool, await unaryRequest(pool, f, 'author A draft'))
  const old = await readStored(pool, f)
  assert.ok(old.floor)
  const device = randomUUID()
  const principal = pairedDeviceAttachmentPrincipal(device)
  const connection = `fixture-other-${randomUUID()}`
  f.actors.set(device, principal)
  f.registeredConnections.add(connection)
  const nextBinding = { ...f.binding, pairedDeviceId: device, principalId: principal,
    connectionId: connection, floorGeneration: '1' }
  await withDurableTransaction(pool, async (tx) => {
    await lockAggregates(tx, { sessionIds: [f.sessionId] })
    await claimTerminalFloorInTransaction(tx, nextBinding, old.floor, f.floorAuthorization)
  })
  assert.deepEqual((await readStored(pool, f, f.binding)).draft, old.draft)
  const b = await applyManagedTerminalIngress(pool, await unaryRequest(pool, f, 'author B', true, [], nextBinding))
  assert.equal(b.status, 'COMMITTED')
  assert.deepEqual(await originalTexts(pool, f), ['author B'])
  const floor = (await readStored(pool, f, nextBinding)).floor
  assert.ok(floor)
  await assert.rejects(withDurableTransaction(pool, async (tx) => {
    await lockAggregates(tx, { sessionIds: [f.sessionId] })
    await claimTerminalFloorInTransaction(tx, { ...nextBinding, mode: 'RAW_TERMINAL' }, floor, f.floorAuthorization)
  }), { code: 'TERMINAL_FLOOR_GENERATION' })
  await withDurableTransaction(pool, async (tx) => {
    await lockAggregates(tx, { sessionIds: [f.sessionId] })
    await claimTerminalFloorInTransaction(tx, { ...nextBinding, mode: 'RAW_TERMINAL', floorGeneration: '2' },
      floor, f.floorAuthorization)
  })
  assert.deepEqual((await readStored(pool, f, f.binding)).draft, old.draft)
})

test('explicit authenticated same-floor reattach preserves partial parser and rejects the old connection', async () => {
  const f = await terminalFixture(pool)
  await applyManagedTerminalIngress(pool, await unaryRequest(pool, f, '\x1b[200~kept\n'))
  const oldConnectionRequest = await unaryRequest(pool, f, 'old connection body')
  const original = await readStored(pool, f)
  assert.ok(original.floor)
  assert.ok(original.draft)
  const newConnection = `fixture-reattach-${randomUUID()}`
  f.registeredConnections.delete(f.binding.connectionId)
  f.registeredConnections.add(newConnection)
  const reattached = await withDurableTransaction(pool, async (tx) => {
    await lockAggregates(tx, { sessionIds: [f.sessionId] })
    return reattachTerminalFloorInTransaction(tx, { previous: original.floor!,
      nextConnectionId: newConnection, expectedDraftRevision: original.draft!.draft.revision }, f.floorAuthorization)
  })
  assert.equal(reattached.floor.binding.floorGeneration, f.binding.floorGeneration)
  assert.deepEqual(reattached.draft?.draft.chunks, original.draft.draft.chunks)
  assert.equal(reattached.draft?.draft.pasteOpen, true)
  await assert.rejects(applyManagedTerminalIngress(pool, oldConnectionRequest), { code: 'FIXTURE_AUTH_CONNECTION' })
  const binding = reattached.floor.binding
  await applyManagedTerminalIngress(pool, await unaryRequest(pool, f, '\x1b[201~', false, [], binding))
  await applyManagedTerminalIngress(pool, await unaryRequest(pool, f, '\r', false, [], binding))
  assert.deepEqual(await originalTexts(pool, f), ['kept\n'])
})

test('same-floor reattach keeps unfinished UTF-8 bytes and rejects a different stream identity', async () => {
  const f = await terminalFixture(pool)
  const korean = encodeTerminalStreamText('한')
  const start = Uint8Array.from([...encodeTerminalStreamText('\x1b[200~'), korean[0]])
  await applyManagedTerminalIngress(pool, await binaryRequest(pool, f, start, 'fixture-stream-original'))
  const original = await readStored(pool, f)
  assert.ok(original.floor)
  assert.ok(original.draft)
  const connection = `fixture-stream-reattach-${randomUUID()}`
  f.registeredConnections.delete(f.binding.connectionId)
  f.registeredConnections.add(connection)
  const reattached = await withDurableTransaction(pool, async (tx) => {
    await lockAggregates(tx, { sessionIds: [f.sessionId] })
    return reattachTerminalFloorInTransaction(tx, { previous: original.floor!,
      nextConnectionId: connection, expectedDraftRevision: original.draft!.draft.revision }, f.floorAuthorization)
  })
  const before = await readStored(pool, f, reattached.floor.binding)
  await assert.rejects(applyManagedTerminalIngress(pool, await binaryRequest(pool, f, korean.slice(1),
    'fixture-stream-new', reattached.floor.binding)), { code: 'TERMINAL_SEMANTIC_UNSUPPORTED' })
  const after = await readStored(pool, f, reattached.floor.binding)
  assert.deepEqual(after.draft, before.draft)
  assert.deepEqual(after.draft?.draft.pendingUtf8, Array.from(korean.slice(0, 1)))
  assert.equal((await counts(pool, f.request.authority, f.unitId)).inputs, '0')
})

test('stale draft CAS rejects a concurrent edit and unsupported historical codec stays intact', async () => {
  const f = await terminalFixture(pool)
  const first = await unaryRequest(pool, f, 'first')
  const second = await unaryRequest(pool, f, 'second')
  const results = await Promise.allSettled([applyManagedTerminalIngress(pool, first), applyManagedTerminalIngress(pool, second)])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1)
  const rejected = results.find((r) => r.status === 'rejected')
  assert.equal(rejected?.status === 'rejected' ? rejected.reason.code : null, 'TERMINAL_STALE_DRAFT_REVISION')
  assert.equal((await readStored(pool, f)).draft?.draft.chunks.length, 1)
  const historical = await terminalFixture(pool)
  const request = await unaryRequest(pool, historical, 'must not wipe historical')
  await pool.query(`INSERT INTO durable_runtime.legacy_drafts(terminal_handle,paired_device_id,floor_generation,
    draft_revision,body,attachments,lifecycle,updated_at) VALUES($1,$2,0,0,$3,'[]','OPEN',clock_timestamp())`,
    [historical.terminalHandle, historical.binding.pairedDeviceId, JSON.stringify({ oldBody: 'kept historical' })])
  await assert.rejects(applyManagedTerminalIngress(pool, request), { code: 'TERMINAL_HISTORICAL_DRAFT_UNSUPPORTED' })
  const preserved = await pool.query('SELECT body,draft_revision FROM durable_runtime.legacy_drafts WHERE terminal_handle=$1',
    [historical.terminalHandle])
  assert.deepEqual(preserved.rows[0].body, { oldBody: 'kept historical' })
  assert.equal(preserved.rows[0].draft_revision, '0')
})

test('attachment submit and deliberate later SQL failure roll back Input journal wake draft and receipt together', async () => {
  const f = await terminalFixture(pool)
  const id = attachmentUploadId(randomUUID())
  const alias = await withDurableTransaction(pool, (tx) => saveAttachmentImage(tx, {
    id, principal: f.request.authority.principal, contentBase64: 'AA==', aliasRoot: '/verification/p118' }))
  const refs = [{ attachmentId: id, aliasPath: alias.aliasPath, contentHash: alias.contentHash }]
  await applyManagedTerminalIngress(pool, await unaryRequest(pool, f, 'body with image', false, refs))
  const submit = await unaryRequest(pool, f, '\r')
  const before = await counts(pool, f.request.authority, f.unitId)
  const beforeDraft = (await readStored(pool, f)).draft
  let reachedDraftWrite = false
  const failing = instrumentPool(pool, { beforeQuery(sql) {
    if (/UPDATE durable_runtime\.legacy_drafts/.test(sql)) {
      reachedDraftWrite = true
      throw new Error('P118 deliberate post-intake SQL failure')
    }
  } })
  await assert.rejects(applyManagedTerminalIngress(failing, submit), { code: 'DB_FAILURE' })
  assert.equal(reachedDraftWrite, true)
  assert.deepEqual(await counts(pool, f.request.authority, f.unitId), before)
  assert.deepEqual((await readStored(pool, f)).draft, beforeDraft)
  const accepted = await applyManagedTerminalIngress(pool, submit)
  assert.equal(accepted.status, 'COMMITTED')
  const links = await pool.query(`SELECT a.blob_ref,a.content_hash FROM durable_runtime.input_attachments a
    JOIN durable_runtime.input_components i ON i.id=a.input_id WHERE i.session_id=$1`, [f.sessionId])
  assert.equal(links.rowCount, 1)
  assert.equal(links.rows[0].blob_ref, alias.aliasPath)
  assert.equal(links.rows[0].content_hash, alias.contentHash)
  assert.deepEqual((await readStored(pool, f)).draft?.draft.chunks, [])
})

test('receipt replay ignores stale mutable draft revision and new request IDs retain intentional duplicate bodies', async () => {
  const f = await terminalFixture(pool)
  const request = await unaryRequest(pool, f, 'same body', true)
  await applyManagedTerminalIngress(pool, request)
  const before = await counts(pool, f.request.authority, f.unitId)
  const replayed = await applyManagedTerminalIngress(pool, request)
  assert.equal(replayed.status, 'REPLAYED')
  assert.deepEqual(await counts(pool, f.request.authority, f.unitId), before)
  await applyManagedTerminalIngress(pool, await unaryRequest(pool, f, 'same body', true))
  assert.deepEqual(await originalTexts(pool, f), ['same body', 'same body'])
  const other = await terminalFixture(pool)
  const one = await binaryRequest(pool, other, encodeTerminalStreamText('repeat'), 'same-stream')
  const two = await binaryRequest(pool, other, encodeTerminalStreamText('repeat'), 'same-stream')
  assert.notEqual(prepareManagedTerminalIngress(one).identity.key.operationKey,
    prepareManagedTerminalIngress(two).identity.key.operationKey)
})
