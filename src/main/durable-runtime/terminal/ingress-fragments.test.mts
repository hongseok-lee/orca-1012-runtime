import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildAgentTuiClearInputForText,
  buildAgentTuiClearInput
} from '../../../shared/agent-tui-input-clear'
import {
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText,
  TerminalStreamOpcode
} from '../../../shared/terminal-stream-protocol'
import {
  reduceTerminalDraft,
  snapshotBinaryTerminalIngress,
  snapshotUnaryTerminalIngress
} from './index'
import type {
  TerminalAttachmentReference,
  TerminalDraft,
  TerminalDraftReduction,
  TerminalIngressScope,
  TerminalIngressSnapshot
} from './types'

// Synthetic authenticated scope only; no runtime, provider, account or PG activity.
function scope(id: string, overrides: Partial<TerminalIngressScope> = {}): TerminalIngressScope {
  return {
    binding: {
      pairedDeviceId: 'fixture-device-a', principalId: 'fixture-principal-a',
      logicalHandle: 'fixture-terminal-a', sessionId: 'fixture-session-a',
      connectionId: 'fixture-connection-a', floorGeneration: 'fixture-floor-a',
      mode: 'AGENT_CHAT_COMPAT'
    },
    ingressId: id, draftRevision: 'fixture-revision-a', ptyIncarnationId: null,
    semanticAdapterRequired: false, stream: null, ...overrides
  }
}

function unary(
  id: string,
  text: string,
  action: Record<string, unknown> = {},
  server = scope(id),
  attachments: readonly TerminalAttachmentReference[] = []
): TerminalIngressSnapshot {
  return snapshotUnaryTerminalIngress(
    { terminal: server.binding.logicalHandle, text, ...action }, server, attachments, () => true
  )
}

function binaryScope(id: string): TerminalIngressScope {
  return scope(id, { stream: { connectionId: 'fixture-connection-a', streamId: 1,
    streamGeneration: 'fixture-stream-a', ackMode: 'BYTES' } })
}

function binaryInput(id: string, payload: string | Uint8Array): TerminalIngressSnapshot {
  const result = snapshotBinaryTerminalIngress(encodeTerminalStreamFrame({
    opcode: TerminalStreamOpcode.Input, streamId: 1, seq: 0,
    payload: typeof payload === 'string' ? encodeTerminalStreamText(payload) : payload
  }), binaryScope(id), [], () => true)
  assert.equal(result.kind, 'INPUT')
  if (result.kind !== 'INPUT') {
    throw new Error('Fixture did not produce an Input snapshot')
  }
  return result.snapshot
}

function draftOf(result: TerminalDraftReduction): TerminalDraft {
  assert.ok(result.draft)
  return result.draft
}

test('iPhone clear then body plus Enter keeps exact text and ordered attachment references', () => {
  const old = draftOf(reduceTerminalDraft(null, unary('old-body', 'old draft', {}, scope('old-body'),
    [{ attachmentId: 'old-reference' }])))
  const cleared = reduceTerminalDraft(old, unary('clear', buildAgentTuiClearInputForText('old draft'),
    { enter: false }))
  assert.equal(cleared.kind, 'DRAFT_EDIT')
  assert.deepEqual(draftOf(cleared).chunks, [])
  const body = '새 본문\nsecond line 😀'
  const submitted = reduceTerminalDraft(draftOf(cleared), unary('body-enter', body,
    { enter: true }, scope('body-enter'),
    [{ attachmentId: 'reference-2' }, { attachmentId: 'reference-1' }]))
  assert.equal(submitted.kind, 'SUBMIT_CANDIDATE')
  assert.equal(submitted.candidate?.text, body)
  assert.deepEqual(submitted.candidate?.attachments,
    [{ attachmentId: 'reference-2' }, { attachmentId: 'reference-1' }])
  assert.equal(Object.hasOwn(submitted, 'accepted'), false)
  assert.equal(draftOf(submitted).chunks[0].text, body)
})

