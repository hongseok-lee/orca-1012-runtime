import { createConnection, createServer } from 'node:net'
import type { Socket } from 'node:net'
import { lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import type { Readable } from 'node:stream'

/** Inside the Agent Pod, per-pod emptyDir. The socket dies with the Pod, so a
 * failed connect from the same Pod is a reliable "host gone" answer, unlike a
 * socket file seen through shared NFS from another Pod. */
export const AGENT_CONTROL_HOST_SOCKET = '/tmp/orca-agent-control/host.sock'
export const AGENT_CONTROL_HOST_FLAG = '--orca-agent-control-host'
const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024
const MAX_LINE_BYTES = 4 * 1024 * 1024

export type AgentControlHostControl = Readonly<{ closed: Promise<void> }>
export type AgentControlHostOptions = Readonly<{
  socketPath: string
  /** Starts the provider control on private streams owned by the host. The
   * streams never end when a connection is lost, so the control keeps its
   * provider and native session across reconnects. */
  createControl(init: Readonly<Record<string, unknown>>, input: Readable, output: Writable): AgentControlHostControl
  /** Fresh projected Pod token for each re-attach; the HELLO copy is stripped. */
  readPodBearer(): string
  maxBufferedBytes?: number
}>
export type AgentControlHostState = Readonly<{
  attached: boolean; term: number; controlId: string; nextSeq: number; bufferedFrames: number; maxRequestId: number
}>

export class AgentControlHostOccupiedError extends Error {
  constructor() { super('AGENT_CONTROL_HOST_OCCUPIED'); this.name = 'AgentControlHostOccupiedError' }
}

type Probe = 'connected' | 'missing' | 'refused' | 'unknown'
function probeSocket(path: string): Promise<Probe> {
  try { lstatSync(path) } catch (error) {
    return Promise.resolve(Reflect.get(Object(error), 'code') === 'ENOENT' ? 'missing' : 'unknown')
  }
  return new Promise(resolve => {
    const socket = createConnection({ path })
    const timer = setTimeout(() => { socket.destroy(); resolve('unknown') }, 500)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve('connected') })
    socket.once('error', error => {
      clearTimeout(timer)
      resolve(Reflect.get(error, 'code') === 'ECONNREFUSED' ? 'refused' : 'unknown')
    })
  })
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function parse(line: string): Record<string, unknown> | null {
  try { return object(JSON.parse(line)) } catch { return null }
}
function onLines(stream: Readable, line: (text: string) => void, overflow: () => void): void {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', (text: string) => {
    pending += text
    let newline: number
    while ((newline = pending.indexOf('\n')) >= 0) {
      const next = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      line(next)
    }
    if (Buffer.byteLength(pending) > MAX_LINE_BYTES) { pending = ''; overflow() }
  })
}

/** Long-lived process in the Agent Pod that owns one provider control. A
 * connection is only a transport: losing it detaches, and a later connection
 * re-attaches with ATTACH. Same pattern as the original Orca SSH relay daemon
 * and its per-connection `--connect` bridge. One attachment at a time; a newer
 * controller term replaces it, an older one is refused. */
