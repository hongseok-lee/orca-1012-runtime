import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { before, after, test } from 'node:test'
import type { Pool } from 'pg'
import { createDurablePool } from '../db/connection.ts'
import { pairedDeviceAttachmentPrincipal } from '../attachments/types.ts'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { acceptInput, resolveInputReceipt } from './intake.ts'
import { sealInputMessage } from './seal.ts'
import { inputPayloadHash } from './canonical.ts'
import { InputStoreError } from './types.ts'
import {
  fixture,
  response,
  field,
  counts,
  boundary,
  instrumentPool
} from './verification-fixtures.mts'

let pool: Pool
before(async () => {
  assert.equal(
    process.cwd(),
    process.env.ORCA_INPUT_EXECUTION_ROOT,
    'Owned verifier execution root is required'
  )
  assert.match(process.env.PGDATABASE ?? '', /^orca_p105_[a-z0-9_]+$/)
  pool = createDurablePool({ database: process.env.PGDATABASE, max: 12 })
  const ready = await pool.query(
    "SELECT count(*)::text AS count FROM durable_runtime.schema_migrations WHERE version='012-input-merge-boundary.sql'"
  )
  assert.ok(ready.rows[0].count === '1')
})
after(async () => {
  await pool?.end()
})

test('same identity concurrent receipt, conflicting payload and identical-body different identities preserve originals', async () => {
  const f = await fixture(pool)
  const results = await Promise.all(Array.from({ length: 6 }, () => acceptInput(pool, f.request)))
  assert.ok(results.filter((r) => r.status === 'COMMITTED').length === 1)
  assert.ok(results.filter((r) => r.status === 'REPLAYED').length === 5)
  const first = response(results[0])
  assert.ok(results.every((r) => field(response(r), 'inputId') === field(first, 'inputId')))
  await assert.rejects(
    acceptInput(pool, { ...f.request, payload: { text: 'synthetic conflicting input' } }),
    { code: 'RECEIPT_PAYLOAD_CONFLICT' }
  )
  const second = response(await acceptInput(pool, { ...f.request, operationKey: randomUUID() }))
  assert.ok(field(first, 'inputId') !== field(second, 'inputId'))
  assert.ok(field(first, 'messageId') === field(second, 'messageId'))
  const observed = await counts(pool, f.request.authority, f.unitId)
  assert.ok(
    observed.inputs === '2' &&
      observed.receipts === '2' &&
      observed.messages === '1' &&
      observed.journal === '2' &&
      observed.outbox === '2' &&
      observed.intent === '1'
  )
  const replay = response(await acceptInput(pool, f.request))
  assert.ok(field(replay, 'messageRevision') === field(first, 'messageRevision'))
})

test('ACK-loss replay survives fence/lifecycle/closed terminal and does not expose another principal receipt', async () => {
  const f = await fixture(pool)
  const request = {
    ...f.request,
    authority: {
      ...f.request.authority,
      scope: { kind: 'TERMINAL' as const, terminalHandle: f.terminalHandle }
    }
  }
  const original = response(await acceptInput(pool, request))
  await pool.query(
    "UPDATE durable_runtime.sessions SET session_fence=session_fence+1,lifecycle='CLOSED' WHERE id=$1",
    [request.authority.sessionId]
  )
  await pool.query(
    "UPDATE durable_runtime.tabs SET lifecycle='CLOSED',closed_at=clock_timestamp() WHERE terminal_handle=$1",
    [f.terminalHandle]
  )
  await pool.query("UPDATE durable_runtime.runtime_units SET desired_mode='DELETED' WHERE id=$1", [
    f.unitId
  ])
  const replayed = await acceptInput(pool, request)
  assert.ok(
    replayed.status === 'REPLAYED' &&
      field(response(replayed), 'inputId') === field(original, 'inputId')
  )
  assert.ok((await resolveInputReceipt(pool, request)).status === 'FOUND')
  const outsider = {
    ...request,
    authority: { ...request.authority, principal: pairedDeviceAttachmentPrincipal(randomUUID()) }
  }
  assert.ok((await resolveInputReceipt(pool, outsider)).status === 'NOT_FOUND')
  await assert.rejects(acceptInput(pool, outsider), { code: 'INPUT_SESSION_CLOSED' })
  const denied = {
    ...request,
    authority: { ...request.authority, sessionId: logicalId('session', randomUUID()) }
  }
  await assert.rejects(resolveInputReceipt(pool, denied), { code: 'INPUT_SCOPE_DENIED' })
  assert.ok((await counts(pool, request.authority, f.unitId)).inputs === '1')
})

