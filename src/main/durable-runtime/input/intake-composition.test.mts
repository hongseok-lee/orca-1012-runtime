// One new owned PG boundary. Synthetic outer draft/Tab metadata, not an adapter or auth gate.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { before, after, test } from 'node:test'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import {
  createDurablePool,
  withDurableTransaction,
  DurableDatabaseError
} from '../db/connection.ts'
import { runDurableMutation } from '../db/atomic.ts'
import { lockAggregates } from '../db/locks.ts'
import { saveAttachmentImage } from '../attachments/store.ts'
import { attachmentUploadId, type AttachmentAlias } from '../attachments/types.ts'
import { acceptInputInTransaction } from './intake.ts'
import { prepareInputRequest } from './canonical.ts'
import { fixture, counts } from './verification-fixtures.mts'
import type { InputRequest } from './types.ts'

let pool: Pool
before(async () => {
  assert.equal(process.cwd(), process.env.ORCA_INPUT_COMPOSITION_EXECUTION_ROOT)
  assert.match(process.env.PGDATABASE ?? '', /^orca_p117_intake_[a-z0-9_]+$/)
  pool = createDurablePool({ database: process.env.PGDATABASE, max: 4 })
  const ready = await pool.query(
    "SELECT count(*)::text AS n FROM durable_runtime.schema_migrations WHERE version='012-input-merge-boundary.sql'"
  )
  assert.equal(ready.rows[0].n, '1')
})
after(async () => {
  await pool?.end()
})

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