test('Mac clear then plain or bracketed body waits for a separate CR', () => {
  for (const [wire, body] of [
    ['plain body', 'plain body'],
    ['\x1b[200~first\r\nsecond\x1b[201~', 'first\r\nsecond']
  ]) {
    const cleared = draftOf(reduceTerminalDraft(null, unary('mac-clear', buildAgentTuiClearInput(2))))
    const appended = reduceTerminalDraft(cleared, unary('mac-body', wire, {}, scope('mac-body'),
      [{ attachmentId: 'mac-reference' }]))
    assert.equal(appended.kind, 'DRAFT_EDIT')
    assert.equal(appended.candidate, null)
    const submitted = reduceTerminalDraft(draftOf(appended), unary('mac-cr', '\r'))
    assert.equal(submitted.kind, 'SUBMIT_CANDIDATE')
    assert.equal(submitted.candidate?.text, body)
    assert.deepEqual(submitted.candidate?.chunks.map((chunk) => chunk.ingressId), ['mac-body'])
    assert.deepEqual(submitted.candidate?.attachments, [{ attachmentId: 'mac-reference' }])
  }
})

test('split ESC delimiters and UTF-8 keep interior CR and newline inside the paste', () => {
  const korean = encodeTerminalStreamText('한')
  const fragments: readonly (string | Uint8Array)[] = [
    '\x1b', '[200~', korean.slice(0, 1), korean.slice(1), '\r\n😀 tail', '\x1b', '[201~'
  ]
  let previous: TerminalDraft | null = null
  for (let i = 0; i < fragments.length; i += 1) {
    const reduced = reduceTerminalDraft(previous, binaryInput(`split-${i}`, fragments[i]))
    assert.equal(reduced.kind, i === 0 ? 'STOP_CANDIDATE' : 'DRAFT_EDIT')
    assert.equal(reduced.candidate, null)
    previous = draftOf(reduced)
    if (i === 1) {
      assert.equal(previous.pasteOpen, true)
      assert.equal(previous.pendingDelimiter, '')
    }
    if (i === 2) {
      assert.deepEqual(previous.pendingUtf8, Array.from(korean.slice(0, 1)))
    }
    if (i === 5) {
      assert.equal(previous.pasteOpen, true)
      assert.equal(previous.pendingDelimiter, '\x1b')
    }
  }
  const submitted = reduceTerminalDraft(previous, binaryInput('split-cr', '\r'))
  assert.equal(submitted.kind, 'SUBMIT_CANDIDATE')
  assert.equal(submitted.candidate?.text, '한\r\n😀 tail')
})

test('partial paste fragments cannot reset accumulated draft or become protocol or Stop gestures', () => {
  const accumulated = draftOf(reduceTerminalDraft(null, unary('accumulated', '原 본문')))
  const open = draftOf(reduceTerminalDraft(accumulated, unary('open-paste', '\x1b[200~inside')))
  const pending = draftOf(reduceTerminalDraft(accumulated, unary('pending-paste', '\x1b[20')))
  const clear = buildAgentTuiClearInputForText('原 본문inside')
  for (const original of [open, pending]) {
    const fragments = [
      unary('clear-fragment', clear, { enter: false }),
      binaryInput('binary-clear-fragment', clear),
      unary('query-fragment', '\x1b[1;2R', { inputKind: 'query-reply' }),
      binaryInput('binary-query-fragment', '\x1b[1;2R'),
      unary('interrupt-fragment', '', { interrupt: true })
    ]
    for (const fragment of fragments) {
      const rejected = reduceTerminalDraft(original, fragment)
      assert.equal(rejected.kind, 'UNSUPPORTED')
      assert.deepEqual(rejected.draft, original)
      assert.equal(rejected.candidate, null)
    }
    const esc = reduceTerminalDraft(original, unary('esc-fragment', '\x1b'))
    assert.notEqual(esc.kind, 'STOP_CANDIDATE')
    assert.equal(esc.candidate, null)
    assert.deepEqual(draftOf(esc).chunks, original.chunks)
  }
  // The open draft still completes normally after the rejected clear/reply/interrupt.
  const completed = draftOf(reduceTerminalDraft(open, unary('close-original', '\x1b[201~')))
  const submitted = reduceTerminalDraft(completed, unary('original-cr', '\r'))
  assert.equal(submitted.candidate?.text, '原 본문inside')
  for (const malformed of ['\x1b[200~nested', '\x1b[209~', '\x15mixed']) {
    const rejected = reduceTerminalDraft(open, unary('malformed-fragment', malformed))
    assert.equal(rejected.kind, 'UNSUPPORTED')
    assert.deepEqual(rejected.draft, open)
  }
  const unclosed = reduceTerminalDraft(open, unary('unclosed-enter', 'tail', { enter: true }))
  assert.equal(unclosed.kind, 'UNSUPPORTED')
  assert.deepEqual(unclosed.draft, open)
})

