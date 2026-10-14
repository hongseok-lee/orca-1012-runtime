import assert from 'node:assert/strict'
import { test } from 'node:test'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { prepareInputRequest } from '../input/canonical.ts'
import type { JsonValue } from '../db/atomic.ts'
import { freezeJournalJson, type OriginalInputComponent } from './model.ts'
import { decodeCommittedInputBody } from './input-codec.ts'

const sessionId = logicalId('session', '00000000-0000-0000-0000-000000000001')
const principal = fingerprintAttachmentPrincipal('a'.repeat(64))
const alias = '/durable-fixture/ordered.png'
const contentHash = 'b'.repeat(64)
function original(): OriginalInputComponent {
  const chunks = Array.from({ length: 65 }, (_, index) => ({ ingressId: `fragment-${index}`,
    text: index === 0 ? '  '.repeat(140000) : ` chunk-${index}\n`,
    attachments: index === 1 ? [{ attachmentId: 'same-image' }, { attachmentId: 'same-image' }] :
      index === 2 ? [{ attachmentId: 'same-image' }] : [] }))
  const wire = { version: 1, source: 'UNARY', terminal: 'terminal:original', action: {
    text: '\r', enter: false, interrupt: false, inputKind: null, expectedIncarnationId: null,
    agentPrompt: false, resolvedLaunchDraft: null }, inputBytes: null, attachments: [] }
  const payload = { version: 1, text: chunks.map((chunk) => chunk.text).join(''), chunks, wire,
    originalIngressId: 'last-cr' }
  const attachments = Array.from({ length: 3 }, () => ({ aliasPath: alias, contentHash }))
  const request = prepareInputRequest({ authority: { principal, sessionId,
    scope: { kind: 'TERMINAL', terminalHandle: 'terminal:original' } }, method: 'terminal.send',
    operationKey: JSON.stringify(['UNARY', 'original-connection', 'last-rpc']), inputKind: 'GENERAL',
    sessionFence: counter('session-fence', '1'), payload, attachments })
  return { inputId: sessionId, messageId: sessionId, sessionId, inputSequence: '1', principal,
    operationKey: request.request.operationKey, originalPayloadHash: request.identity.payloadHash,
    original: freezeJournalJson(request.original), submission: null,
    attachments: attachments.map((item, index) => ({ ...item, position: String(index), mediaType: 'image/png', aliasPrincipal: principal })) }
}
function record(value: JsonValue): Record<string, JsonValue> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, JsonValue>
}
function mutate(input: OriginalInputComponent, change: (envelope: Record<string, JsonValue>) => void): OriginalInputComponent {
  const envelope = record(JSON.parse(JSON.stringify(input.original)) as JsonValue)
  change(envelope)
  return { ...input, original: freezeJournalJson(envelope as JsonValue) }
}
test('terminal accumulated text, ordered chunks and repeated attachments survive structured limits', () => {
  const input = original()
  const rawBefore = JSON.stringify(input.original)
  const body = decodeCommittedInputBody(input)
  assert.equal(body.kind, 'message'); assert.equal(body.role, 'user')
  assert.equal(body.blocks.length, 68)
  assert.ok(Buffer.byteLength(JSON.stringify(body), 'utf8') > 256 * 1024)
  assert.deepEqual(body.blocks.slice(1, 6), [
    { type: 'text', text: ' chunk-1\n' }, { type: 'image-ref', path: alias },
    { type: 'image-ref', path: alias }, { type: 'text', text: ' chunk-2\n' }, { type: 'image-ref', path: alias }
  ])
  assert.equal(JSON.stringify(input.original), rawBefore)
  assert.ok(Object.isFrozen(body.blocks))
})
test('terminal join, original positions, unknown codec and unverified media refuse reading', () => {
  const input = original()
  assert.throws(() => decodeCommittedInputBody(mutate(input, (x) => { record(x.payload).text = `${record(x.payload).text}changed` })), { code: 'JOURNAL_TERMINAL_TEXT_MISMATCH' })
  assert.throws(() => decodeCommittedInputBody({ ...input, attachments: input.attachments.map((x, i) =>
    i === 0 ? { ...x, position: '1' } : x) }), { code: 'JOURNAL_INPUT_ATTACHMENT_MISMATCH' })
  assert.throws(() => decodeCommittedInputBody(mutate(input, (x) => { x.method = 'terminal.unknown' })), { code: 'JOURNAL_INPUT_CODEC_UNREADABLE' })
  assert.throws(() => decodeCommittedInputBody(mutate(input, (x) => { record(x.payload).version = 2 })), { code: 'JOURNAL_INPUT_CODEC_UNREADABLE' })
  assert.throws(() => decodeCommittedInputBody({ ...input, attachments: input.attachments.map((x) =>
    ({ ...x, mediaType: 'application/octet-stream' })) }), { code: 'JOURNAL_TERMINAL_MEDIA_UNREADABLE' })
  assert.throws(() => decodeCommittedInputBody(mutate(input, (x) => { record(record(x.payload).wire).terminal = 'other-terminal' })), { code: 'JOURNAL_INPUT_CODEC_UNREADABLE' })
  assert.throws(() => decodeCommittedInputBody(mutate(input, (x) => {
    assert.ok(Array.isArray(x.attachments)); record(x.attachments[1]).contentHash = 'c'.repeat(64)
  })), { code: 'JOURNAL_INPUT_ATTACHMENT_MISMATCH' })
  assert.throws(() => decodeCommittedInputBody({ ...input, attachments: input.attachments.map((x) =>
    ({ ...x, aliasPrincipal: 'different-principal' })) }), { code: 'JOURNAL_TERMINAL_MEDIA_UNREADABLE' })
})
