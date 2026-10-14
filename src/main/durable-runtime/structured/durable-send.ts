import { runDurableMutation, type JsonValue } from '../db/atomic.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import type { StructuredSubmissionRow } from '../db/structured-session-rows.ts'
import { acceptInputInTransaction } from '../input/intake.ts'
import { discoverInputUnit } from '../input/authority.ts'
import { prepareInputRequest } from '../input/canonical.ts'
import type { InputRequest, InputAuthority } from '../input/types.ts'
import type { AgentSessionSendResult, AgentSessionMutationResult } from '../../../shared/agent-session-wire'
import { SessionId as PublicSessionId, JournalCursor, Identifier } from '../../../shared/rpc-contract/structured-agent-session-params'
import { captureCatalogInstant } from '../catalog/immutable.ts'
import { resolveStructuredSession, readStructuredSessionAlias } from './durable-alias.ts'
import { structuredFenceToDecimal, structuredCounterToNumber } from './counters.ts'
import { snapshotStructuredJson } from './snapshot.ts'
import { capturedJson, jsonValue, prepareDurableStructuredCall, structuredReceiptIdentity } from './durable-common.ts'
import type { DurableStructuredSendCall, DurableStructuredSendOutcome } from './durable-types.ts'

function record(value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DurableDatabaseError('STRUCTURED_RECEIPT_UNREADABLE')
  }
  return value
}
function storedWire(response: JsonValue, replayed: boolean): AgentSessionMutationResult<AgentSessionSendResult> {
  const saved = record(jsonValue(snapshotStructuredJson(response)))
  if (typeof saved.fence !== 'number') {
    throw new DurableDatabaseError('STRUCTURED_RECEIPT_UNREADABLE')
  }
  structuredFenceToDecimal(saved.fence)
  const cursor = JournalCursor.parse(saved.cursor)
  const value = record(saved.value)
  const clientMessageId = Identifier('Invalid client message id').parse(value.clientMessageId)
  const submission = record(value.submission)
  if (submission.clientMessageId !== clientMessageId || submission.fence !== saved.fence ||
    typeof submission.payloadFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(submission.payloadFingerprint) ||
    submission.dispatchState !== 'pending' || submission.providerItemId !== null ||
    submission.reason !== null || submission.resolvedAt !== null ||
    typeof submission.submittedAt !== 'number' || !Number.isSafeInteger(submission.submittedAt)) {
    throw new DurableDatabaseError('STRUCTURED_RECEIPT_UNREADABLE')
  }
  // SAFETY: an actual P103 committed/replayed receipt and the exact pending wire shape checked above.
  const pending = submission as unknown as AgentSessionSendResult['submission']
  return Object.freeze({ ok: true, replayed, fence: saved.fence, cursor,
    value: Object.freeze({ clientMessageId, submission: pending }) })
}