test('server binding and caller snapshots stay isolated across device floor connection and mutation', () => {
  const initial = scope('snapshot')
  const callerScope = { ...initial, binding: { ...initial.binding } }
  const callerAttachments = [{ attachmentId: 'original-reference' }]
  const payload: { terminal: string; text: string; enter: unknown; client: { id: string; type: string } } = {
    terminal: initial.binding.logicalHandle, text: 'original body', enter: true,
    client: { id: 'payload-id-is-not-server-device', type: 'desktop' }
  }
  let current = true
  const seen: TerminalIngressScope[] = []
  const snapshot = snapshotUnaryTerminalIngress(payload, callerScope, callerAttachments, (expected) => {
    seen.push(expected)
    return current
  })
  payload.text = 'mutated body'
  payload.enter = 'true'
  payload.client.type = 'mobile'
  callerScope.binding.mode = 'RAW_TERMINAL'
  callerScope.binding.floorGeneration = 'mutated-floor'
  callerAttachments[0].attachmentId = 'mutated-reference'
  const submitted = reduceTerminalDraft(null, snapshot)
  assert.equal(submitted.kind, 'SUBMIT_CANDIDATE')
  assert.equal(submitted.candidate?.text, 'original body')
  assert.deepEqual(submitted.candidate?.attachments, [{ attachmentId: 'original-reference' }])
  assert.equal(snapshot.scope.binding.pairedDeviceId, initial.binding.pairedDeviceId)
  assert.equal(snapshot.scope.binding.mode, 'AGENT_CHAT_COMPAT')
  assert.ok(seen.every((expected) => expected === snapshot.scope))
  current = false
  assert.equal(reduceTerminalDraft(null, snapshot).kind, 'STALE_SCOPE')
  const original = draftOf(reduceTerminalDraft(null, unary('original-scope', 'kept')))
  for (const difference of [
    { pairedDeviceId: 'other-device' }, { floorGeneration: 'other-floor' },
    { connectionId: 'other-connection' }
  ]) {
    const changed = scope('changed', { binding: { ...initial.binding, ...difference } })
    const rejected = reduceTerminalDraft(original, unary('changed', 'must not merge', {}, changed))
    assert.equal(rejected.kind, 'SCOPE_MISMATCH')
    assert.deepEqual(rejected.draft, original)
  }
  const strictBoolean = reduceTerminalDraft(null, unary('strict-enter', 'body', { enter: 'true' }))
  assert.equal(strictBoolean.kind, 'DRAFT_EDIT')
})

test('slash paced keys empty CR and mixed controls stay unsupported while reply Stop and raw stay distinct', () => {
  const previous = draftOf(reduceTerminalDraft(null, unary('plain', 'kept body')))
  assert.equal(reduceTerminalDraft(null, unary('slash', '/command', { enter: true })).kind, 'UNSUPPORTED')
  assert.equal(reduceTerminalDraft(null, unary('paced', '1', {}, scope('paced',
    { semanticAdapterRequired: true }))).kind, 'UNSUPPORTED')
  assert.equal(reduceTerminalDraft(null, unary('empty-cr', '\r')).kind, 'UNSUPPORTED')
  assert.equal(reduceTerminalDraft(previous, unary('mixed', '\x15body')).kind, 'UNSUPPORTED')
  const stop = reduceTerminalDraft(previous, unary('stop', '\x1b'))
  assert.equal(stop.kind, 'STOP_CANDIDATE')
  assert.equal(stop.candidate, null)
  assert.deepEqual(draftOf(stop).chunks, previous.chunks)
  for (const reply of [unary('reply', '\x1b[1;2R', { inputKind: 'query-reply' }),
    binaryInput('binary-reply', '\x1b[1;2R')]) {
    const result = reduceTerminalDraft(previous, reply)
    assert.equal(result.kind, 'PROTOCOL_REPLY')
    assert.deepEqual(result.draft, previous)
  }
  const raw = scope('raw', { binding: { ...scope('raw').binding, mode: 'RAW_TERMINAL' },
    ptyIncarnationId: 'fixture-pty-a' })
  const currentRaw = reduceTerminalDraft(previous, unary('raw', '\x1b[A',
    { expectedIncarnationId: 'fixture-pty-a' }, raw))
  assert.equal(currentRaw.kind, 'RAW_CURRENT')
  assert.deepEqual(currentRaw.draft, previous)
  assert.equal(reduceTerminalDraft(null, unary('raw-mismatch', 'raw',
    { expectedIncarnationId: 'other-pty' }, raw)).kind, 'UNSUPPORTED')
  assert.equal(reduceTerminalDraft(null, unary('raw-missing', 'raw', {},
    { ...raw, ptyIncarnationId: null })).kind, 'UNSUPPORTED')
})

