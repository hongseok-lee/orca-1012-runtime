import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { readCommittedAttachment, startAttachmentUpload } from '../attachments/store.ts'
import { attachmentUploadId, fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { createCatalogClipboardRpc } from './clipboard.ts'
import type { CatalogClipboardMethod } from './clipboard.ts'
import { captureDurableCatalogReadConfig } from './config.ts'
import { fixtureConfig, fixtureContext, fixtureRuntime } from './fixture-support.mts'

if (process.env.ORCA_PUBLIC_CLIPBOARD_APPROVED !== 'root-source-reviewed' ||
    !process.env.ORCA_PUBLIC_CLIPBOARD_DB || process.env.ORCA_PUBLIC_CLIPBOARD_DB !== process.env.PGDATABASE ||
    !/^orca_public_clipboard_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? '')) {
  throw new Error('Root review and exact isolated clipboard database required')
}

// One callback, one pre-provisioned owned DB. No migration/reset/delete or real device auth.
await test('공개 handler의 PG 재생·소유·commit·abort 경계와 원 bytes 및 첨부 참조를 유지합니다', async t => {
  const pool = createDurablePool({ database: process.env.PGDATABASE, max: 2 })
  t.after(() => pool.end())
  const identity = (await pool.query('SELECT current_database() AS database,version() AS version,pg_backend_pid() AS backend_pid,clock_timestamp() AS utc')).rows[0]
  assert.equal(identity.database, process.env.ORCA_PUBLIC_CLIPBOARD_DB)
  t.diagnostic(JSON.stringify({ ...identity, nodePid: process.pid, authentication: 'synthetic-context' }))
  const ledger = (await pool.query('SELECT * FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length, 19)
  const owner = fixtureRuntime(), context = fixtureContext(owner.runtime)
  const principal = fingerprintAttachmentPrincipal('a'.repeat(64))
  const config = captureDurableCatalogReadConfig(fixtureConfig(pool))
  const aliasRoot = `/synthetic/public-clipboard/${randomUUID()}`
  const handler = createCatalogClipboardRpc(config, { aliasRoot })
  const invoke = (method: CatalogClipboardMethod, params: unknown) => handler(method, params, context)
  const bytes = Buffer.from('synthetic-public-clipboard-bytes'), contentBase64 = bytes.toString('base64')
  const first = contentBase64.slice(0, 8), rest = contentBase64.slice(8)
  const { uploadId } = await invoke('clipboard.startImageUpload', { expectedBase64Length: contentBase64.length }) as { uploadId: string }
  assert.deepEqual(await invoke('clipboard.appendImageUploadChunk', { uploadId, offset: 0, contentBase64: first }), { receivedBase64Length: 8 })
  assert.deepEqual(await invoke('clipboard.appendImageUploadChunk', { uploadId, offset: 8, contentBase64: rest }), { receivedBase64Length: contentBase64.length })
  assert.deepEqual(await invoke('clipboard.appendImageUploadChunk', { uploadId, offset: 0, contentBase64: first }), { receivedBase64Length: 8 })
  await assert.rejects(invoke('clipboard.appendImageUploadChunk', { uploadId, offset: 0, contentBase64: 'AAAAAAAA' }), { code: 'CHUNK_CONFLICT' })

  const next = createCatalogClipboardRpc(config, { aliasRoot })
  const alias = await next('clipboard.commitImageUpload', { uploadId }, context)
  assert.equal(alias, `${aliasRoot}/orca-paste-${uploadId}.png`)
  assert.equal(await invoke('clipboard.commitImageUpload', { uploadId }), alias)
  const snapshot = await withDurableTransaction(pool, tx => readCommittedAttachment(tx, principal, String(alias)))
  assert.deepEqual(snapshot.contentBytes, bytes)
  assert.equal(snapshot.contentHash, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(snapshot.aliasPath, alias); assert.equal(snapshot.targetConnectionId, null)
  const chunks = (await pool.query('SELECT chunk_offset::text,content_base64 FROM durable_runtime.attachment_upload_chunks WHERE upload_id=$1 ORDER BY chunk_offset', [uploadId])).rows
  assert.deepEqual(chunks, [{ chunk_offset: '0', content_base64: first }, { chunk_offset: '8', content_base64: rest }])
  const foreign = fixtureContext(owner.runtime, { authenticatedCallerFingerprint: 'b'.repeat(64) })
  await assert.rejects(next('clipboard.commitImageUpload', { uploadId }, foreign), { code: 'UPLOAD_NOT_FOUND' })
  await assert.rejects(next('clipboard.appendImageUploadChunk', { uploadId, offset: 0, contentBase64: first }, foreign), { code: 'UPLOAD_NOT_FOUND' })
  assert.deepEqual(await next('clipboard.abortImageUpload', { uploadId }, foreign), { aborted: true })
  assert.deepEqual(await next('clipboard.abortImageUpload', { uploadId: randomUUID() }, foreign), { aborted: true })

  const saved = await invoke('clipboard.saveImageAsTempFile', { contentBase64: 'AA==' })
  assert.equal(typeof saved, 'string')
  assert.deepEqual((await withDurableTransaction(pool, tx => readCommittedAttachment(tx, principal, String(saved)))).contentBytes, Buffer.from([0]))
  const incomplete = await invoke('clipboard.startImageUpload', { expectedBase64Length: 4 }) as { uploadId: string }
  await assert.rejects(invoke('clipboard.commitImageUpload', incomplete), { code: 'UPLOAD_INCOMPLETE' })
  assert.deepEqual(await invoke('clipboard.abortImageUpload', incomplete), { aborted: true })
  assert.deepEqual(await invoke('clipboard.abortImageUpload', incomplete), { aborted: true })
  await assert.rejects(invoke('clipboard.commitImageUpload', incomplete), { code: 'UPLOAD_TERMINAL' })
  const sshId = attachmentUploadId(randomUUID())
  await withDurableTransaction(pool, tx => startAttachmentUpload(tx, { id: sshId, principal,
    expectedBase64Length: 0, targetConnectionId: 'synthetic-ssh' }))
  await assert.rejects(invoke('clipboard.commitImageUpload', { uploadId: sshId }))
  assert.equal((await pool.query('SELECT state FROM durable_runtime.attachment_uploads WHERE id=$1', [sshId])).rows[0].state, 'OPEN')

  const [agent, workspace, session, message, input] = Array.from({ length: 5 }, () => randomUUID())
  await withDurableTransaction(pool, async tx => {
    await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'verification')", [agent])
    await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'verification','READY')", [workspace, `synthetic:${workspace}`])
    await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [session, agent, workspace])
    await tx.query("INSERT INTO durable_runtime.messages(id,session_id,seq,body_or_blob_ref,intake_status) VALUES($1,$2,1,'{}','DURABLE')", [message, session])
    await tx.query(`INSERT INTO durable_runtime.input_components(id,message_id,session_id,input_seq,authenticated_sender,original_payload_hash,body_or_blob_ref)
      VALUES($1,$2,$3,1,$4,$5,'{}')`, [input, message, session, principal, 'c'.repeat(64)])
    await tx.query('INSERT INTO durable_runtime.input_attachments(input_id,position,blob_ref,content_hash) VALUES($1,0,$2,$3)', [input, alias, snapshot.contentHash])
  })
  const originalReference = (await pool.query('SELECT * FROM durable_runtime.input_attachments WHERE input_id=$1', [input])).rows
  assert.deepEqual(await invoke('clipboard.abortImageUpload', { uploadId }), { aborted: true })
  assert.deepEqual((await pool.query('SELECT * FROM durable_runtime.input_attachments WHERE input_id=$1', [input])).rows, originalReference)
  assert.deepEqual((await withDurableTransaction(pool, tx => readCommittedAttachment(tx, principal, String(alias)))).contentBytes, bytes)
  assert.equal((await pool.query('SELECT state FROM durable_runtime.attachment_uploads WHERE id=$1', [uploadId])).rows[0].state, 'COMMITTED')
  assert.deepEqual((await pool.query('SELECT * FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  assert.deepEqual(owner.unexpected, [])
})
