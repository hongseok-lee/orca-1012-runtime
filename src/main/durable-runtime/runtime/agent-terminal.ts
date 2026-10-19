import { createHash, randomUUID } from 'node:crypto'
import type { IPty, IPtyForkOptions } from 'node-pty'
import { TERMINAL_INPUT_MAX_BYTES } from '../../../shared/terminal-input.ts'

export type AgentTerminalOutput = Readonly<{
  incarnationId: string; startByte: number; endByte: number; bytes: string
}>
export type AgentTerminalWrite = Readonly<{
  incarnationId: string; status: 'WRITTEN' | 'UNKNOWN'; bytesWritten: number
}>
type Spawn = (file: string, args: string[], options: IPtyForkOptions) => Promise<IPty>
const unavailable = (): never => { throw new Error('AGENT_TERMINAL_UNAVAILABLE') }
function size(cols: unknown, rows: unknown): { cols: number; rows: number } {
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) ||
      Number(cols) < 1 || Number(cols) > 1000 || Number(rows) < 1 || Number(rows) > 500) {
    throw new Error('AGENT_TERMINAL_VIEWPORT')
  }
  return { cols: Number(cols), rows: Number(rows) }
}

/** One Pod-local PTY incarnation. Reconnection can read its retained output;
 * neither read/resize nor a failed write can create or replace a process.
 * The authenticated control owns admission and physical shutdown proof. */
export function createAgentTerminal(input: Readonly<{
  cwd: string; env: Record<string, string>; assertCurrent(): void
  onOutput(frame: AgentTerminalOutput): void
  onExit(incarnationId: string, exitCode: number, signal?: number): void
  spawn?: Spawn; maxRetainedBytes?: number
}>) {
  const cwd = input.cwd, env = { ...input.env }
  const assertCurrent = input.assertCurrent.bind(input)
  const onOutput = input.onOutput.bind(input), onExit = input.onExit.bind(input)
  const maxRetained = input.maxRetainedBytes ?? 1024 * 1024
  if (!Number.isSafeInteger(maxRetained) || maxRetained < 1) { throw new Error('AGENT_TERMINAL_BUFFER_LIMIT') }
  const spawn: Spawn = input.spawn ?? (async (file, args, options) => (await import('node-pty')).spawn(file, args, options))
  const incarnationId = randomUUID()
  let opening: Promise<Readonly<{ incarnationId: string; pid: number }>> | undefined
  let pty: IPty | undefined, live = false, uncertain = false, endByte = 0
  let retained = Buffer.alloc(0)
  const writes = new Map<string, { hash: string; result: AgentTerminalWrite }>()
  const requireLive = (expected: string) => {
    assertCurrent()
    if (!pty || !live || uncertain || expected !== incarnationId) { unavailable() }
    return pty!
  }
  return Object.freeze({
    inspect() {
      assertCurrent()
      return pty ? Object.freeze({ incarnationId, pid: pty.pid, live, uncertain,
        startByte: endByte - retained.length, endByte }) : null
    },
    /** Explicit creation only, once for the lifetime of this control. */
    open(cols: number, rows: number) {
      assertCurrent()
      const dimensions = size(cols, rows)
      if (!opening) {
        opening = (async () => {
          const child = await spawn('/bin/bash', ['--noprofile', '--norc'], {
            cwd, env, ...dimensions, name: 'xterm-256color', encoding: null
          })
          pty = child; live = true
          child.onData(data => {
            const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
            const startByte = endByte
            endByte += bytes.length
            if (!Number.isSafeInteger(endByte)) { uncertain = true; return }
            retained = Buffer.concat([retained, bytes]).subarray(-maxRetained)
            try { onOutput({ incarnationId, startByte, endByte, bytes: bytes.toString('base64') }) }
            catch { uncertain = true }
          })
          child.onExit(({ exitCode, signal }) => {
            live = false
            onExit(incarnationId, exitCode, signal)
          })
          try { assertCurrent() } catch (error) { uncertain = true; child.kill(); throw error }
          return Object.freeze({ incarnationId, pid: child.pid })
        })()
      }
      return opening
    },
    read(expected: string, fromByte: number) {
      assertCurrent()
      if (!pty || expected !== incarnationId) { unavailable() }
      if (!Number.isSafeInteger(fromByte) || fromByte < 0 || fromByte > endByte) {
        throw new Error('AGENT_TERMINAL_OUTPUT_CURSOR')
      }
      const firstByte = endByte - retained.length, startByte = Math.max(firstByte, fromByte)
      return Object.freeze({ incarnationId, startByte, endByte, truncated: fromByte < firstByte,
        live, uncertain, bytes: retained.subarray(startByte - firstByte).toString('base64') })
    },
    write(expected: string, requestId: string, encoded: string): AgentTerminalWrite {
      assertCurrent()
      if (expected !== incarnationId || !requestId || requestId.length > 256 ||
          encoded.length > Math.ceil(TERMINAL_INPUT_MAX_BYTES / 3) * 4) { unavailable() }
      const bytes = Buffer.from(encoded, 'base64')
      if (bytes.toString('base64') !== encoded || bytes.length > TERMINAL_INPUT_MAX_BYTES) {
        throw new Error('AGENT_TERMINAL_INPUT_ENCODING')
      }
      const hash = createHash('sha256').update(bytes).digest('hex'), previous = writes.get(requestId)
      if (previous) {
        if (previous.hash !== hash) { throw new Error('AGENT_TERMINAL_WRITE_CONFLICT') }
        return previous.result
      }
      const child = requireLive(expected)
      // Bound receipt memory by refusing new writes, never by evicting an
      // uncertain receipt and making its old request eligible for another write.
      if (writes.size >= 65536) { throw new Error('AGENT_TERMINAL_RECEIPT_LIMIT') }
      const unknown = Object.freeze({ incarnationId, status: 'UNKNOWN' as const, bytesWritten: 0 })
      writes.set(requestId, { hash, result: unknown })
      try { child.write(bytes) } catch { uncertain = true; return unknown }
      const result = Object.freeze({ incarnationId, status: 'WRITTEN' as const, bytesWritten: bytes.length })
      writes.set(requestId, { hash, result })
      return result
    },
    resize(expected: string, cols: number, rows: number): void {
      const dimensions = size(cols, rows), child = requireLive(expected)
      try { child.resize(dimensions.cols, dimensions.rows) }
      catch { uncertain = true; throw new Error('AGENT_TERMINAL_RESIZE_UNKNOWN') }
    },
    /** Requests shutdown of the owned PTY; not proof that its descendants or
     * the Pod stopped. The physical lifecycle owner must collect that proof. */
    requestClose(): void {
      if (!pty || !live) { return }
      uncertain = true
      pty.kill()
    }
  })
}