test('actual binary decoder separates frozen Input bytes from negotiated output ACK', () => {
  const server = binaryScope('wire-input')
  const wire = encodeTerminalStreamFrame({ opcode: TerminalStreamOpcode.Input,
    streamId: 1, seq: 7, payload: encodeTerminalStreamText('wire body') })
  const input = snapshotBinaryTerminalIngress(wire, server, [], () => true)
  wire.fill(0)
  assert.equal(input.kind, 'INPUT')
  if (input.kind !== 'INPUT') {
    throw new Error('Missing binary Input snapshot')
  }
  assert.equal(input.sequence, 7)
  const reducedInput = reduceTerminalDraft(null, input.snapshot)
  assert.equal(reducedInput.kind, 'DRAFT_EDIT')
  assert.equal(draftOf(reducedInput).chunks[0].text, 'wire body')
  const frame = (value: unknown, streamId = 1): Uint8Array => encodeTerminalStreamFrame({
    opcode: TerminalStreamOpcode.Ack, streamId, seq: 9, payload: encodeTerminalStreamJson(value)
  })
  let current = true
  const ack = snapshotBinaryTerminalIngress(frame({ bytes: 4 }), server, [], () => current)
  assert.equal(ack.kind, 'OUTPUT_ACK')
  assert.equal(Object.hasOwn(ack, 'snapshot'), false)
  if (ack.kind === 'OUTPUT_ACK') {
    assert.deepEqual(ack.ack, { bytes: 4 })
    current = false
    assert.equal(ack.isCurrent(), false)
  }
  assert.equal(snapshotBinaryTerminalIngress(frame({ bytes: 4, input: true }), server, [],
    () => true).kind, 'UNSUPPORTED')
  assert.equal(snapshotBinaryTerminalIngress(frame({ bytes: 4 }, 2), server, [],
    () => true).kind, 'UNSUPPORTED')
  const ranges = binaryScope('ranges')
  assert.ok(ranges.stream)
  const rangeScope = { ...ranges, stream: { ...ranges.stream, ackMode: 'SOURCE_RANGES' as const } }
  assert.equal(snapshotBinaryTerminalIngress(frame({ streamGeneration: 'other-generation', ackedEndByte: 4 }),
    rangeScope, [], () => true).kind, 'UNSUPPORTED')
  const rawScope = { ...server, binding: { ...server.binding, mode: 'RAW_TERMINAL' as const },
    ptyIncarnationId: 'fixture-pty-a' }
  const rawBytes = Uint8Array.from([0xff, 0x00])
  const raw = snapshotBinaryTerminalIngress(encodeTerminalStreamFrame({
    opcode: TerminalStreamOpcode.Input, streamId: 1, seq: 1, payload: rawBytes
  }), rawScope, [], () => true)
  assert.equal(raw.kind, 'INPUT')
  if (raw.kind === 'INPUT') {
    assert.deepEqual(raw.snapshot.inputBytes, Array.from(rawBytes))
    assert.equal(reduceTerminalDraft(null, raw.snapshot).kind, 'RAW_CURRENT')
  }
})

test('mobile native chat lone Ctrl+U clears the draft before its body', () => {
  const old = draftOf(reduceTerminalDraft(null, unary('old-body', 'stale typed text')))
  const cleared = reduceTerminalDraft(old, unary('mobile-clear', '\x15', { enter: false }))
  assert.equal(cleared.kind, 'DRAFT_EDIT')
  assert.deepEqual(draftOf(cleared).chunks, [])
  const submitted = reduceTerminalDraft(draftOf(cleared), unary('mobile-body', 'from the phone', { enter: true }))
  assert.equal(submitted.kind, 'SUBMIT_CANDIDATE')
  assert.equal(submitted.candidate?.text, 'from the phone')
})
