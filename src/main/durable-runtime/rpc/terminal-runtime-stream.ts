import { TERMINAL_INPUT_MAX_BYTES } from '../../../shared/terminal-input.ts'
import type { createCatalogTerminalActions } from './terminal-runtime-actions.ts'
import { StringDecoder } from 'node:string_decoder'
import { iterateTerminalStreamTextPayloads } from '../../runtime/rpc/methods/terminal/terminal-stream-replay.ts'
import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { TerminalSubscribe } from '../../../shared/rpc-contract/terminal-stream-params.ts'
import { TerminalStreamOpcode as Opcode, encodeTerminalStreamFrame, encodeTerminalStreamJson, decodeTerminalStreamJson } from '../../../shared/terminal-stream-protocol.ts'
import { allocateTerminalSubscriptionStreamId } from '../../runtime/rpc/methods/terminal/terminal-subscription-stream-id.ts'
import type { borrowTerminalRuntimeReader } from '../runtime/terminal-runtime-reader.ts'

type Reader = ReturnType<typeof borrowTerminalRuntimeReader>
const invalid = (): never => { throw new Error('TERMINAL_OUTPUT_INVALID') }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return invalid() }
  return value as Record<string, unknown>
}
function readOutput(value: unknown, incarnationId: string, fromByte: number) {
  const r = record(value)
  if (r.incarnationId !== incarnationId || !Number.isSafeInteger(r.startByte) || !Number.isSafeInteger(r.endByte) ||
      Number(r.startByte) < fromByte || Number(r.endByte) < Number(r.startByte) ||
      typeof r.bytes !== 'string' || r.bytes.length > 2 * 1024 * 1024 || typeof r.live !== 'boolean' ||
      typeof r.truncated !== 'boolean' || r.truncated !== (Number(r.startByte) > fromByte)) { return invalid() }
  const bytes = Buffer.from(r.bytes, 'base64')
  if (bytes.toString('base64') !== r.bytes || bytes.length !== Number(r.endByte) - Number(r.startByte)) { return invalid() }
  return { bytes, endByte: Number(r.endByte), live: r.live, truncated: r.truncated }
}

/** Existing binary wire with scoped input/viewport controls. Retained output
 * bytes are observations, never input to a new process. */
export async function streamCatalogTerminal(params: ReturnType<typeof TerminalSubscribe.parse>, context: RpcContext,
  emit: (frame: unknown) => void, reader: Reader, actions?: ReturnType<typeof createCatalogTerminalActions>, onReady?: (incarnationId: string) => () => void): Promise<void> {
  if (!context.sendBinary || !context.registerBinaryStreamHandler || params.capabilities?.terminalBinaryStream !== 1) {
    throw new Error('binary_terminal_stream_required')
  }
  const streamId = allocateTerminalSubscriptionStreamId()
  let closed = false, seq = 0, ingress = 0, cursor = 0, timer: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined, unregister = () => {}, detach = () => {}
  const end = () => {
    if (closed) { return }
    closed = true; actions?.close(); detach(); clearTimeout(timer); wake?.(); unregister()
    context.signal?.removeEventListener('abort', abort)
    try { emit({ type: 'end' }) } catch { /* disconnected */ }
  }
  const registration = context.runtime.registerOwnedSubscriptionCleanup(
    params.client?.id ? `${params.terminal}:${params.client.id}` : params.terminal, end, context.connectionId)
  const abort = () => registration.releaseIfCurrent()
  const send = (opcode: Opcode, payload: Uint8Array<ArrayBufferLike> = new Uint8Array()) => {
    if (closed) { return }
    if (context.sendBinary!(encodeTerminalStreamFrame({ opcode, streamId, seq: seq++, payload })) === false) {
      throw new Error('TERMINAL_OUTPUT_BACKPRESSURE')
    }
  }
  const decoder = new StringDecoder('utf8')
  const chunks = (opcode: Opcode, text: string) => {
    for (const payload of iterateTerminalStreamTextPayloads(text)) { send(opcode, payload) }
  }
  try {
    if (context.signal?.aborted) { return }
    context.signal?.addEventListener('abort', abort, { once: true })
    const status = record(await reader.status())
    if (closed) { return }
    if (typeof status.incarnationId !== 'string' || !Number.isSafeInteger(status.cols) || !Number.isSafeInteger(status.rows)) { invalid() }
    const incarnationId = status.incarnationId as string
    const initial = readOutput(await reader.read(incarnationId, 0), incarnationId, 0)
    if (closed) { return }
    unregister = context.registerBinaryStreamHandler(streamId, frame => {
      if (closed || frame.streamId !== streamId) { return }
      if (frame.opcode === Opcode.Unsubscribe) { abort(); return }
      const reject = () => {
        if (closed) { return }
        try { send(Opcode.Error, encodeTerminalStreamJson({ code: 'TERMINAL_WRITE_UNAVAILABLE' })) } catch { abort() }
      }
      // Existing desktop sends seq=0 for every control frame. The socket already
      // orders delivery; sequence is not a client idempotency key.
      const key = JSON.stringify(['BINARY', streamId, ++ingress])
      if (frame.opcode === Opcode.Input) {
        if (!actions || frame.payload.length > TERMINAL_INPUT_MAX_BYTES) { reject(); return }
        try {
          void actions.write(incarnationId, frame.payload, key).then(result => {
            if (result.status !== 'WRITTEN') { reject() }
          }, reject)
        } catch { reject() }
      } else if (frame.opcode === Opcode.Resize || frame.opcode === Opcode.ClaimViewport) {
        const viewport = decodeTerminalStreamJson<{ cols?: unknown; rows?: unknown }>(frame.payload)
        if (!actions || typeof viewport?.cols !== 'number' || typeof viewport.rows !== 'number') { reject(); return }
        const { cols, rows } = viewport
        try {
          void actions.resize(incarnationId, cols, rows, key).then(() => {
            if (!closed) { send(Opcode.Resized, encodeTerminalStreamJson({ cols, rows })) }
          }).catch(reject)
        } catch { reject() }
      }
    })
    detach = onReady?.(incarnationId) ?? (() => {})
    emit({ type: 'subscribed', streamId, lines: [], truncated: initial.truncated, cols: status.cols, rows: status.rows })
    send(Opcode.SnapshotStart, encodeTerminalStreamJson({ kind: 'scrollback', cols: status.cols, rows: status.rows,
      truncated: initial.truncated }))
    chunks(Opcode.SnapshotChunk, decoder.write(initial.bytes))
    send(Opcode.SnapshotEnd)
    cursor = initial.endByte
    let live = initial.live
    while (!closed && live) {
      await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 250) })
      wake = undefined
      if (closed) { break }
      const output = readOutput(await reader.read(incarnationId, cursor), incarnationId, cursor)
      if (closed) { break }
      // A missing range is not a screen snapshot. End explicitly so a new
      // subscription can present a fresh, honestly truncated history.
      if (output.truncated) { throw new Error('TERMINAL_OUTPUT_GAP') }
      chunks(Opcode.Output, decoder.write(output.bytes))
      cursor = output.endByte; live = output.live
    }
    if (!closed) { chunks(Opcode.Output, decoder.end()) }
  } finally { registration.releaseIfCurrent() }
}