export function startAgentControlHost(options: AgentControlHostOptions): Readonly<{
  listening: Promise<void>
  closed: Promise<void>
  state(): AgentControlHostState
  /** Stops listening and drops connections. It does not stop the control;
   * the provider is stopped only through the control's own CLOSE. */
  close(): void
}> {
  const maxBuffered = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES
  let control: AgentControlHostControl | null = null
  let controlId = '', hello: Record<string, unknown> | null = null
  let current: Socket | null = null, currentTerm = -1, nextSeq = 1, maxRequestId = 0
  let shutDown = false
  const buffered: { seq: number; line: string; bytes: number }[] = []
  let bufferedBytes = 0
  let resolveClosed!: () => void
  const closed = new Promise<void>(resolve => { resolveClosed = resolve })
  const input = new PassThrough()
  let partial = ''
  const output = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      partial += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let newline: number
      while ((newline = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, newline)
        partial = partial.slice(newline + 1)
        emit(line)
      }
      done()
    },
  })

  function send(socket: Socket, value: unknown): void {
    if (!socket.destroyed) { socket.write(`${JSON.stringify(value)}\n`) }
  }
  function emit(line: string): void {
    const frame = parse(line)
    if (!frame) { return }
    const seq = nextSeq++
    const live = JSON.stringify({ ...frame, hostSeq: seq })
    let stored = live
    if (frame.event === 'HELLO') {
      const { podBearer: _secret, ...rest } = frame
      hello = rest
      controlId = typeof frame.controlId === 'string' ? frame.controlId : ''
      stored = JSON.stringify({ ...rest, hostSeq: seq })
    }
    const bytes = Buffer.byteLength(stored)
    buffered.push({ seq, line: stored, bytes })
    bufferedBytes += bytes
    while (bufferedBytes > maxBuffered && buffered.length > 1) {
      bufferedBytes -= buffered.shift()?.bytes ?? 0
    }
    if (current && !current.destroyed) { current.write(`${live}\n`) }
  }
  function acknowledge(seq: number): void {
    while (buffered.length && buffered[0].seq <= seq) { bufferedBytes -= buffered.shift()?.bytes ?? 0 }
  }
  function attach(socket: Socket, term: number): void {
    if (current && current !== socket) {
      send(current, { event: 'HOST_EVICTED', term })
      current.end()
    }
    current = socket
    currentTerm = term
  }
  function reject(socket: Socket, reason: string): false {
    send(socket, { event: 'HOST_REJECTED', reason })
    socket.end()
    return false
  }
  function shutdown(): void {
    if (shutDown) { return }
    shutDown = true
    server.close()
    try { unlinkSync(options.socketPath) } catch { /* already gone */ }
    current?.end()
    current = null
    for (const socket of sockets) { socket.destroy() }
    resolveClosed()
  }
  function handshake(socket: Socket, line: string): boolean {
    const frame = parse(line)
    if (!frame) { return reject(socket, 'FRAME') }
    if (frame.method === 'INITIALIZE') {
      if (control) { return reject(socket, 'CONTROL_EXISTS') }
      const term = frame.term ?? 0
      if (!Number.isSafeInteger(term) || Number(term) < 0) { return reject(socket, 'TERM') }
      attach(socket, Number(term))
      try { control = options.createControl(frame, input, output) } catch {
        reject(socket, 'CONTROL_INIT_FAILED')
        shutdown()
        return false
      }
      void control.closed.then(shutdown, shutdown)
      return true
    }
    if (frame.method === 'ATTACH') {
      if (!control || !hello) { return reject(socket, 'NO_CONTROL') }
      if (frame.controlId !== controlId) { return reject(socket, 'CONTROL_MISMATCH') }
      if (!Number.isSafeInteger(frame.term) || Number(frame.term) < currentTerm) { return reject(socket, 'STALE_TERM') }
      if (!Number.isSafeInteger(frame.lastSeq) || Number(frame.lastSeq) < 0) { return reject(socket, 'LAST_SEQ') }
      const term = Number(frame.term), lastSeq = Number(frame.lastSeq)
      let podBearer = ''
      try { podBearer = options.readPodBearer() } catch { /* identity re-proof is the client's decision */ }
      attach(socket, term)
      const oldest = buffered[0]?.seq ?? nextSeq
      const gap = lastSeq + 1 < oldest ? { from: lastSeq + 1, to: oldest - 1 } : null
      send(socket, { event: 'ATTACHED', controlId, term, nextRequestId: maxRequestId + 1, nextSeq, gap,
        hello: { ...hello, podBearer } })
      for (const item of buffered) {
        if (item.seq > lastSeq) { socket.write(`${item.line}\n`) }
      }
      return true
    }
    return reject(socket, 'METHOD')
  }
  function forward(socket: Socket, line: string): void {
    if (socket !== current) { return }
    const frame = parse(line)
    if (frame && Object.keys(frame).length === 1 && Number.isSafeInteger(frame.hostAck)) {
      acknowledge(Number(frame.hostAck))
      return
    }
    if (frame && typeof frame.id === 'string' && /^[1-9]\d*$/.test(frame.id)) {
      maxRequestId = Math.max(maxRequestId, Number(frame.id))
    }
    // The control keeps its own frame validation; the host does not rewrite requests.
    input.write(`${line}\n`)
  }

  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    let first = true, accepted = false
    sockets.add(socket)
    socket.on('error', () => { /* a lost connection only detaches */ })
    socket.on('close', () => { sockets.delete(socket); if (current === socket) { current = null } })
    onLines(socket, line => {
      if (first) { first = false; accepted = handshake(socket, line); return }
      if (accepted) { forward(socket, line) }
    }, () => socket.destroy())
  })
  const listening = (async () => {
    mkdirSync(dirname(options.socketPath), { recursive: true, mode: 0o700 })
    const probe = await probeSocket(options.socketPath)
    if (probe === 'connected') { throw new AgentControlHostOccupiedError() }
    if (probe === 'unknown') { throw new Error('AGENT_CONTROL_HOST_ENDPOINT_UNKNOWN') }
    if (probe === 'refused') { unlinkSync(options.socketPath) }
    await new Promise<void>((resolve, failed) => {
      server.once('error', failed)
      server.listen(options.socketPath, () => { server.off('error', failed); resolve() })
    })
  })()
  return Object.freeze({
    listening, closed, close: shutdown,
    state: () => Object.freeze({ attached: !!current && !current.destroyed, term: currentTerm, controlId, nextSeq,
      bufferedFrames: buffered.length, maxRequestId }),
  })
}

