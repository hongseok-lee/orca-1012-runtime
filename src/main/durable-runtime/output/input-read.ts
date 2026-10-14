import type { PoolClient } from 'pg'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { inputPayloadHash } from '../input/canonical.ts'
import type { JsonValue } from '../db/atomic.ts'
import { SendParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import { decodeCommittedInputBody } from './input-codec.ts'
import {
  freezeJournalJson, jsonObject, JournalReadError,
  type VerifiedJournalReadScope, type CommittedJournalEvent, type OriginalInputComponent
} from './model.ts'

type InputRow = {
  id: string; message_id: string; session_id: string; input_seq: string
  authenticated_sender: string; client_operation_id: string; original_payload_hash: string
  body_or_blob_ref: unknown; attachments: unknown; terminal_scope_matches: boolean
  submission_input_id: string | null; submission_message_id: string | null; submission_session_id: string | null
  principal_id: string | null; client_message_id: string | null; wire_payload_fingerprint: string | null
  wire_fence: string | null; journal_epoch: string | null; journal_sequence: string | null; submitted_at: string | null
}
export async function readOriginalInputs(
  client: PoolClient, scope: VerifiedJournalReadScope, epoch: string, events: readonly CommittedJournalEvent[]
): Promise<readonly OriginalInputComponent[]> {
  const inputEvents = events.filter((event) => event.body !== null && typeof event.body === 'object' &&
    !Array.isArray(event.body) && jsonObject(event.body).kind === 'INPUT_SUBMISSION')
  if (inputEvents.length === 0) { return Object.freeze([]) }
  const ids = inputEvents.map((event) => {
    const inputId = jsonObject(event.body).inputId
    if (typeof inputId !== 'string') { throw new JournalReadError('JOURNAL_INPUT_MISMATCH') }
    return logicalId('input', inputId)
  })
  if (new Set(ids).size !== ids.length) { throw new JournalReadError('JOURNAL_INPUT_MISMATCH') }
  const result = await client.query<InputRow>(
    `SELECT i.id,i.message_id,i.session_id,i.input_seq::text,i.authenticated_sender,i.client_operation_id,
      i.original_payload_hash,i.body_or_blob_ref,
      EXISTS(SELECT 1 FROM durable_runtime.tabs t WHERE t.session_id=i.session_id
        AND t.terminal_handle=i.body_or_blob_ref->'scope'->>1) AS terminal_scope_matches,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('position',a.position::text,'aliasPath',a.blob_ref,
        'contentHash',a.content_hash,'mediaType',b.media_type,'aliasPrincipal',aa.principal_id)
        ORDER BY a.position) FROM durable_runtime.input_attachments a
        LEFT JOIN durable_runtime.attachment_aliases aa ON aa.alias_path=a.blob_ref AND aa.content_hash=a.content_hash
        LEFT JOIN durable_runtime.attachment_blobs b ON b.content_hash=aa.content_hash
        WHERE a.input_id=i.id),'[]'::jsonb) AS attachments,
      ss.input_id AS submission_input_id,ss.message_id AS submission_message_id,ss.session_id AS submission_session_id,
      ss.principal_id,ss.client_message_id,ss.wire_payload_fingerprint,ss.wire_fence::text,
      ss.journal_epoch::text,ss.journal_sequence::text,ss.submitted_at::text
     FROM durable_runtime.input_components i
     JOIN durable_runtime.messages m ON m.id=i.message_id AND m.session_id=i.session_id
     LEFT JOIN durable_runtime.structured_submissions ss ON ss.input_id=i.id
     WHERE i.session_id=$1 AND i.id=ANY($2::uuid[])`, [scope.sessionId, ids]
  )
  const byId = new Map(result.rows.map((row) => [row.id, row]))
  if (byId.size !== ids.length) { throw new JournalReadError('JOURNAL_INPUT_MISMATCH') }
  return Object.freeze(inputEvents.map((event) => {
    const body = jsonObject(event.body)
    const row = byId.get(body.inputId as string)!
    const original = freezeJournalJson(row.body_or_blob_ref)
    const envelope = jsonObject(original)
    if (envelope.version !== 1 || envelope.sessionId !== row.session_id ||
      envelope.operationKey !== row.client_operation_id || typeof envelope.method !== 'string' ||
      typeof envelope.sessionFence !== 'string' || !Array.isArray(envelope.scope) ||
      envelope.scope.length !== 2 ||
      !(envelope.scope[0] === 'session' && envelope.scope[1] === row.session_id ||
        envelope.scope[0] === 'terminal' && typeof envelope.scope[1] === 'string' && envelope.scope[1].length > 0) ||
      body.messageId !== row.message_id || body.inputSequence !== row.input_seq ||
      body.originalPayloadHash !== row.original_payload_hash ||
      inputPayloadHash(original as JsonValue) !== row.original_payload_hash) {
      throw new JournalReadError('JOURNAL_INPUT_MISMATCH')
    }
    counter('session-fence', envelope.sessionFence)
    counter('sequence:input', row.input_seq)
    if (envelope.method === 'terminal.send' && !row.terminal_scope_matches) {
      throw new JournalReadError('JOURNAL_TERMINAL_SCOPE_MISMATCH')
    }
    const expectedSource = JSON.stringify(['v1', row.session_id, 'producer', 'INPUT_SUBMISSION',
      row.session_id, 'durable-input-v1', row.input_seq])
    if (event.sourceKey !== expectedSource) { throw new JournalReadError('JOURNAL_INPUT_MISMATCH') }
    const attachmentJson = freezeJournalJson(row.attachments)
    if (!Array.isArray(attachmentJson) || !Array.isArray(envelope.attachments) ||
      attachmentJson.length !== envelope.attachments.length) { throw new JournalReadError('JOURNAL_INPUT_MISMATCH') }
    const attachments = attachmentJson.map((entry, index) => {
      const attachment = jsonObject(entry)
      const originalAttachments = envelope.attachments
      if (!Array.isArray(originalAttachments)) { throw new JournalReadError('JOURNAL_INPUT_MISMATCH') }
      const originalAttachment = jsonObject(originalAttachments[index])
      if (attachment.position !== String(index) || typeof attachment.aliasPath !== 'string' ||
        typeof attachment.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(attachment.contentHash) ||
        attachment.aliasPath !== originalAttachment.aliasPath || attachment.contentHash !== originalAttachment.contentHash) {
        throw new JournalReadError('JOURNAL_INPUT_MISMATCH')
      }
      if (attachment.aliasPrincipal !== row.authenticated_sender || typeof attachment.mediaType !== 'string') {
        throw new JournalReadError('JOURNAL_INPUT_ATTACHMENT_MISMATCH')
      }
      return Object.freeze({ position: attachment.position, aliasPath: attachment.aliasPath, contentHash: attachment.contentHash,
        mediaType: attachment.mediaType, aliasPrincipal: attachment.aliasPrincipal })
    })
    let submission: OriginalInputComponent['submission'] = null
    if (row.submission_input_id !== null) {
      if (row.submission_input_id !== row.id || row.submission_message_id !== row.message_id ||
        row.submission_session_id !== row.session_id || row.principal_id !== row.authenticated_sender ||
        row.client_message_id !== row.client_operation_id || row.wire_fence !== envelope.sessionFence ||
        row.journal_epoch !== epoch || row.journal_sequence !== String(event.sequence) ||
        envelope.method !== 'agentSession.send' || envelope.inputKind !== 'GENERAL' ||
        envelope.scope[0] !== 'session' || !row.submitted_at ||
        !Number.isFinite(Date.parse(row.submitted_at))) { throw new JournalReadError('JOURNAL_SUBMISSION_MISMATCH') }
      const payload = jsonObject(envelope.payload)
      // Use the existing strict user-message schema; preserve the original body rather than parser transforms.
      const parsed = SendParams.shape.body.safeParse(payload.body)
      if (!parsed.success) { throw new JournalReadError('JOURNAL_INPUT_BODY_UNREADABLE') }
      if (row.wire_payload_fingerprint !== structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send', sessionId: scope.publicSessionId, fields: { body: payload.body }
      })) { throw new JournalReadError('JOURNAL_SUBMISSION_MISMATCH') }
      submission = Object.freeze({ principal: row.principal_id!, clientMessageId: row.client_message_id!,
        wirePayloadFingerprint: row.wire_payload_fingerprint!, wireFence: row.wire_fence!,
        journalEpoch: row.journal_epoch!, journalSequence: row.journal_sequence!, submittedAt: row.submitted_at })
    }
    const input = Object.freeze({ inputId: row.id, messageId: row.message_id, sessionId: row.session_id,
      inputSequence: row.input_seq, principal: row.authenticated_sender, operationKey: row.client_operation_id,
      originalPayloadHash: row.original_payload_hash, original, attachments: Object.freeze(attachments), submission })
    decodeCommittedInputBody(input)
    return input
  }))
}
