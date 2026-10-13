import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, mkdir, open, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import type { CommittedAttachment } from './types.ts'
import { attachmentFilename } from './store.ts'

export class AttachmentMaterializationError extends Error {
  constructor(readonly code: string) {
    super(`Attachment materialization failed (${code})`)
    this.name = 'AttachmentMaterializationError'
  }
}

function descriptorPath(directory: FileHandle, filename: string): string {
  return `/proc/self/fd/${directory.fd}/${filename}`
}

/** Linux dev/Agent runtime: pin every directory inode, never follow a root-path symlink. */
async function openTargetDirectory(targetRoot: string): Promise<FileHandle> {
  if (process.platform !== 'linux') throw new AttachmentMaterializationError('PLATFORM_UNSUPPORTED')
  if (!path.isAbsolute(targetRoot) || targetRoot.includes('\0')) {
    throw new AttachmentMaterializationError('INVALID_TARGET_ROOT')
  }
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  let current = await open('/', flags)
  try {
    for (const component of path.resolve(targetRoot).split('/').filter(Boolean)) {
      const candidate = descriptorPath(current, component)
      try { await mkdir(candidate, { mode: 0o700 }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const next = await open(candidate, flags)
      await current.close()
      current = next
    }
    return current
  } catch (error) {
    await current.close()
    throw error
  }
}

async function verifyTarget(directory: FileHandle, filename: string, expected: CommittedAttachment): Promise<void> {
  const file = await open(descriptorPath(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size !== expected.byteLength) {
      throw new AttachmentMaterializationError('TARGET_CONFLICT')
    }
    const digest = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    let length = 0
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, length)
      if (bytesRead === 0) break
      length += bytesRead
      if (length > expected.byteLength) throw new AttachmentMaterializationError('TARGET_CONFLICT')
      digest.update(buffer.subarray(0, bytesRead))
    }
    const after = await file.stat()
    if (length !== expected.byteLength || after.size !== length ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        digest.digest('hex') !== expected.contentHash) {
      throw new AttachmentMaterializationError('TARGET_CONFLICT')
    }
  } finally { await file.close() }
}

/** No transaction/DB/SSH access. Call with a committed DB snapshot and a trusted attempt root. */
export async function materializeAttachment(
  attachment: CommittedAttachment,
  targetRoot: string
): Promise<{ path: string; contentHash: string; byteLength: number; reused: boolean }> {
  if (!Buffer.isBuffer(attachment.contentBytes) || attachment.contentBytes.length !== attachment.byteLength ||
      createHash('sha256').update(attachment.contentBytes).digest('hex') !== attachment.contentHash) {
    throw new AttachmentMaterializationError('CORRUPT_BLOB')
  }
  let filename: string
  try { filename = attachmentFilename(attachment.uploadId) }
  catch { throw new AttachmentMaterializationError('INVALID_UPLOAD_ID') }
  let directory: FileHandle | undefined
  let temporary: string | undefined
  let createdTemporary = false
  try {
    directory = await openTargetDirectory(targetRoot)
    try {
      await verifyTarget(directory, filename, attachment)
      return { path: path.join(path.resolve(targetRoot), filename), contentHash: attachment.contentHash,
        byteLength: attachment.byteLength, reused: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    temporary = descriptorPath(directory, `.orca-materialize-${randomUUID()}.tmp`)
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    createdTemporary = true
    try {
      await file.writeFile(attachment.contentBytes)
      await file.sync()
    } finally { await file.close() }
    let reused = false
    try { await link(temporary, descriptorPath(directory, filename)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      reused = true
    }
    await verifyTarget(directory, filename, attachment)
    await directory.sync()
    return { path: path.join(path.resolve(targetRoot), filename), contentHash: attachment.contentHash,
      byteLength: attachment.byteLength, reused }
  } catch (error) {
    if (error instanceof AttachmentMaterializationError) throw error
    // Never include filesystem error paths, attachment content, or caller identity in an error.
    const code = (error as NodeJS.ErrnoException).code
    throw new AttachmentMaterializationError(code === 'ELOOP' || code === 'ENOTDIR' ? 'UNSAFE_TARGET' : 'FILESYSTEM_FAILURE')
  } finally {
    if (createdTemporary && temporary) await unlink(temporary).catch(() => {})
    await directory?.close()
  }
}
