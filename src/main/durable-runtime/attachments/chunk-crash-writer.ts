// Dedicated verification child. It never logs payloads or pairing credentials.
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { appendAttachmentChunk, startAttachmentUpload } from './store.ts'
import { type AttachmentPrincipal, type AttachmentUploadId } from './types.ts'

interface Fixture {
  id: AttachmentUploadId
  principal: AttachmentPrincipal
  first: string
  second: string
  expectedBase64Length: number
}

process.once('message', (fixture: Fixture) => {
  void (async () => {
    if (!/^orca_p104_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? '') ||
        !process.cwd().startsWith('/tmp/orca-p104-execution')) {
      throw new Error('verification_environment_required')
    }
    const pool = createDurablePool({ database: process.env.PGDATABASE, max: 1 })
    await withDurableTransaction(pool, async (tx) => {
      await startAttachmentUpload(tx, {
        id: fixture.id, principal: fixture.principal, expectedBase64Length: fixture.expectedBase64Length
      })
      await appendAttachmentChunk(tx, {
        id: fixture.id, principal: fixture.principal, offset: 0, contentBase64: fixture.first
      })
    })
    await withDurableTransaction(pool, async (tx) => {
      await appendAttachmentChunk(tx, {
        id: fixture.id, principal: fixture.principal, offset: fixture.first.length, contentBase64: fixture.second
      })
      const pid = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      process.send?.({ phase: 'uncommitted-chunk', backendPid: pid.rows[0].pid })
      await new Promise<void>(() => {})
    })
  })().catch(() => {
    process.send?.({ phase: 'failed' })
    process.exitCode = 1
    process.disconnect?.()
    process.exit(1)
  })
})
