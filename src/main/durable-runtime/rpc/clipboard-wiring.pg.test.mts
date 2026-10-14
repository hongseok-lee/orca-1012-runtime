import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { readCommittedAttachment } from '../attachments/store.ts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { DurableCatalogReadAdapter } from './public.ts'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher.ts'
import { eraseRpcMethods } from '../../runtime/rpc/core.ts'
import { CLIPBOARD_METHODS } from '../../runtime/rpc/methods/clipboard.ts'
import { fixtureConfig, fixtureRuntime } from './fixture-support.mts'

// Source-only pending public/registry ownership transfer. Reuse SQL19; never migrate/reset/delete.
if (process.env.ORCA_PUBLIC_CLIPBOARD_WIRING_APPROVED !== 'root-wiring-reviewed' ||
    process.env.PGDATABASE !== 'orca_public_clipboard_20261014' ||
    process.env.ORCA_PUBLIC_CLIPBOARD_DB !== process.env.PGDATABASE) {
  throw new Error('Root wiring review and exact preserved clipboard database required')
}

await test('원 clipboard 선언에서 dispatcher·adapter·PG store까지 재생과 committed abort를 유지합니다', async t => {
  const pool = createDurablePool({ database: process.env.PGDATABASE, max: 2 })
  t.after(() => pool.end())
  const identity = (await pool.query(`SELECT current_database() AS database,
    (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
    (SELECT dataset_name FROM durable_runtime.dataset_metadata) AS dataset,
    pg_backend_pid() AS backend_pid,clock_timestamp() AS utc`)).rows[0]
  assert.equal(identity.database, 'orca_public_clipboard_20261014')
  assert.equal(identity.system_identifier, '7696101282789175327'); assert.equal(identity.dataset, 'orca-1012-dev-v1')
  t.diagnostic(JSON.stringify({ ...identity, nodePid: process.pid, authentication: 'synthetic-context' }))
  const ledger = (await pool.query('SELECT * FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length, 19)
  const owner = fixtureRuntime(), methods = eraseRpcMethods(CLIPBOARD_METHODS)
  const aliasRoot = `/synthetic/public-clipboard-wiring/${randomUUID()}`
  const principal = fingerprintAttachmentPrincipal('a'.repeat(64))
  const transport = { authenticatedCallerFingerprint: 'a'.repeat(64), clientKind: 'mobile' as const }
  const config = { ...fixtureConfig(pool), attachments: { aliasRoot } }
  const first = new DurableCatalogReadAdapter(config)
  t.after(() => first.dispose())
  const initial = new RpcDispatcher({ runtime: owner.runtime, methods: first.bind(methods) })
  config.attachments.aliasRoot = '/synthetic/mutated-caller-root'
  const invoke = async (dispatcher: RpcDispatcher, method: string, params: unknown) => {
    const response = await dispatcher.dispatch({ id: randomUUID(), method, params, authToken: '' }, transport)
    if (!response.ok) { assert.fail(response.error.message) }
    return response.result
  }
  const bytes = Buffer.from('synthetic-public-clipboard-wiring-bytes'), contentBase64 = bytes.toString('base64')
  const started = await invoke(initial, 'clipboard.startImageUpload', { expectedBase64Length: contentBase64.length }) as { uploadId: string }
  assert.deepEqual(await invoke(initial, 'clipboard.appendImageUploadChunk', { uploadId: started.uploadId, offset: 0, contentBase64 }),
    { receivedBase64Length: contentBase64.length })
  const saved = await invoke(initial, 'clipboard.saveImageAsTempFile', { contentBase64: 'AA==' })
  assert.equal(typeof saved, 'string'); assert.ok(String(saved).startsWith(`${aliasRoot}/orca-paste-`))
  first.dispose()
  const next = new DurableCatalogReadAdapter({ ...fixtureConfig(pool), attachments: { aliasRoot } })
  t.after(() => next.dispose())
  const recreated = new RpcDispatcher({ runtime: owner.runtime, methods: next.bind(methods) })
  const alias = await invoke(recreated, 'clipboard.commitImageUpload', started)
  assert.equal(alias, `${aliasRoot}/orca-paste-${started.uploadId}.png`)
  assert.equal(await invoke(recreated, 'clipboard.commitImageUpload', started), alias)
  assert.deepEqual(await invoke(recreated, 'clipboard.abortImageUpload', started), { aborted: true })
  const snapshot = await withDurableTransaction(pool, tx => readCommittedAttachment(tx, principal, String(alias)))
  assert.deepEqual(snapshot.contentBytes, bytes)
  assert.equal(snapshot.contentHash, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(snapshot.aliasPath, alias); assert.equal(snapshot.targetConnectionId, null)
  assert.deepEqual((await withDurableTransaction(pool, tx => readCommittedAttachment(tx, principal, String(saved)))).contentBytes, Buffer.from([0]))
  assert.equal((await pool.query('SELECT state FROM durable_runtime.attachment_uploads WHERE id=$1', [started.uploadId])).rows[0].state, 'COMMITTED')
  assert.deepEqual((await pool.query('SELECT * FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  assert.deepEqual(owner.unexpected, [])
})
