import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import path from 'node:path'
import { after, before, test } from 'node:test'
import type { Pool } from 'pg'
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from '../db/connection.ts'
import {
  abortAttachmentUpload, appendAttachmentChunk, commitAttachmentUpload,
  readAttachmentUpload, readCommittedAttachment, saveAttachmentImage, startAttachmentUpload
} from './store.ts'
import { attachmentUploadId, pairedDeviceAttachmentPrincipal, type AttachmentAlias } from './types.ts'

const owner = pairedDeviceAttachmentPrincipal(randomUUID())
const other = pairedDeviceAttachmentPrincipal(randomUUID())
const aliasRoot = '/persistent-p104-verification-aliases'
let pool: Pool

before(async () => {
  assert.ok(process.cwd().startsWith('/tmp/orca-p104-execution'), 'Remote isolated execution directory is required')
  assert.ok(/^orca_p104_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? ''), 'A worker-owned validation database is required')
  pool = createDurablePool({ database: process.env.PGDATABASE, max: 5 })
  // The DB owner applies its migration. This test never invents or installs a schema.
  const result = await withDurableTransaction(pool, (tx) => tx.query<{ ready: boolean }>(
    `SELECT to_regclass('durable_runtime.attachment_uploads') IS NOT NULL AND
     to_regclass('durable_runtime.attachment_aliases') IS NOT NULL AS ready`
  ))
  assert.ok(result.rows[0].ready, 'The delivered attachment schema must be applied first')
})
after(async () => { await pool?.end() })

const transaction = <T>(run: Parameters<typeof withDurableTransaction<T>>[1]): Promise<T> =>
  withDurableTransaction(pool, run)
const fixture = () => ({ id: attachmentUploadId(randomUUID()), principal: owner,
  contentBase64: randomBytes(12).toString('base64'), aliasRoot })

test('ordered chunks survive retry; a conflicting replay or gap fails; incomplete commit preserves OPEN', async () => {
  const f = fixture()
  await transaction((tx) => startAttachmentUpload(tx, { ...f, expectedBase64Length: f.contentBase64.length }))
  const first = f.contentBase64.slice(0, 8)
  await transaction((tx) => appendAttachmentChunk(tx, { ...f, offset: 0, contentBase64: first }))
  const replay = await transaction((tx) => appendAttachmentChunk(tx, { ...f, offset: 0, contentBase64: first }))
  assert.equal(replay.receivedBase64Length, 8)
  await assert.rejects(transaction((tx) => appendAttachmentChunk(tx, { ...f, offset: 0, contentBase64: 'AAAAAAAA' })),
    { code: 'CHUNK_CONFLICT' })
  await assert.rejects(transaction((tx) => appendAttachmentChunk(tx, { ...f, offset: 12, contentBase64: 'AAAA' })),
    { code: 'CHUNK_ORDER' })
  await assert.rejects(transaction((tx) => commitAttachmentUpload(tx, f)), { code: 'UPLOAD_INCOMPLETE' })
  assert.equal((await transaction((tx) => readAttachmentUpload(tx, owner, f.id))).state, 'OPEN')
  await transaction((tx) => appendAttachmentChunk(tx, { ...f, offset: 8, contentBase64: f.contentBase64.slice(8) }))
  const alias = await transaction((tx) => commitAttachmentUpload(tx, f))
  const again = await transaction((tx) => commitAttachmentUpload(tx, f))
  assert.equal(alias.aliasPath, again.aliasPath)
  const snapshot = await transaction((tx) => readCommittedAttachment(tx, owner, alias.aliasPath))
  assert.ok(snapshot.contentBytes.equals(Buffer.from(f.contentBase64, 'base64')))
})

