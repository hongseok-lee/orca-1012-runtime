import { isDeepStrictEqual } from 'node:util'
import type { CodexAppServerConnection, CodexAppServerConnectionHandlers } from '../../codex/codex-app-server-connection-types.ts'
import type { CodexProtocolDependencies } from '../providers/codex/protocol.ts'
import { awaitPodAuthValue } from './kubernetes-pod-auth-transport.ts'
import type { AuthenticatedPodObservation, KubernetesPodAuthExpected } from './kubernetes-pod-auth-types.ts'
import type { ManagedLeafSocket } from '../storage/managed-leaf-collector-types.ts'
import type { AgentCodexControlPolicy } from './agent-codex-control.ts'
import { attemptAttach, checkAttached, checkHello, createExecChannelDecoder, openAgentControlExec, reattachWithin } from './agent-control-reattach.ts'
import type { AttachOutcome } from './agent-control-reattach.ts'
import { supplyNativeAndCold } from './agent-control-native-supply.ts'

const fail = (): Error => new Error('AGENT_CODEX_CONTROL_UNCONFIRMED')
export type AgentControlIdentity = Readonly<{ controlId: string; pid: number; startTicks: string; device: string; inode: string }>
export type AgentControlSessionEnvironment = Readonly<{
  config: Readonly<{ timeoutMs: number; namespace: string; container: string; bootstrapSha256: string
    nativeArtifactFile: string; expected: KubernetesPodAuthExpected; policy: AgentCodexControlPolicy }>
  origin: URL; ca: Buffer; reconnectBudgetMs: number; termOnInitialize: boolean
  reviewer(signal: AbortSignal): string | Promise<string>
  authenticate(input: Readonly<{ podBearer: string; expected: KubernetesPodAuthExpected }>, signal: AbortSignal): Promise<AuthenticatedPodObservation>
  controllerTerm(): number
}>
export type AuthenticatedAgentControl = Readonly<{
  controlId: string; controlPid: number; startTicks: string
  bindChallenge: string
  root: Readonly<{ path: string; device: string; inode: string }>
  pod: AuthenticatedPodObservation
  valid(): boolean
  transport: Pick<CodexProtocolDependencies, 'open'>
  /** hostSeq of the control frame being delivered; stable across re-attach and backend processes. */
  frameSequence(): number
  readMountProbe(): Promise<string>
  close(): Promise<boolean>
  /** Fixed diagnostic code of why the control stopped being valid, if it did. */
  lossReason(): string | null
  physicalPinIssued: false
}>
/** A control handed over by an earlier owner and re-attached by this one. It
 * never initializes, transfers native code or sends COLD. */