/** InputRequest.payload is exactly {body}; Input core owns its canonical version1 envelope. */
export async function sendDurableStructuredInput(call: DurableStructuredSendCall): Promise<DurableStructuredSendOutcome> {
  const { wire, authority } = prepareDurableStructuredCall(call, 'agentSession.send')
  const mutation = wire.mutation!
  PublicSessionId.parse(mutation.publicSessionId)
  const workspace = capturedJson(call.workspace)
  const resolved = capturedJson(call.attachments)
  const pool = call.pool
  if (resolved.principal !== authority.principal || mutation.sessionFence === null || mutation.wireFence === null) {
    throw new DurableDatabaseError('STRUCTURED_ATTACHMENT_SCOPE')
  }
  const body = record(jsonValue(wire.params.body))
  if (!Array.isArray(body.blocks)) {
    throw new DurableDatabaseError('STRUCTURED_SEND_BODY')
  }
  const imageBlocks = body.blocks.map((block, blockIndex) => ({ block: record(block), blockIndex }))
    .filter(item => item.block.type === 'image-ref')
  if (resolved.entries.length !== imageBlocks.length) {
    throw new DurableDatabaseError('STRUCTURED_ATTACHMENT_BINDING')
  }
  const attachments = resolved.entries.map((item, index) => {
    const source = imageBlocks[index]
    const referenceKind = Object.hasOwn(source.block, 'path') ? 'path' : 'url'
    if (item.blockIndex !== source.blockIndex || item.referenceKind !== referenceKind ||
      item.originalReference !== source.block[referenceKind] || !item.aliasPath || !/^[a-f0-9]{64}$/.test(item.contentHash)) {
      throw new DurableDatabaseError('STRUCTURED_ATTACHMENT_BINDING')
    }
    return Object.freeze({ aliasPath: item.aliasPath, contentHash: item.contentHash })
  })
  const payload = Object.freeze({ body: jsonValue(wire.params.body) })
  const identity = structuredReceiptIdentity(wire, authority, { ...payload, attachments })
  // Only immutable scope/alias discovery precedes P103. No current lifecycle/fence check here.
  const alias = await resolveStructuredSession(pool, authority, workspace)
  const inputAuthority: InputAuthority = Object.freeze({ principal: authority.principal,
    sessionId: alias.sessionId, scope: Object.freeze({ kind: 'SESSION' }) })
  const expectedUnitId = await discoverInputUnit(pool, inputAuthority)
  const request: InputRequest = Object.freeze({ authority: inputAuthority, method: wire.method,
    operationKey: mutation.operationKey, inputKind: 'GENERAL', sessionFence: mutation.sessionFence,
    payload, attachments: Object.freeze(attachments) })
  const preparedInput = prepareInputRequest(request)
  const outcome = await runDurableMutation(pool, {
    ...identity, locks: { sessionIds: [alias.sessionId], runtimeUnitIds: expectedUnitId ? [expectedUnitId] : [] }
  }, async tx => {
    const current = await readStructuredSessionAlias(tx, authority, workspace)
    if (current.sessionId !== alias.sessionId || current.workspace.provider !== workspace.provider ||
      current.workspace.executionHostId !== workspace.executionHostId) {
      throw new DurableDatabaseError('STRUCTURED_SESSION_ALIAS_SCOPE')
    }
    const input = await acceptInputInTransaction(tx, preparedInput.request, expectedUnitId)
    const original = await tx.query<{
      input_id: string; message_id: string; session_id: string; principal_id: string;
      client_operation_id: string; submitted_at: Date; journal_epoch: string; journal_sequence: string;
      component_matches: boolean; event_matches: boolean
    }>(
      `SELECT i.id AS input_id,i.message_id,i.session_id,i.authenticated_sender AS principal_id,
       i.client_operation_id,i.accepted_at AS submitted_at,e.journal_epoch,e.seq AS journal_sequence,
       (i.original_payload_hash=$5 AND i.body_or_blob_ref=$6::jsonb) AS component_matches,
       (e.body->>'kind'='INPUT_SUBMISSION' AND e.body->>'inputId'=i.id::text
        AND e.body->>'messageId'=i.message_id::text AND e.body->>'inputSequence'=i.input_seq::text
        AND e.body->>'originalPayloadHash'=i.original_payload_hash) AS event_matches
       FROM durable_runtime.input_components i JOIN durable_runtime.session_events e ON e.session_id=i.session_id
       WHERE i.id=$1 AND i.message_id=$2 AND i.session_id=$3 AND e.event_id=$4`,
      [input.inputId, input.messageId, alias.sessionId, input.submissionEventId,
        preparedInput.identity.payloadHash, JSON.stringify(preparedInput.original)]
    )
    const row = original.rows[0]
    if (original.rowCount !== 1 || row.principal_id !== authority.principal ||
      row.client_operation_id !== mutation.operationKey || !row.component_matches || !row.event_matches ||
      row.journal_sequence !== input.journalSequence) {
      throw new DurableDatabaseError('STRUCTURED_SUBMISSION_IDENTITY')
    }
    await tx.query<StructuredSubmissionRow>(
      `INSERT INTO durable_runtime.structured_submissions
       (input_id,message_id,session_id,principal_id,client_message_id,wire_payload_fingerprint,
        wire_fence,journal_epoch,journal_sequence,submitted_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [input.inputId, input.messageId, alias.sessionId, authority.principal, mutation.operationKey,
        mutation.wireFingerprint, mutation.sessionFence, row.journal_epoch, row.journal_sequence, row.submitted_at]
    )
    const value: AgentSessionSendResult = { clientMessageId: mutation.operationKey,
      submission: { clientMessageId: mutation.operationKey, fence: mutation.wireFence!,
        payloadFingerprint: mutation.wireFingerprint, dispatchState: 'pending', providerItemId: null,
        reason: null, submittedAt: captureCatalogInstant(row.submitted_at), resolvedAt: null } }
    return { fence: mutation.wireFence!, cursor: { epoch: row.journal_epoch,
      sequence: structuredCounterToNumber(row.journal_sequence, 1) }, value: jsonValue(snapshotStructuredJson(value)) }
  })
  if (outcome.status === 'UNCERTAIN') {
    return outcome
  }
  return Object.freeze({ ...outcome, wireResult: storedWire(outcome.receipt.response, outcome.status === 'REPLAYED') })
}
