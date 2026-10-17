import { TextDecoder, isDeepStrictEqual } from 'node:util'
import WebSocket from 'ws'
import type { ClientOptions } from 'ws'
import type { CodexAppServerConnection, CodexAppServerConnectionHandlers } from '../../codex/codex-app-server-connection-types.ts'
import type { CodexProtocolDependencies } from '../providers/codex/protocol.ts'
import { immutableSnapshot } from '../providers/shared/recovery-renderer.ts'
import { awaitPodAuthValue } from './kubernetes-pod-auth-transport.ts'
import { bearerValid } from './kubernetes-pod-auth-projection.ts'
import type { createKubernetesPodAuthenticator } from './kubernetes-pod-auth.ts'
import type { AuthenticatedPodObservation, KubernetesPodAuthExpected } from './kubernetes-pod-auth-types.ts'
import type { ManagedLeafSocket } from '../storage/managed-leaf-collector-types.ts'
import type { AgentCodexControlPolicy } from './agent-codex-control.ts'

/** Fixed bootstrap only; neither a path nor executable source comes from RPC.
 * The original owned bundle is checked before requiring it. No provider env or
 * token appears in argv, exec URL, a digest, or operator-visible output. */
export const agentCodexBootstrap = `const fs=require('node:fs'),crypto=require('node:crypto');
const path='/tmp/orca-agent-control.cjs',fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
const stat=fs.fstatSync(fd),bytes=fs.readFileSync(fd);fs.closeSync(fd);
if(!stat.isFile()||stat.uid!==1000||stat.nlink!==1||bytes.length>4194304||crypto.createHash('sha256').update(bytes).digest('hex')!==process.argv[1])throw Error('AGENT_CONTROL_BUNDLE');
const execute=require('node:vm').runInThisContext('(function(require,module,exports,__filename,__dirname){\\n'+bytes.toString('utf8')+'\\n})',{filename:path});
const owned={exports:{}};execute(require,owned,owned.exports,path,'/tmp');`

export type AgentCodexTransportConfiguration = Readonly<{
  apiOrigin: string; ca: Uint8Array; namespace: string; container: string; timeoutMs: number
  bootstrapSha256: string
  expected: KubernetesPodAuthExpected
  policy: AgentCodexControlPolicy
  podAuthenticator: ReturnType<typeof createKubernetesPodAuthenticator>
  readReviewerBearer(signal: AbortSignal): string | Promise<string>
}>
export type AuthenticatedAgentControl = Readonly<{
  controlId: string; controlPid: number; startTicks: string
  root: Readonly<{ path: string; device: string; inode: string }>
  pod: AuthenticatedPodObservation
  valid(): boolean
  transport: Pick<CodexProtocolDependencies, 'open'>
  close(): Promise<boolean>
  physicalPinIssued: false
}>
const issued = new WeakSet<AuthenticatedAgentControl>()
export function authenticatedAgentControlValid(value: AuthenticatedAgentControl): boolean {
  return issued.has(value) && value.valid()
}
const fail = (): Error => new Error('AGENT_CODEX_CONTROL_UNCONFIRMED')

/** Trusted backend composition. Opens only a CLOSED control process in the
 * Agent, authenticates its real Pod-bound token with the existing verifier,
 * then hands its lifetime to one owner. It does not activate grants or issue a
 * physical pin. The native opener is private to the actual-COMMIT executor. */