test('100 GENERAL originals retain 100 receipts in one pending Message and a complete immutable seal', async () => {
  const f = await fixture(pool, 'RUNNING')
  let last = response(await acceptInput(pool, f.request))
  for (let i = 1; i < 100; i++) {
    last = response(
      await acceptInput(pool, {
        ...f.request,
        operationKey: randomUUID(),
        payload: { text: `synthetic input ${i}` }
      })
    )
  }
  const observed = await counts(pool, f.request.authority, f.unitId)
  assert.ok(
    observed.inputs === '100' &&
      observed.receipts === '100' &&
      observed.messages === '1' &&
      observed.intent === '0'
  )
  const claim = {
    authority: f.request.authority,
    messageId: logicalId('message', field(last, 'messageId')),
    expectedRevision: counter('message-revision', field(last, 'messageRevision'))
  }
  const sealed = await sealInputMessage(pool, claim)
  assert.ok(sealed.payloadHash === inputPayloadHash(sealed.payload))
  assert.ok(
    sealed.payload !== null && typeof sealed.payload === 'object' && !Array.isArray(sealed.payload)
  )
  assert.ok(Array.isArray(sealed.payload.components) && sealed.payload.components.length === 100)
  const same = await sealInputMessage(pool, claim)
  assert.ok(same.payloadHash === sealed.payloadHash)
  const next = response(await acceptInput(pool, { ...f.request, operationKey: randomUUID() }))
  assert.ok(field(next, 'messageId') !== claim.messageId)
  const persisted = await pool.query(
    'SELECT sealed_revision,sealed_payload_hash,intake_status,merge_closed FROM durable_runtime.messages WHERE id=$1',
    [claim.messageId]
  )
  assert.ok(
    persisted.rows[0].sealed_payload_hash === sealed.payloadHash &&
      persisted.rows[0].merge_closed &&
      persisted.rows[0].intake_status === 'DISPATCH_INTENT'
  )
})

test('append versus seal serializes on Session and cannot revise a sealed payload', async () => {
  const f = await fixture(pool)
  const first = response(await acceptInput(pool, f.request))
  const claim = {
    authority: f.request.authority,
    messageId: logicalId('message', field(first, 'messageId')),
    expectedRevision: counter('message-revision', field(first, 'messageRevision'))
  }
  const [sealed, appended] = await Promise.allSettled([
    sealInputMessage(pool, claim),
    acceptInput(pool, { ...f.request, operationKey: randomUUID() })
  ])
  assert.ok(appended.status === 'fulfilled')
  const next = response(appended.value)
  if (sealed.status === 'fulfilled') {
    assert.ok(field(next, 'messageId') !== claim.messageId)
    assert.ok((await sealInputMessage(pool, claim)).payloadHash === sealed.value.payloadHash)
  } else {
    assert.ok(
      sealed.reason.code === 'INPUT_REVISION_CONFLICT' &&
        field(next, 'messageId') === claim.messageId
    )
    const final = await sealInputMessage(pool, {
      ...claim,
      expectedRevision: counter('message-revision', field(next, 'messageRevision'))
    })
    assert.ok(final.payloadHash === inputPayloadHash(final.payload))
  }
})