test('single-frame retry preserves original text, zero bytes, and blob-only content deduplication', async () => {
  const first = fixture()
  const alias = await transaction((tx) => saveAttachmentImage(tx, first))
  const second = { ...first, id: attachmentUploadId(randomUUID()) }
  const secondAlias = await transaction((tx) => saveAttachmentImage(tx, second))
  assert.notEqual(alias.aliasPath, secondAlias.aliasPath)
  assert.equal(alias.contentHash, secondAlias.contentHash)
  const empty = { ...fixture(), contentBase64: '' }
  const emptyAlias = await transaction((tx) => saveAttachmentImage(tx, empty))
  assert.equal(emptyAlias.byteLength, 0)
  const nonCanonical = { ...fixture(), contentBase64: 'AA==' }
  await transaction((tx) => saveAttachmentImage(tx, nonCanonical))
  // Both decode to the same byte under the existing parser; they remain different original chunks.
  await assert.rejects(transaction((tx) => saveAttachmentImage(tx, { ...nonCanonical, contentBase64: 'AB==' })),
    { code: 'CHUNK_CONFLICT' })
})

test('different principal cannot inspect, append, commit or resolve the same upload/alias', async () => {
  const f = fixture()
  const alias = await transaction((tx) => saveAttachmentImage(tx, f))
  await assert.rejects(transaction((tx) => readAttachmentUpload(tx, other, f.id)), { code: 'UPLOAD_NOT_FOUND' })
  await assert.rejects(transaction((tx) => appendAttachmentChunk(tx, { ...f, principal: other, offset: 0 })),
    { code: 'UPLOAD_NOT_FOUND' })
  await assert.rejects(transaction((tx) => commitAttachmentUpload(tx, { ...f, principal: other })),
    { code: 'UPLOAD_NOT_FOUND' })
  await assert.rejects(transaction((tx) => readCommittedAttachment(tx, other, alias.aliasPath)),
    { code: 'ALIAS_NOT_FOUND' })
  assert.equal((await transaction((tx) => abortAttachmentUpload(tx, other, f.id))).kind, 'missing')
})

test('rollback after blob/alias/state writes leaves no partial publication and permits retry', async () => {
  const f = fixture()
  await transaction((tx) => startAttachmentUpload(tx, { ...f, expectedBase64Length: f.contentBase64.length }))
  await transaction((tx) => appendAttachmentChunk(tx, { ...f, offset: 0 }))
  await assert.rejects(transaction(async (tx) => {
    await commitAttachmentUpload(tx, f)
    throw new DurableDatabaseError('P104_INJECTED_ROLLBACK')
  }), { code: 'P104_INJECTED_ROLLBACK' })
  const state = await transaction((tx) => readAttachmentUpload(tx, owner, f.id))
  assert.equal(state.state, 'OPEN')
  const publication = await transaction((tx) => tx.query<{ aliases: string; blobs: string }>(
    `SELECT (SELECT count(*) FROM durable_runtime.attachment_aliases WHERE upload_id=$1) AS aliases,
     (SELECT count(*) FROM durable_runtime.attachment_blobs WHERE content_hash=$2) AS blobs`,
    [f.id, createHash('sha256').update(Buffer.from(f.contentBase64, 'base64')).digest('hex')]
  ))
  assert.ok(Number(publication.rows[0].aliases) === 0 && Number(publication.rows[0].blobs) === 0)
  await transaction((tx) => commitAttachmentUpload(tx, f))
})

