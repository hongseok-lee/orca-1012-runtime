import type { DurableTransaction } from '../db/connection.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { requireInputSessionLock } from '../input/composition.ts'
import { sameTerminalDraftBinding } from './draft-reducer'
import { encodeStoredTerminalDraft, decodeStoredTerminalDraft, snapshotDraftAttachments } from './durable-codec'
import type { StoredTerminalDraft } from './durable-codec'
import { TerminalDraftStoreError, terminalCounter, nextTerminalCounter } from './durable-contracts'
import { snapshotDraftBinding } from './ingress'
import type { TerminalDraftBinding } from './types'

/** The 004 legacy table is used unchanged. Session aggregate lock owns its row order. */
export async function readTerminalDraftInTransaction(
  tx: DurableTransaction,
  binding: TerminalDraftBinding
): Promise<StoredTerminalDraft | null> {
  const pin = snapshotDraftBinding(binding)
  requireInputSessionLock(tx, logicalId('session', pin.sessionId))
  const result = await tx.query(
    `SELECT draft_revision,body,attachments,lifecycle FROM durable_runtime.legacy_drafts
     WHERE terminal_handle=$1 AND paired_device_id=$2 AND floor_generation=$3`,
    [pin.logicalHandle, pin.pairedDeviceId, terminalCounter(pin.floorGeneration)]
  )
  const row = result.rows[0]
  if (!row) {
    return null
  }
  if (row.lifecycle !== 'OPEN') {
    throw new TerminalDraftStoreError('TERMINAL_DRAFT_NOT_OPEN')
  }
  const stored = decodeStoredTerminalDraft(row.body, row.attachments, terminalCounter(row.draft_revision))
  if (!sameTerminalDraftBinding(stored.draft.binding, pin)) {
    throw new TerminalDraftStoreError('TERMINAL_DRAFT_BINDING_MISMATCH')
  }
  return stored
}

/** Exactly one draft revision step, within the caller's existing transaction. */
export async function saveTerminalDraftInTransaction(
  tx: DurableTransaction,
  stored: StoredTerminalDraft,
  expectedRevision: string,
  existed: boolean
): Promise<StoredTerminalDraft> {
  const binding = snapshotDraftBinding(stored.draft.binding)
  const revision = terminalCounter(expectedRevision)
  const next = Object.freeze({ ...stored,
    draft: Object.freeze({ ...stored.draft, binding, revision: nextTerminalCounter(revision) }),
    attachments: snapshotDraftAttachments(stored.attachments) })
  const body = encodeStoredTerminalDraft(next)
  requireInputSessionLock(tx, logicalId('session', binding.sessionId))
  let count: number | null
  if (existed) {
    count = (await tx.query(
      `UPDATE durable_runtime.legacy_drafts SET draft_revision=draft_revision+1,body=$5,
       attachments=$6,updated_at=clock_timestamp()
       WHERE terminal_handle=$1 AND paired_device_id=$2 AND floor_generation=$3
       AND draft_revision=$4 AND lifecycle='OPEN'`,
      [binding.logicalHandle, binding.pairedDeviceId, binding.floorGeneration, revision,
        JSON.stringify(body), JSON.stringify(next.attachments)]
    )).rowCount
  } else {
    if (revision !== '0') {
      throw new TerminalDraftStoreError('TERMINAL_STALE_DRAFT_REVISION')
    }
    count = (await tx.query(
      `INSERT INTO durable_runtime.legacy_drafts(terminal_handle,paired_device_id,floor_generation,
       draft_revision,body,attachments,lifecycle,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,'OPEN',clock_timestamp()) ON CONFLICT DO NOTHING`,
      [binding.logicalHandle, binding.pairedDeviceId, binding.floorGeneration, next.draft.revision,
        JSON.stringify(body), JSON.stringify(next.attachments)]
    )).rowCount
  }
  if (count !== 1) {
    throw new TerminalDraftStoreError('TERMINAL_STALE_DRAFT_REVISION')
  }
  return next
}
