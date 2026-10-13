import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { materializeAttachment } from './materializer.ts'
import { reserveAttachmentAlias, attachmentFilename } from './store.ts'
import { attachmentUploadId, pairedDeviceAttachmentPrincipal, type CommittedAttachment } from './types.ts'

let root: string
before(async () => {
  assert.ok(process.cwd().startsWith('/tmp/orca-p104-execution'), 'Remote isolated execution directory is required')
  root = await mkdtemp('/tmp/orca-p104-execution/materializer-')
})
after(async () => { if (root) await rm(root, { recursive: true, force: true }) })

function snapshot(bytes: Buffer): CommittedAttachment {
  const id = attachmentUploadId(randomUUID())
  return {
    uploadId: id, principal: pairedDeviceAttachmentPrincipal(randomUUID()),
    aliasPath: reserveAttachmentAlias('/persistent-test-aliases', id),
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length, mediaType: 'image/png', targetConnectionId: null,
    contentBytes: bytes
  }
}

test('same committed bytes materialize in new attempt roots and an identical file is reused', async () => {
  const record = snapshot(Buffer.from('synthetic materialization fixture'))
  const first = await materializeAttachment(record, path.join(root, 'attempt-one'))
  const replay = await materializeAttachment(record, path.join(root, 'attempt-one'))
  const second = await materializeAttachment(record, path.join(root, 'attempt-two'))
  assert.ok(!first.reused && replay.reused && !second.reused)
  assert.ok((await readFile(first.path)).equals(record.contentBytes))
  assert.ok((await readFile(second.path)).equals(record.contentBytes))
  assert.ok(record.aliasPath.startsWith('/persistent-test-aliases/'))
})

test('conflicting target is not overwritten; target and directory symlinks are refused', async () => {
  const record = snapshot(Buffer.from('synthetic desired bytes'))
  const target = path.join(root, 'conflict')
  await mkdir(target)
  const filename = attachmentFilename(record.uploadId)
  const original = Buffer.from('synthetic existing bytes')
  await writeFile(path.join(target, filename), original)
  await assert.rejects(materializeAttachment(record, target), { code: 'TARGET_CONFLICT' })
  assert.ok((await readFile(path.join(target, filename))).equals(original))
  const linked = path.join(root, 'linked-file')
  await mkdir(linked)
  await symlink(path.join(target, filename), path.join(linked, filename))
  await assert.rejects(materializeAttachment(record, linked), { code: 'UNSAFE_TARGET' })
  await symlink(target, path.join(root, 'linked-root'))
  await assert.rejects(materializeAttachment(record, path.join(root, 'linked-root', 'child')), { code: 'UNSAFE_TARGET' })
  assert.ok((await readFile(path.join(target, filename))).equals(original))
})

test('concurrent publication uses one complete file without partial overwrite', async () => {
  const record = snapshot(Buffer.alloc(128 * 1024, 7))
  const results = await Promise.all([
    materializeAttachment(record, path.join(root, 'concurrent')),
    materializeAttachment(record, path.join(root, 'concurrent'))
  ])
  assert.ok(results.some((result) => !result.reused))
  assert.ok((await readFile(results[0].path)).equals(record.contentBytes))
})

test('corrupt snapshot fails before file creation and empty wire bytes remain supported', async () => {
  const corrupt = snapshot(Buffer.from('synthetic content'))
  corrupt.contentHash = '0'.repeat(64)
  await assert.rejects(materializeAttachment(corrupt, path.join(root, 'not-created')), { code: 'CORRUPT_BLOB' })
  const empty = snapshot(Buffer.alloc(0))
  const result = await materializeAttachment(empty, path.join(root, 'empty'))
  assert.equal((await readFile(result.path)).length, 0)
})