export type AgentControlBridgeOptions = Readonly<{
  socketPath: string
  input: Readable
  output: Writable
  /** Starts a detached host; only called for INITIALIZE when no host answers. */
  spawnHost(): void
  connectTimeoutMs?: number
}>
export type AgentControlBridgeResult = 'BRIDGED' | 'NO_HOST' | 'HOST_START_FAILED' | 'FRAME'

function connect(path: string): Promise<Socket | null> {
  return new Promise(resolve => {
    const socket = createConnection({ path })
    socket.once('connect', () => { socket.removeAllListeners('error'); resolve(socket) })
    socket.once('error', () => resolve(null))
  })
}
function readFirstLine(input: Readable): Promise<{ line: Buffer; rest: Buffer } | null> {
  return new Promise(resolve => {
    let collected = Buffer.alloc(0)
    function data(chunk: Buffer | string): void {
      collected = Buffer.concat([collected, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      const newline = collected.indexOf(10)
      if (newline !== -1) {
        cleanup()
        input.pause()
        resolve({ line: collected.subarray(0, newline), rest: collected.subarray(newline + 1) })
      } else if (collected.length > MAX_LINE_BYTES) { cleanup(); resolve(null) }
    }
    function end(): void { cleanup(); resolve(null) }
    function cleanup(): void { input.off('data', data); input.off('end', end) }
    input.on('data', data)
    input.once('end', end)
  })
}

/** Runs once per exec connection. Bridges the exec stdio to the Pod-local host
 * socket verbatim; it owns nothing, so its death never affects the provider. */
export async function runAgentControlBridge(options: AgentControlBridgeOptions): Promise<AgentControlBridgeResult> {
  const timeoutMs = options.connectTimeoutMs ?? 10_000
  const refuse = (reason: string): void => { options.output.end(`${JSON.stringify({ event: 'HOST_REJECTED', reason })}\n`) }
  const head = await readFirstLine(options.input)
  const method = head ? parse(head.line.toString('utf8'))?.method : undefined
  if (!head || (method !== 'INITIALIZE' && method !== 'ATTACH')) { refuse('FRAME'); return 'FRAME' }
  let socket = await connect(options.socketPath)
  if (!socket && method === 'ATTACH') { refuse('NO_HOST'); return 'NO_HOST' }
  if (!socket) {
    options.spawnHost()
    const deadline = Date.now() + timeoutMs
    while (!socket && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
      socket = await connect(options.socketPath)
    }
  }
  if (!socket) { refuse('HOST_START_FAILED'); return 'HOST_START_FAILED' }
  const bridged = socket
  bridged.on('error', () => bridged.destroy())
  bridged.write(Buffer.concat([head.line, Buffer.from('\n'), head.rest]))
  options.input.pipe(bridged)
  bridged.pipe(options.output)
  options.input.resume()
  await new Promise<void>(resolve => bridged.once('close', () => resolve()))
  options.input.unpipe(bridged)
  return 'BRIDGED'
}