export function createAgentCodexTransport(original: AgentCodexTransportConfiguration) {
  if (!(original.ca instanceof Uint8Array) || !original.ca.byteLength) { throw fail() }
  const ca = Buffer.from(original.ca)
  const config = immutableSnapshot({ apiOrigin: original.apiOrigin,
    namespace: original.namespace, container: original.container, timeoutMs: original.timeoutMs,
    bootstrapSha256: original.bootstrapSha256, expected: original.expected, policy: original.policy })
  const reviewer = original.readReviewerBearer.bind(original)
  const authenticate = original.podAuthenticator.authenticatePod.bind(original.podAuthenticator)
  let origin: URL
  try { origin = new URL(config.apiOrigin) } catch { throw fail() }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      !/^[0-9a-f]{64}$/.test(config.bootstrapSha256) || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 ||
      config.timeoutMs > 2_147_483_647 || !/^[a-z0-9-]+$/.test(config.namespace) || !/^[a-z0-9-]+$/.test(config.container)) { throw fail() }
  let preparedOnce = false
  return Object.freeze({ async prepare(signal: AbortSignal): Promise<AuthenticatedAgentControl> {
    // A failed/unknown original control is reconciled through its own handle;
    // this factory cannot open a second control process for the same attempt.
    if (preparedOnce) { throw fail() }
    preparedOnce = true
    const acquisition = new AbortController(), abortAcquisition = () => acquisition.abort()
    const budget = setTimeout(abortAcquisition, config.timeoutMs)
    signal.addEventListener('abort', abortAcquisition, { once: true })
    if (signal.aborted) { acquisition.abort() }
    let bearer = ''
    try {
      bearer = await awaitPodAuthValue(Promise.resolve(reviewer(acquisition.signal)), acquisition.signal)
      if (!bearerValid(bearer) || acquisition.signal.aborted) { throw fail() }
      return await new Promise<AuthenticatedAgentControl>((resolve, reject) => {
        let socket: ManagedLeafSocket | undefined, send: unknown, handshake = false, transferred = false
        let lost = false, socketClosed = false, openedNative = false, controlId = '', buffer = '', status = ''
        let handlers: CodexAppServerConnectionHandlers = {}, nativePid: number | undefined
        let closing: Promise<boolean> | undefined, nativeExitReported = false
        let resolveClosed!: (confirmed: boolean) => void
        const closed = new Promise<boolean>(done => { resolveClosed = done })
        const streams = new Map([1, 2, 3].map(id => [id, { decoder: new TextDecoder('utf-8', { fatal: true }), closed: false }]))
        const pending = new Map<string, { method: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
        let nextId = 1, stopAcknowledged = false
        function failure(): void {
          lost = true
          for (const value of pending.values()) { clearTimeout(value.timer); value.reject(fail()) }
          pending.clear()
          if (!transferred) { reject(fail()) }
          if (!nativeExitReported) { nativeExitReported = true; handlers.onExit?.(fail()) }
        }
        function write(frame: unknown): void {
          if (!handshake || socketClosed || typeof send !== 'function') { throw fail() }
          Reflect.apply(send, socket, [Buffer.concat([Buffer.from([0]), Buffer.from(`${JSON.stringify(frame)}\n`)]),
            (error?: Error) => { if (error) { failure() } }])
        }
        function request(method: string, params?: Record<string, unknown>, timeoutMs = config.timeoutMs): Promise<unknown> {
          if (!controlId || socketClosed || lost && method !== 'CLOSE' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
            return Promise.reject(fail())
          }
          const id = String(nextId++)
          return new Promise((done, bad) => {
            const timer = setTimeout(() => { pending.delete(id); lost = true; bad(fail()) }, timeoutMs)
            pending.set(id, { method, resolve: done, reject: bad, timer })
            try { write({ controlId, id, method, ...(method === 'COLD' ? { launch: config.policy.launch } : { params }) }) }
            catch { failure() }
          })
        }
        async function close(): Promise<boolean> {
          if (closing) { return closing }
          closing = (async () => {
            if (socketClosed || !controlId) { return false }
            try {
              const ack = await request('CLOSE')
              stopAcknowledged = !!ack && typeof ack === 'object' && Reflect.get(ack, 'stopped') === true && Reflect.get(ack, 'controlId') === controlId
              if (!stopAcknowledged) { return false }
              let timer: ReturnType<typeof setTimeout> | undefined
              try { return await Promise.race([closed, new Promise<boolean>(done => { timer = setTimeout(() => done(false), config.timeoutMs) })]) }
              finally { clearTimeout(timer) }
            } catch { return false }
          })()
          return closing
        }
        const connection: CodexAppServerConnection = Object.freeze({
          get pid() { return nativePid }, get closed() { return lost || socketClosed },
          request: (method, params, options) => request(method, params, options?.timeoutMs),
          // The existing Agent-side connection owns initialization/reply
          // channels. No public method or response can create another process.
          notify() {}, respond() {}, respondWithError() {}, close,
        })
        async function frame(value: unknown): Promise<void> {
          if (!value || typeof value !== 'object' || Array.isArray(value)) { throw fail() }
          const record = value as Record<string, unknown>
          if (record.event === 'HELLO') {
            if (controlId || typeof record.controlId !== 'string' || !/^[0-9a-f-]{36}$/.test(record.controlId) ||
                !Number.isSafeInteger(record.pid) || Number(record.pid) < 1 || typeof record.startTicks !== 'string' ||
                !/^[1-9]\d*$/.test(record.startTicks) || !bearerValid(record.podBearer)) { throw fail() }
            const root = record.root
            if (!root || typeof root !== 'object' || Reflect.get(root, 'path') !== config.policy.protectedRoot ||
                !/^\d+$/.test(Reflect.get(root, 'device')) || !/^[1-9]\d*$/.test(Reflect.get(root, 'inode'))) { throw fail() }
            controlId = record.controlId
            const podBearer = record.podBearer; delete record.podBearer
            const pod = await authenticate({ podBearer, expected: config.expected }, acquisition.signal)
            if (lost || socketClosed || acquisition.signal.aborted || pod.pod.uid !== config.expected.podUid) { throw fail() }
            // Request cancellation no longer owns the live control resource.
            transferred = true; acquisition.signal.removeEventListener('abort', cancelled)
            const control: AuthenticatedAgentControl = Object.freeze({ controlId, controlPid: Number(record.pid), startTicks: record.startTicks,
              root: Object.freeze({ path: config.policy.protectedRoot, device: String(Reflect.get(root, 'device')), inode: String(Reflect.get(root, 'inode')) }),
              pod, valid: () => !lost && !socketClosed && !closing, close, physicalPinIssued: false as const,
              transport: Object.freeze({ async open(launch: Parameters<CodexProtocolDependencies['open']>[0], supplied: CodexAppServerConnectionHandlers) {
                if (openedNative || lost || socketClosed || closing || !isDeepStrictEqual(launch, config.policy.launch)) { throw fail() }
                openedNative = true; handlers = { ...supplied }
                const ack = await request('COLD')
                const pid = ack && typeof ack === 'object' ? Reflect.get(ack, 'nativePid') : null
                if (!Number.isSafeInteger(pid) || pid < 1) { lost = true; throw fail() }
                nativePid = pid; return connection
              } }),
            })
            issued.add(control); resolve(control); return
          }
          if (record.controlId !== undefined && record.controlId !== controlId) { throw fail() }
          if (record.event === 'NOTIFICATION') {
            if (typeof record.method !== 'string') { throw fail() }
            handlers.onNotification?.(record.method, record.params); return
          }
          if (record.event === 'NATIVE_EXIT') { failure(); return }
          if (typeof record.id !== 'string') { throw fail() }
          const wait = pending.get(record.id)
          if (!wait) { throw fail() }
          pending.delete(record.id); clearTimeout(wait.timer)
          if (wait.method === 'CLOSE' && !record.error) {
            const ack = record.result
            stopAcknowledged = !!ack && typeof ack === 'object' && Reflect.get(ack, 'stopped') === true && Reflect.get(ack, 'controlId') === controlId
          }
          if (record.error) { wait.reject(fail()) } else { wait.resolve(record.result) }
        }
        let delivery = Promise.resolve()
        function message(raw: unknown, binary: boolean): void {
          try {
            if (!handshake || !binary || !(raw instanceof Uint8Array) || !raw.length) { throw fail() }
            if (raw[0] === 255) {
              const stream = streams.get(raw[1])
              if (raw.length !== 2 || !stream || stream.closed) { throw fail() }
              stream.decoder.decode(); stream.closed = true; return
            }
            const stream = streams.get(raw[0])
            if (!stream || stream.closed) { throw fail() }
            const text = stream.decoder.decode(raw.subarray(1), { stream: true })
            if (raw[0] === 2 && text) { throw fail() }
            if (raw[0] === 3) { status += text; if (status.length > 65536) { throw fail() }; return }
            if (raw[0] !== 1) { return }
            buffer += text
            if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { throw fail() }
            let newline: number
            while ((newline = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
              const parsed: unknown = JSON.parse(line)
              delivery = delivery.then(() => frame(parsed)).catch(() => { failure() })
            }
          } catch { failure() }
        }
        function cancelled(): void { if (!transferred) { failure(); socket?.terminate() } }
        acquisition.signal.addEventListener('abort', cancelled, { once: true })
        if (acquisition.signal.aborted) { cancelled(); return }
        try {
          const url = new URL(`/api/v1/namespaces/${encodeURIComponent(config.namespace)}/pods/${encodeURIComponent(config.expected.podName)}/exec`, origin)
          url.protocol = 'wss:'
          for (const [key, value] of Object.entries({ container: config.container, stdin: 'true', stdout: 'true', stderr: 'true', tty: 'false' })) { url.searchParams.set(key, value) }
          for (const arg of ['/usr/local/bin/node', '-e', agentCodexBootstrap, config.bootstrapSha256]) { url.searchParams.append('command', arg) }
          socket = new WebSocket(url, 'v5.channel.k8s.io', { ca: Buffer.from(ca), rejectUnauthorized: true,
            agent: false as unknown as ClientOptions['agent'], followRedirects: false, perMessageDeflate: false,
            handshakeTimeout: config.timeoutMs, headers: { Authorization: `Bearer ${bearer}` } })
          send = Reflect.get(socket, 'send')
          socket.on('error', failure).on('message', message).once('open', () => {
            if (socket?.protocol !== 'v5.channel.k8s.io') { failure(); return }
            handshake = true
            try { write({ method: 'INITIALIZE', policy: config.policy }) } catch { failure() }
          }).once('close', (code: number) => {
            socketClosed = true; acquisition.signal.removeEventListener('abort', cancelled)
            void delivery.then(() => {
              let confirmed = false
              try { confirmed = stopAcknowledged && code === 1000 && !buffer && JSON.parse(status).status === 'Success' } catch { /* unconfirmed */ }
              resolveClosed(confirmed); failure()
              socket?.off('message', message).off('error', failure)
            })
          }).once('unexpected-response', (request: { destroy(): void }, response: { destroy(): void }) => {
            failure(); response.destroy(); request.destroy()
          })
        } catch { failure() }
      })
    } catch { throw fail() }
    finally { bearer = ''; clearTimeout(budget); signal.removeEventListener('abort', abortAcquisition); acquisition.abort() }
  } })
}
