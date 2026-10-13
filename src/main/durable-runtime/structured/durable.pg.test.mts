import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { saveAttachmentImage } from '../attachments/store.ts'
import { attachmentUploadId } from '../attachments/types.ts'
import { recordUnitIntent } from '../lifecycle/intent.ts'
import { createDurableStructuredSession } from './durable-create.ts'
import { sendDurableStructuredInput } from './durable-send.ts'
import { resolveStructuredSession } from './durable-alias.ts'
import { prepareDurableStructuredCall } from './durable-common.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { fixture, sendCall, sql, device, instrumentPool, checkoutGate, barrier,
  requireExactOwnedSchema, requireNoCreateEffects, sessionState } from './durable-fixtures.mts'

// WRITTEN, NOT EXECUTED. The guard is an execution prerequisite, not authority.
// DB creation/migration and first-run slot are assigned separately by Root.
if (process.env.ORCA_P117_DURABLE_PG_APPROVED !== 'root-assigned-slot' ||
  !/^orca_p117_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? '') ||
  process.cwd() !== process.env.ORCA_P117_DURABLE_EXECUTION_ROOT) {
  throw new Error('Root slot and exact owned P117 execution database required')
}
const pool = createDurablePool({ max: 6 })

await test('first structured same-TX composition boundaries with synthetic upper authority', async t => {
  try {
    await requireExactOwnedSchema(pool)
    await t.test('non-UUID public intent creates real Session Tab membership alias event and one receipt without physical binding', async () => {
      const f = await fixture(pool)
      const observed = instrumentPool(pool)
      const result = await createDurableStructuredSession({ ...f.call, pool: observed.pool })
      assert.equal(result.status, 'COMMITTED')
      assert.deepEqual(observed.controls, ['BEGIN', 'COMMIT'])
      const row = (await sql(pool, `SELECT s.session_fence,s.lifecycle,t.kind,t.terminal_handle,t.leaf_id,t.pane_key,
        u.phase,u.active_attempt_id,b.identity_verified_at,b.identity_proof_ref,a.public_session_id,
        e.body,e.journal_epoch,e.seq,o.step
        FROM durable_runtime.sessions s JOIN durable_runtime.tabs t ON t.session_id=s.id
        JOIN durable_runtime.runtime_members m ON m.session_id=s.id
        JOIN durable_runtime.runtime_units u ON u.id=m.runtime_unit_id
        JOIN durable_runtime.storage_bindings b ON b.id=m.storage_binding_id
        JOIN durable_runtime.structured_session_aliases a ON a.session_id=s.id
        JOIN durable_runtime.session_events e ON e.session_id=s.id
        JOIN durable_runtime.operations o ON o.runtime_unit_id=u.id WHERE s.id=$1`, [f.sessionId])).rows[0]
      assert.equal(row.public_session_id, f.publicId)
      assert.equal(row.session_fence, '1'); assert.equal(row.lifecycle, 'OPEN'); assert.equal(row.kind, 'agent-session')
      assert.deepEqual([row.terminal_handle, row.leaf_id, row.pane_key, row.active_attempt_id,
        row.identity_verified_at, row.identity_proof_ref], [null, null, null, null, null, null])
      assert.equal(row.phase, 'ABSENT'); assert.equal(row.step, 'INTENT_QUEUED')
      assert.equal(row.body.kind, 'STRUCTURED_SESSION_CREATED'); assert.equal(row.body.version, 1)
      assert.deepEqual(row.body.originalCreate, f.call.configuration.reservation.originalRequest)
      assert.equal((await sessionState(pool, f)).receipts, 1)
      const upper = prepareDurableStructuredCall(sendCall(f, 'synthetic-resolve'), 'agentSession.send')
      const alias = await resolveStructuredSession(pool, upper.authority, sendCall(f, 'synthetic-resolve').workspace)
      assert.equal(alias.sessionId, f.sessionId)
      await assert.rejects(resolveStructuredSession(pool, upper.authority,
        { ...alias.workspace, workspaceId: logicalId('workspace', randomUUID()) }), { code: 'STRUCTURED_SESSION_ALIAS_SCOPE' })
    })

    await t.test('actual alias FK failure rolls back unpublished rows intent Tab event and receipt', async () => {
      const f = await fixture(pool)
      const broken = instrumentPool(pool, async (text, values) => {
        if (text.includes('INSERT INTO durable_runtime.structured_session_aliases')) { values[2] = randomUUID() }
      })
      await assert.rejects(createDurableStructuredSession({ ...f.call, pool: broken.pool }), { code: '23503' })
      assert.deepEqual(broken.controls, ['BEGIN', 'ROLLBACK'])
      await requireNoCreateEffects(pool, f)
      assert.equal((await sessionState(pool, f)).receipts, 0)
    })

    await t.test('public ID race keeps one alias and rolls back the losing different-principal reservation', async () => {
      const publicId = `synthetic-public-race-${randomUUID()}`
      const first = await fixture(pool, publicId), second = await fixture(pool, publicId)
      const meet = barrier(2)
      const racing = instrumentPool(pool, undefined, async text => {
        if (text.startsWith('SELECT session_id FROM durable_runtime.structured_session_aliases')) { await meet() }
      })
      const results = await Promise.allSettled([
        createDurableStructuredSession({ ...first.call, pool: racing.pool }),
        createDurableStructuredSession({ ...second.call, pool: racing.pool })
      ])
      const won = results.findIndex(value => value.status === 'fulfilled')
      assert.ok(won === 0 || won === 1)
      assert.equal(results.filter(value => value.status === 'fulfilled').length, 1)
      const failed = results[1 - won]
      assert.equal(failed.status, 'rejected')
      if (failed.status === 'rejected') {
        assert.ok(['23505', 'STRUCTURED_PUBLIC_SESSION_CONFLICT'].includes(failed.reason.code))
      }
      const loser = won === 0 ? second : first
      await requireNoCreateEffects(pool, loser)
      const rows = await sql(pool, 'SELECT session_id FROM durable_runtime.structured_session_aliases WHERE public_session_id=$1', [publicId])
      assert.equal(rows.rowCount, 1); assert.equal(rows.rows[0].session_id, won === 0 ? first.sessionId : second.sessionId)
    })

    await t.test('create receipt replays before changed internal UUID configuration and current tombstones', async () => {
      const f = await fixture(pool)
      const first = await createDurableStructuredSession(f.call)
      assert.notEqual(first.status, 'UNCERTAIN')
      await sql(pool, "UPDATE durable_runtime.sessions SET lifecycle='CLOSED',session_fence=session_fence+1 WHERE id=$1", [f.sessionId])
      await sql(pool, 'UPDATE durable_runtime.workspaces SET deleted_at=clock_timestamp() WHERE id=$1', [f.workspaceId])
      await sql(pool, "UPDATE durable_runtime.tabs SET lifecycle='CLOSED',closed_at=clock_timestamp() WHERE id=$1", [f.tabId])
      const before = await sessionState(pool, f)
      const config = structuredClone(f.call.configuration)
      Object.assign(config.reservation.runtime, { sessionId: logicalId('session', randomUUID()) })
      Object.assign(config.reservation.runtime.agent, { id: logicalId('agent', randomUUID()) })
      Object.assign(config.reservation.runtime.policy, { operationDeadlineMs: 0 })
      const again = await createDurableStructuredSession({ ...f.call, configuration: config })
      assert.equal(again.status, 'REPLAYED')
      if (first.status !== 'UNCERTAIN') { assert.deepEqual(again.receipt.response, first.receipt.response) }
      assert.deepEqual(await sessionState(pool, f), before)
      assert.equal((await sql(pool, 'SELECT count(*)::integer AS n FROM durable_runtime.sessions WHERE id=$1', [config.reservation.runtime.sessionId])).rows[0].n, 0)
    })

    await t.test('two principals same send key and same body different keys preserve three original Components with one outer receipt each', async () => {
      const f = await fixture(pool)
      await createDurableStructuredSession(f.call)
      const observed = instrumentPool(pool)
      const a = await sendDurableStructuredInput({ ...sendCall(f, 'same-client-key'), pool: observed.pool })
      assert.equal(a.status, 'COMMITTED')
      // Alias read and Unit discovery each own a read TX; intake adds no nested TX.
      assert.deepEqual(observed.controls, ['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT', 'BEGIN', 'COMMIT'])
      const b = await sendDurableStructuredInput(sendCall(f, 'same-client-key', device()))
      const c = await sendDurableStructuredInput(sendCall(f, 'different-client-key'))
      assert.equal(b.status, 'COMMITTED'); assert.equal(c.status, 'COMMITTED')
      const rows = (await sql(pool, `SELECT i.authenticated_sender,i.client_operation_id,i.body_or_blob_ref,
        m.client_message_id,m.wire_payload_fingerprint,m.wire_fence,m.submitted_at,e.body,e.seq
        FROM durable_runtime.input_components i JOIN durable_runtime.structured_submissions m ON m.input_id=i.id
        JOIN durable_runtime.session_events e ON e.session_id=m.session_id AND e.journal_epoch=m.journal_epoch AND e.seq=m.journal_sequence
        WHERE i.session_id=$1 ORDER BY i.input_seq`, [f.sessionId])).rows
      assert.equal(rows.length, 3)
      assert.equal(new Set(rows.map(row => row.authenticated_sender)).size, 2)
      for (const row of rows) {
        assert.equal(row.body_or_blob_ref.version, 1)
        assert.deepEqual(row.body_or_blob_ref.payload, { body: (sendCall(f, 'shape').params as { body: unknown }).body })
        assert.equal(row.body.kind, 'INPUT_SUBMISSION')
        assert.equal(row.client_message_id, row.client_operation_id)
        assert.equal(row.wire_fence, '1')
      }
      assert.equal((await sessionState(pool, f)).receipts, 4)
      assert.equal(a.wireResult.ok, true)
      if (a.wireResult.ok) {
        assert.equal(a.wireResult.value.submission.dispatchState, 'pending')
        assert.equal(a.wireResult.value.submission.submittedAt, rows[0].submitted_at.getTime())
        assert.equal(a.wireResult.cursor.sequence, Number(rows[0].seq))
      }
    })

    await t.test('send replay ignores changed retry fence and retryUnknown before current lifecycle checks', async () => {
      const f = await fixture(pool)
      await createDurableStructuredSession(f.call)
      const original = sendCall(f, 'synthetic-send-replay')
      const first = await sendDurableStructuredInput(original)
      await sql(pool, "UPDATE durable_runtime.sessions SET lifecycle='CLOSED',session_fence=session_fence+1 WHERE id=$1", [f.sessionId])
      const before = await sessionState(pool, f)
      const params = structuredClone(original.params) as { envelope: { expectedRuntimeFence: number }; retryUnknown?: boolean }
      params.envelope.expectedRuntimeFence = 73; params.retryUnknown = true
      const replay = await sendDurableStructuredInput({ ...original, params })
      assert.equal(replay.status, 'REPLAYED')
      if (first.status !== 'UNCERTAIN') {
        assert.deepEqual(replay.receipt.response, first.receipt.response)
        assert.deepEqual(replay.wireResult, { ...first.wireResult, replayed: true })
      }
      assert.deepEqual(await sessionState(pool, f), before)
    })

    await t.test('actual metadata FK failure rolls back Component Message journal outbox wake and outer receipt', async () => {
      const f = await fixture(pool)
      await createDurableStructuredSession(f.call)
      await sql(pool, "UPDATE durable_runtime.runtime_units SET desired_mode='SUSPENDED',revision=revision+1 WHERE id=$1", [f.unitId])
      const before = await sessionState(pool, f)
      const broken = instrumentPool(pool, async (text, values) => {
        if (text.includes('INSERT INTO durable_runtime.structured_submissions')) { values[1] = randomUUID() }
      })
      await assert.rejects(sendDurableStructuredInput({ ...sendCall(f, 'synthetic-metadata-failure'), pool: broken.pool }), { code: '23503' })
      assert.deepEqual(await sessionState(pool, f), before)
      assert.deepEqual(broken.controls, ['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT', 'BEGIN', 'ROLLBACK'])
    })

    await t.test('actual attachment owner hash rejection leaves every send aggregate unchanged', async () => {
      const f = await fixture(pool)
      await createDurableStructuredSession(f.call)
      const image = await withDurableTransaction(pool, tx => saveAttachmentImage(tx, {
        id: attachmentUploadId(randomUUID()), principal: f.who.principal,
        contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=',
        aliasRoot: '/synthetic/p117/aliases'
      }))
      const body = { kind: 'message', role: 'user', blocks: [{ type: 'image-ref', path: 'synthetic-original-image' }] }
      const before = await sessionState(pool, f)
      const request = sendCall(f, 'synthetic-attachment-failure', f.who, body, [{ blockIndex: 0,
        referenceKind: 'path', originalReference: 'synthetic-original-image', aliasPath: image.aliasPath,
        contentHash: image.contentHash === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64) }])
      await assert.rejects(sendDurableStructuredInput(request))
      assert.deepEqual(await sessionState(pool, f), before)
    })

    await t.test('first-await caller config callback receiver body and attachment tuple changes are detached', async () => {
      const f = await fixture(pool)
      const gate = checkoutGate(pool)
      const receiver = f.call.entries
      let invoked = 0
      Object.assign(receiver, { recordUnitIntent: function (this: typeof receiver, ...args: Parameters<typeof recordUnitIntent>) {
        assert.equal(this, receiver)
        invoked++
        return recordUnitIntent(...args)
      } })
      const create = createDurableStructuredSession({ ...f.call, pool: gate.pool })
      await gate.entered
      Object.assign(f.call.configuration.reservation.tab.payload, { title: 'Changed caller title' })
      Object.assign(f.call.configuration.reservation.originalRequest, { agent: 'codex' })
      Object.assign(f.call.entries, { recordUnitIntent: async () => { throw new Error('Replacement callback must not run') } })
      gate.release()
      assert.equal((await create).status, 'COMMITTED')
      assert.equal(invoked, 1)
      assert.equal((await sql(pool, "SELECT payload->>'title' AS title,launch_request->>'agent' AS agent FROM durable_runtime.catalog_tab_metadata WHERE tab_id=$1", [f.tabId])).rows[0].title, 'Synthetic agent')
      const sendingGate = checkoutGate(pool)
      const image = await withDurableTransaction(pool, tx => saveAttachmentImage(tx, {
        id: attachmentUploadId(randomUUID()), principal: f.who.principal,
        contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=',
        aliasRoot: '/synthetic/p117/aliases'
      }))
      const textBlock = { type: 'text', text: 'Before first await' }
      const imageBlock = { type: 'image-ref', path: 'synthetic-snapshot-image' }
      const body = { kind: 'message', role: 'user', blocks: [textBlock, imageBlock] }
      const tuple = { blockIndex: 1, referenceKind: 'path' as const, originalReference: imageBlock.path,
        aliasPath: image.aliasPath, contentHash: image.contentHash }
      const request = sendCall(f, 'synthetic-snapshot-send', f.who, body, [tuple])
      const send = sendDurableStructuredInput({ ...request, pool: sendingGate.pool })
      await sendingGate.entered
      textBlock.text = 'Changed caller body'
      imageBlock.path = 'changed-reference'
      tuple.aliasPath = 'changed-alias'
      tuple.contentHash = '0'.repeat(64)
      Object.assign(request.workspace, { executionHostId: 'changed-host' })
      Object.assign(request.attachments, { principal: device().principal })
      sendingGate.release()
      assert.equal((await send).status, 'COMMITTED')
      const original = (await sql(pool, "SELECT body_or_blob_ref->'payload'->'body'->'blocks'->0->>'text' AS text FROM durable_runtime.input_components WHERE session_id=$1", [f.sessionId])).rows[0]
      assert.equal(original.text, 'Before first await')
    })
  } finally { await pool.end() }
})