export type AdoptedAgentControl = Readonly<{
  identity: AgentControlIdentity; pod: AuthenticatedPodObservation; connection: CodexAppServerConnection
  valid(): boolean; frameSequence(): number; close(): Promise<boolean>
}>
type Pending = { method: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/** One owner's connection state to one Pod-local control host. INITIALIZE
 * creates the control; ADOPT re-attaches to a control another owner created.
 * After hand-over a lost exec connection re-attaches within the budget, and
 * only an unrecoverable loss reaches the provider handlers as an exit. */
export function createAgentControlSession(env: AgentControlSessionEnvironment) {
  const config = env.config
  let socket: ManagedLeafSocket | undefined, handshake = false, transferred = false
  let lost = false, socketClosed = false, openedNative = false, controlId = '', used = false
  let handlers: CodexAppServerConnectionHandlers = {}, nativePid: number | undefined
  let closing: Promise<boolean> | undefined, nativeExitReported = false
  let resolveClosed!: (confirmed: boolean) => void
  const closed = new Promise<boolean>(done => { resolveClosed = done })
  let channel = createExecChannelDecoder(() => { throw fail() })
  const pending = new Map<string, Pending>()
  let nextId = 1, stopAcknowledged = false
  // A host-capable control tags every frame with hostSeq; an older control
  // without the Pod-local host keeps the original loss rule.
  let hostCapable = false, lastSeq = 0, sinceAck = 0, reconnecting = false
  let identity: AgentControlIdentity | undefined, pod: AuthenticatedPodObservation | undefined
  let attachWait: ((record: Record<string, unknown>) => Promise<void>) | null = null
  let attachSettle: ((outcome: AttachOutcome) => void) | null = null
  let start: { resolve(value: unknown): void; reject(error: Error): void } | null = null
  let helloSignal: AbortSignal = new AbortController().signal
  // The INITIALIZE nonce is known only to the owner that sent it.
  let challenge: string | null = config.policy.bindChallenge
  const queued: Buffer[] = []
  let loss: string | null = null
  function failure(reason = 'FAILURE'): void {
    loss ??= reason
    lost = true
    for (const value of pending.values()) { clearTimeout(value.timer); value.reject(fail()) }
    pending.clear()
    start?.reject(fail()); start = null
    if (!nativeExitReported) { nativeExitReported = true; handlers.onExit?.(fail()) }
  }
  const encode = (frame: unknown): Buffer => Buffer.concat([Buffer.from([0]), Buffer.from(`${JSON.stringify(frame)}\n`)])
  function rawWrite(target: ManagedLeafSocket, bytes: Buffer): void {
    Reflect.apply(Reflect.get(target, 'send'), target, [bytes, (error?: Error) => {
      if (!error || target !== socket) { return }
      if (transferred && hostCapable) { target.terminate() } else { failure() }
    }])
  }
  function write(frame: unknown, allowLost = false): void {
    if (lost && !allowLost) { throw fail() }
    const bytes = encode(frame)
    if (reconnecting || socketClosed) {
      // Detached: hold the frame for the re-attached connection instead of losing it.
      if (!hostCapable || !transferred || lost) { throw fail() }
      queued.push(bytes)
      return
    }
    if (!handshake || !socket) { throw fail() }
    rawWrite(socket, bytes)
  }
  function request(method: string, params?: Record<string, unknown>, timeoutMs = config.timeoutMs): Promise<unknown> {
    if (!controlId || lost && method !== 'CLOSE' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      return Promise.reject(fail())
    }
    const id = String(nextId++)
    return new Promise((done, bad) => {
      const timer = setTimeout(() => { pending.delete(id); lost = true; bad(fail()) }, timeoutMs)
      pending.set(id, { method, resolve: done, reject: bad, timer })
      try { write({ controlId, id, method, ...(method === 'COLD' ? { launch: config.policy.launch } : { params }) }, method === 'CLOSE') }
      catch { failure() }
    })
  }
  async function close(): Promise<boolean> {
    if (closing) { return closing }
    closing = (async () => {
      if (socketClosed && !reconnecting || !controlId) { return false }
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
  const valid = (): boolean => !lost && !closing && (!socketClosed || reconnecting)
  const frameSequence = (): number => lastSeq
  const connection: CodexAppServerConnection = Object.freeze({
    get pid() { return nativePid }, get closed() { return lost || socketClosed && !reconnecting },
    request: (method, params, options) => request(method, params, options?.timeoutMs),
    // The existing Agent-side connection owns initialization/reply
    // channels. No public method or response can create another process.
    notify() {}, respond() {}, respondWithError() {}, close,
  })
  async function hello(record: Record<string, unknown>): Promise<void> {
    if (controlId) { throw fail() }
    const checked = checkHello(record, config.policy)
    controlId = checked.controlId; delete record.podBearer
    pod = await env.authenticate({ podBearer: checked.podBearer, expected: config.expected }, helloSignal)
    if (lost || socketClosed || helloSignal.aborted || pod.pod.uid !== config.expected.podUid) { throw fail() }
    transferred = true
    identity = Object.freeze({ controlId, pid: checked.pid, startTicks: checked.startTicks, device: checked.device, inode: checked.inode })
    const control: AuthenticatedAgentControl = Object.freeze({ controlId, controlPid: checked.pid, startTicks: checked.startTicks,
      bindChallenge: config.policy.bindChallenge,
      root: Object.freeze({ path: config.policy.protectedRoot, device: identity.device, inode: identity.inode }),
      pod, valid, close, frameSequence, lossReason: () => valid() ? null : loss ?? (closing ? 'CLOSING' : 'UNKNOWN'), physicalPinIssued: false as const,
      async readMountProbe() {
        if (openedNative || lost || socketClosed || closing) { throw fail() }
        const observed = await request('MOUNT_PROBE')
        if (!observed || typeof observed !== 'object' || typeof Reflect.get(observed, 'output') !== 'string') { throw fail() }
        return Reflect.get(observed, 'output')
      },
      transport: Object.freeze({ async open(launch: Parameters<CodexProtocolDependencies['open']>[0], supplied: CodexAppServerConnectionHandlers) {
        if (openedNative || lost || socketClosed || closing || !isDeepStrictEqual(launch, config.policy.launch)) { throw fail() }
        openedNative = true; handlers = { ...supplied }
        // This opener is invoked by the original actual-COMMIT permit.
        const pid = await supplyNativeAndCold(request, config.nativeArtifactFile, config.policy.nativeArtifact.byteLength)
        if (pid === null) { lost = true; throw fail() }
        nativePid = pid; return connection
      } }),
    })
    start?.resolve(control); start = null
  }
  async function frame(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { throw fail() }
    const record = value as Record<string, unknown>
    if (attachWait) { const wait = attachWait; attachWait = null; await wait(record); return }
    if (record.hostSeq !== undefined) {
      if (!Number.isSafeInteger(record.hostSeq) || Number(record.hostSeq) < 1) { throw fail() }
      // Replay after re-attach can overlap what this owner already applied.
      if (Number(record.hostSeq) <= lastSeq) { return }
      hostCapable = true
      lastSeq = Number(record.hostSeq)
      delete record.hostSeq
    }
    if (record.event === 'HELLO') { await hello(record); return }
    if (record.controlId !== undefined && record.controlId !== controlId) { throw fail() }
    if (record.event === 'NOTIFICATION') {
      if (typeof record.method !== 'string') { throw fail() }
      handlers.onNotification?.(record.method, record.params); return
    }
    if (record.event === 'NATIVE_EXIT') { failure(); return }
    if (record.event === 'HOST_EVICTED') { return }
    if (typeof record.id !== 'string') { throw fail() }
    const wait = pending.get(record.id)
    // After re-attach the host may replay a response to a request issued by an
    // earlier owner of this control; it is not ours to settle.
    if (!wait) { if (hostCapable && Number(record.id) < nextId) { return } throw fail() }
    pending.delete(record.id); clearTimeout(wait.timer)
    if (wait.method === 'CLOSE' && !record.error) {
      const ack = record.result
      stopAcknowledged = !!ack && typeof ack === 'object' && Reflect.get(ack, 'stopped') === true && Reflect.get(ack, 'controlId') === controlId
    }
    if (record.error) { wait.reject(fail()) } else { wait.resolve(record.result) }
  }
  /** Only after the frame's effect (e.g. the output spool append) has run. */
  function acknowledge(): void {
    if (hostCapable && ++sinceAck >= 64 && handshake && !socketClosed && !reconnecting) {
      sinceAck = 0
      try { write({ hostAck: lastSeq }) } catch { /* the next frame acknowledges */ }
    }
  }
  let delivery = Promise.resolve()
  function closedSocket(code: number): void {
    socketClosed = true; handshake = false
    loss ??= `SOCKET_${Number.isSafeInteger(code) ? code : 0}`
    if (closing || !transferred || !hostCapable || lost) {
      void delivery.then(() => { resolveClosed(stopAcknowledged && code === 1000 && channel.succeeded()); failure() })
      return
    }
    // The handed-over control lives in the Pod-local host; only this exec
    // connection is gone. Re-attach instead of reporting the provider lost.
    if (attachSettle) { attachSettle('RETRY'); return }
    void reconnect()
  }
  function openSocket(bearer: string, opened: () => void, unexpected: (statusCode: number) => void): void {
    const target = openAgentControlExec({ origin: env.origin, namespace: config.namespace, podName: config.expected.podName,
      container: config.container, bootstrapSha256: config.bootstrapSha256, ca: env.ca, timeoutMs: config.timeoutMs }, bearer)
    socket = target; handshake = false; socketClosed = false
    channel = createExecChannelDecoder(line => {
      const parsed: unknown = JSON.parse(line)
      delivery = delivery.then(() => frame(parsed)).then(acknowledge).catch(() => { failure('FRAME') })
    })
    target.on('error', () => { if (target === socket && !transferred) { failure() } })
    target.on('message', (raw: unknown, binary: boolean) => {
      if (target !== socket) { return }
      try { if (!handshake) { throw fail() }; channel.message(raw, binary) } catch { failure() }
    })
    target.once('open', () => {
      if (target !== socket) { return }
      if (target.protocol !== 'v5.channel.k8s.io') { if (transferred) { target.terminate() } else { failure() }; return }
      handshake = true
      opened()
    })
    target.once('close', (code: number) => { if (target === socket) { closedSocket(code) } })
    target.once('unexpected-response', (req: { destroy(): void }, response: { statusCode?: number; destroy(): void }) => {
      response.destroy(); req.destroy()
      if (target === socket) { unexpected(Number(response.statusCode)) }
    })
  }
  const attachOnce = (deadline: number): Promise<AttachOutcome> => attemptAttach(deadline, {
    timeoutMs: config.timeoutMs,
    readBearer: signal => awaitPodAuthValue(Promise.resolve(env.reviewer(signal)), signal),
    register(finish, firstFrame) { attachSettle = finish; attachWait = firstFrame },
    terminate: () => socket?.terminate(),
    async verify(record, signal) {
      if (!identity) { return 'FINAL' }
      const check = checkAttached(record, { ...identity, bindChallenge: challenge, protectedRoot: config.policy.protectedRoot })
      if (check.outcome !== 'VERIFY') { return check.outcome }
      const observed = await env.authenticate({ podBearer: check.podBearer, expected: config.expected }, signal)
      if (observed.pod.uid !== config.expected.podUid) { return 'FINAL' }
      pod = observed
      if (check.nextRequestId !== null && check.nextRequestId > nextId) { nextId = check.nextRequestId }
      return 'ATTACHED'
    },
    open: (bearer, unexpected) => openSocket(bearer, () => {
      if (socket) { rawWrite(socket, encode({ method: 'ATTACH', controlId, term: env.controllerTerm(), lastSeq })) }
    }, unexpected),
  })
  async function reconnect(): Promise<void> {
    if (reconnecting) { return }
    reconnecting = true
    let attached = false
    try { attached = await reattachWithin(env.reconnectBudgetMs, () => lost || !!closing, attachOnce) && !!socket } catch { /* lost below */ }
    reconnecting = false
    if (attached && socket && identity && pod) {
      loss = null
      for (const bytes of queued.splice(0)) { rawWrite(socket, bytes) }
      sinceAck = 0
      try { write({ hostAck: lastSeq }) } catch { /* the next frame acknowledges */ }
      start?.resolve(Object.freeze({ identity, pod, connection, valid, frameSequence, close })); start = null
      return
    }
    queued.length = 0
    failure('REATTACH_FAILED')
  }
  return Object.freeze({
    /** Creates the control over the first exec connection and resolves at its authenticated HELLO. */
    initialize(bearer: string, signal: AbortSignal): Promise<AuthenticatedAgentControl> {
      if (used) { return Promise.reject(fail()) }
      used = true; helloSignal = signal
      return new Promise<AuthenticatedAgentControl>((resolve, reject) => {
        start = { resolve: value => resolve(value as AuthenticatedAgentControl), reject }
        const cancelled = () => { if (!transferred) { failure(); socket?.terminate() } }
        signal.addEventListener('abort', cancelled, { once: true })
        if (signal.aborted) { cancelled(); return }
        try {
          openSocket(bearer, () => {
            try { write({ method: 'INITIALIZE', policy: config.policy, ...(env.termOnInitialize ? { term: env.controllerTerm() } : {}) }) }
            catch { failure() }
          }, () => failure())
        } catch { failure() }
      })
    },
    /** Re-attaches to the control recorded by the earlier owner, replaying
     * frames after lastSeq into the supplied handlers before any live frame. */
    adopt(recorded: AgentControlIdentity, journaledSeq: number,
      supplied: CodexAppServerConnectionHandlers): Readonly<{ frameSequence(): number; ready: Promise<AdoptedAgentControl> }> {
      if (used || !Number.isSafeInteger(journaledSeq) || journaledSeq < 0) { return Object.freeze({ frameSequence, ready: Promise.reject(fail()) }) }
      used = true; challenge = null
      identity = Object.freeze({ ...recorded }); controlId = recorded.controlId; lastSeq = journaledSeq
      hostCapable = true; transferred = true; openedNative = true; handlers = { ...supplied }
      const ready = new Promise<AdoptedAgentControl>((resolve, reject) => {
        start = { resolve: value => resolve(value as AdoptedAgentControl), reject }
        socketClosed = true
        void reconnect()
      })
      // Replayed frames reach the handlers before ready settles; they need the sequence now.
      return Object.freeze({ frameSequence, ready })
    },
  })
}
