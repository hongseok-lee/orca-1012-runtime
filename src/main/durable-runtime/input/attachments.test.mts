import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { before, after, test } from 'node:test'
import type { Pool } from 'pg'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import {
  saveAttachmentImage,
  startAttachmentUpload,
  reserveAttachmentAlias,
  readCommittedAttachment,
  abortAttachmentUpload
} from '../attachments/store.ts'
import { attachmentUploadId, pairedDeviceAttachmentPrincipal } from '../attachments/types.ts'
import type { AttachmentAlias } from '../attachments/types.ts'
import { materializeAttachment } from '../attachments/materializer.ts'
import { acceptInput } from './intake.ts'
import { fixture, response, field, counts } from './verification-fixtures.mts'

let pool: Pool
before(() => {
  assert.equal(
    process.cwd(),
    process.env.ORCA_INPUT_EXECUTION_ROOT,
    'Owned verifier execution root is required'
  )
  assert.match(process.env.PGDATABASE ?? '', /^orca_p105_[a-z0-9_]+$/)
  pool = createDurablePool({ database: process.env.PGDATABASE, max: 4 })
})
after(async () => {
  await pool?.end()
})

test('new intake rejects incomplete or foreign attachments; sorted locks preserve duplicate positions and references after abort/materialization', async () => {
  const f = await fixture(pool)
  const root = '/p105-verification-aliases'
  const pendingId = attachmentUploadId(randomUUID())
  await withDurableTransaction(pool, (tx) =>
    startAttachmentUpload(tx, {
      id: pendingId,
      principal: f.request.authority.principal,
      expectedBase64Length: 4
    })
  )
  await assert.rejects(
    acceptInput(pool, {
      ...f.request,
      attachments: [
        { aliasPath: reserveAttachmentAlias(root, pendingId), contentHash: '0'.repeat(64) }
      ]
    }),
    { code: 'ALIAS_NOT_FOUND' }
  )
  const foreign = await withDurableTransaction(pool, (tx) =>
    saveAttachmentImage(tx, {
      id: attachmentUploadId(randomUUID()),
      principal: pairedDeviceAttachmentPrincipal(randomUUID()),
      contentBase64: Buffer.from('synthetic foreign image').toString('base64'),
      aliasRoot: root
    })
  )
  await assert.rejects(
    acceptInput(pool, {
      ...f.request,
      attachments: [{ aliasPath: foreign.aliasPath, contentHash: foreign.contentHash }]
    }),
    { code: 'ALIAS_NOT_FOUND' }
  )
  assert.ok((await counts(pool, f.request.authority, f.unitId)).inputs === '0')
  const aliases: AttachmentAlias[] = []
  for (let index = 0; index < 2; index++) {
    aliases.push(
      await withDurableTransaction(pool, (tx) =>
        saveAttachmentImage(tx, {
          id: attachmentUploadId(randomUUID()),
          principal: f.request.authority.principal,
          contentBase64: Buffer.from(`synthetic owned image ${index}`).toString('base64'),
          aliasRoot: root
        })
      )
    )
  }
  aliases.sort((a, b) => (a.aliasPath < b.aliasPath ? 1 : -1))
  const ordered = [aliases[0], aliases[1], aliases[0]].map(({ aliasPath, contentHash }) => ({
    aliasPath,
    contentHash
  }))
  const accepted = response(await acceptInput(pool, { ...f.request, attachments: ordered }))
  const rows = await pool.query(
    'SELECT position,blob_ref,content_hash FROM durable_runtime.input_attachments WHERE input_id=$1 ORDER BY position',
    [field(accepted, 'inputId')]
  )
  assert.ok(
    rows.rows.length === 3 &&
      rows.rows.every(
        (row, index) =>
          row.position === String(index) &&
          row.blob_ref === ordered[index].aliasPath &&
          row.content_hash === ordered[index].contentHash
      )
  )
  for (const alias of aliases) {
    const aborted = await withDurableTransaction(pool, (tx) =>
      abortAttachmentUpload(tx, f.request.authority.principal, alias.uploadId)
    )
    assert.ok(aborted.kind === 'committed')
  }
  const directory = await mkdtemp(path.join(process.cwd(), 'input-materialization-'))
  try {
    const snapshot = await withDurableTransaction(pool, (tx) =>
      readCommittedAttachment(tx, f.request.authority.principal, aliases[0].aliasPath)
    )
    const materialized = await materializeAttachment(snapshot, path.join(directory, 'new-target'))
    assert.ok(materialized.contentHash === ordered[0].contentHash)
    const retained = await pool.query(
      'SELECT count(*)::text AS count FROM durable_runtime.input_attachments WHERE input_id=$1',
      [field(accepted, 'inputId')]
    )
    assert.ok(retained.rows[0].count === '3')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