test('actual writer process death rolls back only its uncommitted chunk, preserving the committed prefix', async () => {
  const f = fixture()
  const child = fork(path.resolve('src/main/durable-runtime/attachments/chunk-crash-writer.ts'), [],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const ready = new Promise<void>((resolve, reject) => {
    child.on('message', (message: { phase: string }) => {
      if (message.phase === 'uncommitted-chunk') resolve()
      else reject(new Error('Writer failed before the intended transaction boundary'))
    })
    child.once('error', reject)
    child.once('exit', () => reject(new Error('Writer exited before its checkpoint')))
  })
  child.send({ id: f.id, principal: owner, first: f.contentBase64.slice(0, 8),
    second: f.contentBase64.slice(8), expectedBase64Length: f.contentBase64.length })
  try {
    await ready
    const exited = once(child, 'exit')
    assert.ok(child.kill('SIGKILL')) // Only this child, whose ownership is established by fork().
    await exited
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  const state = await transaction((tx) => readAttachmentUpload(tx, owner, f.id))
  assert.equal(state.receivedBase64Length, 8)
  await transaction((tx) => appendAttachmentChunk(tx, { ...f, offset: 8, contentBase64: f.contentBase64.slice(8) }))
  const alias = await transaction((tx) => commitAttachmentUpload(tx, f))
  assert.ok((await transaction((tx) => readCommittedAttachment(tx, owner, alias.aliasPath)))
    .contentBytes.equals(Buffer.from(f.contentBase64, 'base64')))
})

test('commit and abort contend on the same row and keep terminal state consistent', async () => {
  const f = fixture()
  await transaction((tx) => startAttachmentUpload(tx, { ...f, expectedBase64Length: f.contentBase64.length }))
  await transaction((tx) => appendAttachmentChunk(tx, { ...f, offset: 0 }))
  const outcomes = await Promise.allSettled([
    transaction((tx) => commitAttachmentUpload(tx, f)),
    transaction((tx) => abortAttachmentUpload(tx, owner, f.id))
  ])
  const state = await transaction((tx) => readAttachmentUpload(tx, owner, f.id))
  if (state.state === 'COMMITTED') {
    assert.ok(outcomes[0].status === 'fulfilled')
    assert.ok(outcomes[1].status === 'fulfilled' && outcomes[1].value.kind === 'committed')
    await transaction((tx) => readCommittedAttachment(tx, owner, (outcomes[0].value as AttachmentAlias).aliasPath))
  } else {
    assert.equal(state.state, 'ABORTED')
    assert.ok(outcomes[0].status === 'rejected' && outcomes[0].reason.code === 'UPLOAD_TERMINAL')
    assert.ok(outcomes[1].status === 'fulfilled' && outcomes[1].value.kind === 'aborted')
  }
})

test('input attachment FK rejects unknown blob relations and abort retains an accepted reference', async () => {
  const f = fixture()
  const alias = await transaction((tx) => saveAttachmentImage(tx, f))
  const ids = Array.from({ length: 5 }, () => randomUUID())
  await transaction(async (tx) => {
    await tx.query(`INSERT INTO durable_runtime.agents(id,provider) VALUES ($1,'verification')`, [ids[0]])
    await tx.query(`INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state)
      VALUES ($1,$1::text,'P1-04 verification','READY')`, [ids[1]])
    await tx.query(`INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES ($1,$2,$3,'OPEN')`,
      [ids[2], ids[0], ids[1]])
    await tx.query(`INSERT INTO durable_runtime.messages(id,session_id,seq,body_or_blob_ref,intake_status)
      VALUES ($1,$2,1,'{}','DURABLE')`, [ids[3], ids[2]])
    await tx.query(`INSERT INTO durable_runtime.input_components
      (id,message_id,session_id,input_seq,authenticated_sender,original_payload_hash,body_or_blob_ref)
      VALUES ($1,$2,$3,1,$4,$5,'{}')`, [ids[4], ids[3], ids[2], owner, alias.contentHash])
  })
  await assert.rejects(transaction((tx) => tx.query(`INSERT INTO durable_runtime.input_attachments
    (input_id,position,blob_ref,content_hash) VALUES ($1,0,$2,$3)`,
    [ids[4], '/nonexistent-p104-alias', alias.contentHash])), { code: '23503' })
  await transaction((tx) => tx.query(`INSERT INTO durable_runtime.input_attachments
    (input_id,position,blob_ref,content_hash) VALUES ($1,0,$2,$3)`, [ids[4], alias.aliasPath, alias.contentHash]))
  assert.equal((await transaction((tx) => abortAttachmentUpload(tx, owner, f.id))).kind, 'committed')
  const referenced = await transaction((tx) => readCommittedAttachment(tx, owner, alias.aliasPath))
  assert.ok(referenced.contentBytes.equals(Buffer.from(f.contentBase64, 'base64')))
})
