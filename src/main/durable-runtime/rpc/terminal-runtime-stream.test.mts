import test from 'node:test'
import assert from 'node:assert/strict'
import { streamCatalogTerminal } from './terminal-runtime-stream.ts'
import { RuntimeSubscriptionRegistry } from '../../runtime/runtime-subscription-registry.ts'
import { decodeTerminalStreamFrame, encodeTerminalStreamJson, type TerminalStreamFrame, TerminalStreamOpcode as Opcode } from '../../../shared/terminal-stream-protocol.ts'
import { handleTerminalBinaryFrame } from '../../../../mobile/src/transport/rpc-client-terminal-binary-frame.ts'
import { createAgentTerminal } from '../runtime/agent-terminal.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const params = { terminal: 'term_owned', capabilities: { terminalBinaryStream: 1 as const } }
function harness(backpressure = false) {
  const registry = new RuntimeSubscriptionRegistry(), abort = new AbortController()
  const frames: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>[] = [], mobile: unknown[] = [], json: unknown[] = []
  const terminalSnapshots = new Map()
  let receive: (frame: TerminalStreamFrame) => void = () => {}
  const context = { connectionId: 'connection', signal: abort.signal,
    runtime: { registerOwnedSubscriptionCleanup: registry.registerOwned.bind(registry) },
    registerBinaryStreamHandler: (_id: number, handler: typeof receive) => { receive = handler; return () => { receive = () => {} } },
    sendBinary: (bytes: Uint8Array) => {
      frames.push(decodeTerminalStreamFrame(bytes)!)
      handleTerminalBinaryFrame(bytes, { terminalSnapshots, getListener: () => item => mobile.push(item) })
      return !backpressure
    } }
  return { context, frames, mobile, json, abort, receive: (frame: TerminalStreamFrame) => receive(frame), emit: (frame: unknown) => { json.push(frame) } }
}
const status = async () => ({ incarnationId: 'incarnation', cols: 80, rows: 24 })
const output = (bytes: Buffer, startByte: number, live: boolean, truncated = false) => ({
  incarnationId: 'incarnation', startByte, endByte: startByte + bytes.length, bytes: bytes.toString('base64'), live, truncated
})

test('actual mobile decoder preserves Korean split between snapshot and live PTY reads', async () => {
  const h = harness(), text = '한글 출력', bytes = Buffer.from(text)
  let reads = 0
  await streamCatalogTerminal(params, h.context as never, h.emit, { status, read: async (_id, cursor) => {
    reads++
    if (reads === 1) { assert.equal(cursor, 0); return output(bytes.subarray(0, 2), 0, true) }
    assert.equal(cursor, 2); return output(bytes.subarray(2), 2, false)
  } })
  const rendered = h.mobile.map(v => (v as { serialized?: string; chunk?: string }).serialized ?? (v as { chunk?: string }).chunk ?? '').join('')
  assert.equal(rendered, text)
  assert.deepEqual(h.frames.map(f => f.seq), h.frames.map((_, i) => i))
  assert.equal((h.json.at(-1) as { type: string }).type, 'end')
})

test('disconnect during read suppresses output and releases subscription', async () => {
  const h = harness()
  await streamCatalogTerminal(params, h.context as never, h.emit, { status, read: async () => {
    h.abort.abort(); return output(Buffer.from('must not escape'), 0, true)
  } })
  assert.deepEqual(h.frames, [])
  assert.deepEqual(h.json, [{ type: 'end' }])
})

test('output gaps and transport backpressure terminate rather than fabricate continuous history', async () => {
  const h = harness()
  let reads = 0
  await assert.rejects(streamCatalogTerminal(params, h.context as never, h.emit, { status, read: async () => {
    return ++reads === 1 ? output(Buffer.from('old'), 0, true) : output(Buffer.from('tail'), 10, false, true)
  } }), /TERMINAL_OUTPUT_GAP/)
  assert.equal(h.frames.some(f => f.opcode === Opcode.Output), false)
  const blocked = harness(true)
  await assert.rejects(streamCatalogTerminal(params, blocked.context as never, blocked.emit,
    { status, read: async () => output(Buffer.from('data'), 0, false) }), /TERMINAL_OUTPUT_BACKPRESSURE/)
  assert.equal(blocked.frames.length, 1)
  assert.equal((blocked.json.at(-1) as { type: string }).type, 'end')
})

test('real native PTY output reaches the existing mobile binary decoder with actual dimensions', async () => {
  const h = harness(), cwd = await mkdtemp(join(tmpdir(), 'orca-task05-stream-'))
  let exited!: () => void
  const exit = new Promise<void>(resolve => { exited = resolve })
  const terminal = createAgentTerminal({ cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, PS1: '' },
    assertCurrent() {}, onOutput() {}, onExit() { exited() } })
  const timeout = setTimeout(() => h.abort.abort(), 5000)
  try {
    await terminal.open(80, 24)
    const inspect = terminal.inspect()!
    assert.equal(inspect.cols, 80); assert.equal(inspect.rows, 24)
    const sendBinary = h.context.sendBinary
    h.context.sendBinary = bytes => {
      const result = sendBinary(bytes)
      const rendered = h.mobile.map(v => (v as { serialized?: string; chunk?: string }).serialized ?? (v as { chunk?: string }).chunk ?? '').join('')
      if (rendered.includes('37 91\r\n') && rendered.includes('STREAM_OK\r\n')) { h.abort.abort() }
      return result
    }
    await streamCatalogTerminal(params, h.context as never, frame => {
      h.emit(frame)
      if ((frame as { type: string }).type === 'subscribed') {
        const streamId = (frame as { streamId: number }).streamId
        h.receive({ streamId, seq: 0, opcode: Opcode.Resize, payload: encodeTerminalStreamJson({ cols: 91, rows: 37 }) })
        h.receive({ streamId, seq: 0, opcode: Opcode.Input, payload: Buffer.from("stty -echo; stty size\r") })
        h.receive({ streamId, seq: 0, opcode: Opcode.Input, payload: Buffer.from("printf '\\123\\124\\122\\105\\101\\115\\137\\117\\113\\n'\r") })
      }
    }, { status: async () => terminal.inspect(), read: async (id, cursor) => terminal.read(id, cursor) }, {
      close() {},
      write: async (id, bytes, key) => terminal.write(id,key,Buffer.from(bytes).toString('base64')),
      resize: async (id, cols, rows) => { terminal.resize(id,cols,rows); return { resized:true } }
    })
    const rendered = h.mobile.map(v => (v as { serialized?: string; chunk?: string }).serialized ?? (v as { chunk?: string }).chunk ?? '').join('')
    assert.match(rendered, /37 91\r\n/)
    assert.match(rendered, /STREAM_OK\r\n/)
    assert.equal(terminal.inspect()!.cols,91); assert.equal(terminal.inspect()!.rows,37)
  } finally {
    clearTimeout(timeout); terminal.requestClose(); await exit; await rm(cwd, { recursive: true })
  }
})