// This owned client's first actual scope SELECT pauses after SQL succeeds. Lock markers are real.
function pausedPool(base: Pool, entered: ReturnType<typeof gate>, released: ReturnType<typeof gate>) {
  const controls: string[] = []
  let paused = false
  const wrapped = new Proxy(base, {
    get(target, key) {
      if (key === 'connect') {
        return async () => {
          const client = await target.connect()
          return new Proxy(client, {
            get(connection, property) {
              if (property === 'query') {
                return async (sql: unknown, ...args: unknown[]) => {
                  const text = String(sql)
                  if (/^(?:BEGIN|COMMIT|ROLLBACK)\b/.test(text)) {
                    controls.push(text)
                  }
                  const result = await Reflect.apply(connection.query, connection, [sql, ...args])
                  if (!paused && text === 'SELECT id FROM durable_runtime.sessions WHERE id=$1') {
                    paused = true
                    entered.release()
                    await released.promise
                  }
                  return result
                }
              }
              const value = Reflect.get(connection, property)
              return typeof value === 'function' ? value.bind(connection) : value
            }
          })
        }
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  return { wrapped, controls }
}

test('same-TX intake requires actual locks/membership and rolls original snapshot plus outer draft/metadata back', { timeout: 15000 }, async () => {
  const f = await fixture(pool)
  const unitId = logicalId('runtime-unit', f.unitId)
  // Exact original runtime/profile relationship. No attempt/provider is needed for intake.
  await pool.query(
    "INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0)",
    [unitId]
  )
  await withDurableTransaction(pool, async (tx) => {
    await assert.rejects(acceptInputInTransaction(tx, f.request, unitId), {
      code: 'INPUT_SESSION_LOCK_REQUIRED'
    })
  })
  await withDurableTransaction(pool, async (tx) => {
    await lockAggregates(tx, { sessionIds: [f.request.authority.sessionId] })
    assert.ok(tx.isLockHeld(1, f.request.authority.sessionId))
    assert.equal(tx.isLockHeld(2, unitId), false)
    await assert.rejects(acceptInputInTransaction(tx, f.request, unitId), {
      code: 'INPUT_UNIT_UNAVAILABLE'
    })
  })
  const other = await fixture(pool)
  await withDurableTransaction(pool, async (tx) => {
    const otherUnit = logicalId('runtime-unit', other.unitId)
    await lockAggregates(tx, {
      sessionIds: [f.request.authority.sessionId],
      runtimeUnitIds: [otherUnit]
    })
    assert.ok(tx.isLockHeld(1, f.request.authority.sessionId) && tx.isLockHeld(2, otherUnit))
    await assert.rejects(acceptInputInTransaction(tx, f.request, otherUnit), {
      code: 'INPUT_MEMBERSHIP_CHANGED'
    })
  })

  const aliases: AttachmentAlias[] = []
  for (let index = 0; index < 2; index++) {
    aliases.push(await withDurableTransaction(pool, (tx) => saveAttachmentImage(tx, {
      id: attachmentUploadId(randomUUID()),
      principal: f.request.authority.principal,
      contentBase64: Buffer.from(`synthetic composition image ${index}`).toString('base64'),
      aliasRoot: '/p117-intake-verification'
    })))
  }
  aliases.sort((a, b) => a.aliasPath < b.aliasPath ? 1 : -1)
  const payload = { text: 'synthetic original draft', nested: { order: ['first', 'second'] } }
  const request: InputRequest = {
    ...f.request,
    payload,
    attachments: [aliases[0], aliases[1], aliases[0]].map(({ aliasPath, contentHash }) => ({ aliasPath, contentHash }))
  }
  const fixed = prepareInputRequest(request)
  const attachments = structuredClone(request.attachments)
  const tabBefore = await pool.query('SELECT pane_key,revision FROM durable_runtime.tabs WHERE terminal_handle=$1', [f.terminalHandle])
  const sessionBefore = await pool.query('SELECT next_input_seq,next_message_seq,next_event_seq,revision FROM durable_runtime.sessions WHERE id=$1', [fixed.request.authority.sessionId])
  const unitBefore = await pool.query('SELECT desired_mode,intent_revision,revision,reconcile_due_at,last_work_event_at FROM durable_runtime.runtime_units WHERE id=$1', [unitId])
  const entered = gate(), released = gate()
  const traced = pausedPool(pool, entered, released)
  let callbackEntries = 0
  const pending = runDurableMutation(traced.wrapped, {
    ...fixed.identity,
    key: { ...fixed.identity.key, method: 'verification.outer-intake', operationKey: randomUUID() },
    locks: { sessionIds: [fixed.request.authority.sessionId], runtimeUnitIds: [unitId] }
  }, async (tx) => {
    callbackEntries++
    assert.ok(tx.isLockHeld(1, fixed.request.authority.sessionId) && tx.isLockHeld(2, unitId))
    await tx.query(
      "INSERT INTO durable_runtime.legacy_drafts(terminal_handle,paired_device_id,floor_generation,draft_revision,body,attachments,lifecycle,updated_at) VALUES($1,$2,0,1,$3,$4,'OPEN',clock_timestamp())",
      [f.terminalHandle, fixed.request.authority.principal, JSON.stringify(fixed.request.payload), JSON.stringify(attachments)]
    )
    await tx.query("UPDATE durable_runtime.tabs SET pane_key='synthetic outer metadata',revision=revision+1 WHERE terminal_handle=$1", [f.terminalHandle])
    const accepted = await acceptInputInTransaction(tx, request, unitId)
    assert.deepEqual(Object.keys(accepted).sort(), ['inputId','inputSequence','messageId','messageSequence','messageRevision','runtimeUnitId','intentRevision','submissionEventId','journalSequence'].sort())
    assert.equal(accepted.runtimeUnitId, unitId)
    assert.equal(accepted.inputSequence, counter('sequence:input', '1'))
    assert.equal(accepted.messageSequence, counter('sequence:message', '1'))
    assert.equal(accepted.messageRevision, counter('message-revision', '1'))
    assert.equal(accepted.journalSequence, counter('sequence:journal', '1'))
    assert.equal(accepted.intentRevision, '1')
    for (const alias of aliases) assert.ok(tx.isLockHeld(6, alias.aliasPath))
    const input = await tx.query('SELECT original_payload_hash,body_or_blob_ref,client_operation_id FROM durable_runtime.input_components WHERE id=$1', [accepted.inputId])
    assert.equal(input.rows[0].original_payload_hash, fixed.identity.payloadHash)
    assert.deepEqual(input.rows[0].body_or_blob_ref, fixed.original)
    assert.equal(input.rows[0].client_operation_id, fixed.request.operationKey)
    const message = await tx.query('SELECT revision,input_kind,merge_closed,intake_status,body_or_blob_ref FROM durable_runtime.messages WHERE id=$1', [accepted.messageId])
    assert.equal(message.rows[0].revision, '1')
    assert.equal(message.rows[0].input_kind, 'GENERAL')
    assert.equal(message.rows[0].merge_closed, false)
    assert.equal(message.rows[0].intake_status, 'DURABLE')
    assert.deepEqual(message.rows[0].body_or_blob_ref.components[0].original, fixed.original)
    const receipt = await tx.query('SELECT count(*)::text AS n FROM durable_runtime.rpc_receipts WHERE principal_id=$1', [fixed.request.authority.principal])
    assert.equal(receipt.rows[0].n, '0')
    const refs = await tx.query('SELECT blob_ref,content_hash FROM durable_runtime.input_attachments WHERE input_id=$1 ORDER BY position', [accepted.inputId])
    assert.deepEqual(refs.rows.map(({ blob_ref, content_hash }) => ({ aliasPath: blob_ref, contentHash: content_hash })), attachments)
    const event = await tx.query('SELECT source_key,seq,body FROM durable_runtime.session_events WHERE event_id=$1', [accepted.submissionEventId])
    assert.deepEqual(JSON.parse(event.rows[0].source_key), [
      'v1', fixed.request.authority.sessionId, 'producer', 'INPUT_SUBMISSION',
      fixed.request.authority.sessionId, 'durable-input-v1', '1'
    ])
    assert.equal(event.rows[0].seq, '1')
    assert.deepEqual(event.rows[0].body, { kind: 'INPUT_SUBMISSION', inputId: accepted.inputId, inputSequence: accepted.inputSequence, messageId: accepted.messageId, messageSequence: accepted.messageSequence, messageRevision: accepted.messageRevision, originalPayloadHash: fixed.identity.payloadHash })
    const outbox = await tx.query('SELECT event FROM durable_runtime.outbox_events WHERE aggregate_id=$1', [unitId])
    assert.equal(outbox.rows.length, 1)
    assert.deepEqual(outbox.rows[0].event, { kind: 'RECONCILE_INPUT', runtimeUnitId: unitId, sessionId: fixed.request.authority.sessionId, inputId: accepted.inputId, inputSequence: accepted.inputSequence, journalEventId: accepted.submissionEventId, intentRevision: accepted.intentRevision })
    const wake = await tx.query('SELECT desired_mode,reconcile_due_at,last_work_event_at FROM durable_runtime.runtime_units WHERE id=$1', [unitId])
    assert.equal(wake.rows[0].desired_mode, 'RUNNING')
    assert.ok(wake.rows[0].reconcile_due_at && wake.rows[0].last_work_event_at)
    throw new DurableDatabaseError('OWNED_INTAKE_ROLLBACK')
  })
  const rejected = assert.rejects(pending, { code: 'OWNED_INTAKE_ROLLBACK' })
  // The entry has reached its first real await after preparing its own original snapshot.
  try {
    await Promise.race([
      entered.promise,
      pending.then(() => { throw new Error('NO_OWNED_SQL_PAUSE') })
    ])
    payload.text = 'mutated after first await'
    payload.nested.order.reverse()
    request.authority.sessionId = logicalId('session', other.request.authority.sessionId)
    request.authority.scope = { kind: 'TERMINAL', terminalHandle: other.terminalHandle }
    request.operationKey = randomUUID()
    request.method = 'mutated.method'
    request.attachments[0].contentHash = '0'.repeat(64)
    request.attachments.reverse()
  } finally {
    released.release()
  }
  await rejected
  assert.equal(callbackEntries, 1)
  assert.deepEqual(traced.controls, ['BEGIN ISOLATION LEVEL READ COMMITTED', 'ROLLBACK'])
  assert.deepEqual(await counts(pool, fixed.request.authority, unitId), { inputs:'0', messages:'0', receipts:'0', journal:'0', outbox:'0', intent:'0' })
  const draft = await pool.query('SELECT count(*)::text AS n FROM durable_runtime.legacy_drafts WHERE terminal_handle=$1', [f.terminalHandle])
  assert.equal(draft.rows[0].n, '0')
  assert.deepEqual((await pool.query('SELECT pane_key,revision FROM durable_runtime.tabs WHERE terminal_handle=$1', [f.terminalHandle])).rows, tabBefore.rows)
  assert.deepEqual((await pool.query('SELECT next_input_seq,next_message_seq,next_event_seq,revision FROM durable_runtime.sessions WHERE id=$1', [fixed.request.authority.sessionId])).rows, sessionBefore.rows)
  assert.deepEqual((await pool.query('SELECT desired_mode,intent_revision,revision,reconcile_due_at,last_work_event_at FROM durable_runtime.runtime_units WHERE id=$1', [unitId])).rows, unitBefore.rows)
})