test('command and raw semantic boundaries persist through fresh DB connection; history/query does not wake', async () => {
  const f = await fixture(pool)
  const general = response(await acceptInput(pool, f.request))
  const command = response(
    await acceptInput(pool, { ...f.request, operationKey: randomUUID(), inputKind: 'COMMAND' })
  )
  const later = response(await acceptInput(pool, { ...f.request, operationKey: randomUUID() }))
  assert.ok(
    field(general, 'messageId') !== field(command, 'messageId') &&
      field(command, 'messageId') !== field(later, 'messageId')
  )
  await boundary(pool, f.request.authority)
  const fresh = createDurablePool({ database: process.env.PGDATABASE, max: 1 })
  try {
    const newest = response(await acceptInput(fresh, { ...f.request, operationKey: randomUUID() }))
    assert.ok(field(newest, 'messageId') !== field(later, 'messageId'))
    await pool.query(
      "UPDATE durable_runtime.messages SET intake_status='CANCELLED',cancel_revision=1,cancel_requested_at=clock_timestamp() WHERE id=$1",
      [field(newest, 'messageId')]
    )
    await pool.query(
      "UPDATE durable_runtime.runtime_units SET desired_mode='SUSPENDED' WHERE id=$1",
      [f.unitId]
    )
    const before = await pool.query(
      'SELECT intent_revision,last_work_event_at,reconcile_due_at FROM durable_runtime.runtime_units WHERE id=$1',
      [f.unitId]
    )
    assert.ok((await boundary(fresh, f.request.authority)) === null)
    await resolveInputReceipt(fresh, f.request)
    assert.ok(
      (await resolveInputReceipt(fresh, { ...f.request, operationKey: randomUUID() })).status ===
        'NOT_FOUND'
    )
    const after = await pool.query(
      'SELECT desired_mode,intent_revision,last_work_event_at,reconcile_due_at FROM durable_runtime.runtime_units WHERE id=$1',
      [f.unitId]
    )
    assert.ok(
      after.rows[0].desired_mode === 'SUSPENDED' &&
        after.rows[0].intent_revision === before.rows[0].intent_revision
    )
    assert.ok(
      after.rows[0].last_work_event_at.getTime() === before.rows[0].last_work_event_at.getTime() &&
        after.rows[0].reconcile_due_at.getTime() === before.rows[0].reconcile_due_at.getTime()
    )
    await assert.rejects(
      sealInputMessage(fresh, {
        authority: f.request.authority,
        messageId: logicalId('message', field(newest, 'messageId')),
        expectedRevision: counter('message-revision', field(newest, 'messageRevision'))
      }),
      { code: 'INPUT_MESSAGE_NOT_PENDING' }
    )
  } finally {
    await fresh.end()
  }
})

test('failure after journal/outbox/wake writes rolls every intake effect back without a receipt', async () => {
  const f = await fixture(pool)
  const interrupted = instrumentPool(pool, {
    beforeQuery(sql) {
      if (sql.startsWith('INSERT INTO durable_runtime.rpc_receipts')) {
        throw new InputStoreError('INPUT_VERIFICATION_ROLLBACK')
      }
    }
  })
  await assert.rejects(acceptInput(interrupted, f.request), { code: 'INPUT_VERIFICATION_ROLLBACK' })
  const observed = await counts(pool, f.request.authority, f.unitId)
  assert.ok(
    observed.inputs === '0' &&
      observed.messages === '0' &&
      observed.receipts === '0' &&
      observed.journal === '0' &&
      observed.outbox === '0' &&
      observed.intent === '0'
  )
  const unit = await pool.query(
    'SELECT desired_mode FROM durable_runtime.runtime_units WHERE id=$1',
    [f.unitId]
  )
  assert.ok(unit.rows[0].desired_mode === 'SUSPENDED')
  await acceptInput(pool, f.request)
  assert.ok((await counts(pool, f.request.authority, f.unitId)).inputs === '1')
})

test('membership change after discovery is effect-free and never locks a different Unit out of order', async () => {
  const f = await fixture(pool)
  const newUnit = randomUUID()
  await pool.query(
    "INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES ($1,'SUSPENDED','ABSENT')",
    [newUnit]
  )
  let unitLockQueries = 0
  const moved = instrumentPool(pool, {
    async onConnect(number) {
      if (number === 2) {
        await pool.query(
          'UPDATE durable_runtime.runtime_members SET runtime_unit_id=$1 WHERE session_id=$2',
          [newUnit, f.request.authority.sessionId]
        )
      }
    },
    beforeQuery(sql) {
      if (sql === 'SELECT id FROM durable_runtime.runtime_units WHERE id=$1 FOR UPDATE') {
        unitLockQueries++
      }
    }
  })
  await assert.rejects(acceptInput(moved, f.request), { code: 'INPUT_MEMBERSHIP_CHANGED' })
  assert.ok(unitLockQueries === 1)
  const observed = await counts(pool, f.request.authority, f.unitId)
  assert.ok(observed.inputs === '0' && observed.receipts === '0' && observed.intent === '0')
  const unchanged = await pool.query(
    'SELECT intent_revision FROM durable_runtime.runtime_units WHERE id=$1',
    [newUnit]
  )
  assert.ok(unchanged.rows[0].intent_revision === '0')
})
