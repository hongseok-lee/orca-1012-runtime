import { randomUUID } from 'node:crypto'
import type { CodexAppServerConnection, CodexAppServerConnectionHandlers } from '../../../codex/codex-app-server-connection-types'

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : null
const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null
const turnIdOf = (value: unknown): string | null => {
  const root = record(value)
  return text(record(root?.turn)?.id) ?? text(root?.turnId)
}
const threadIdOf = (value: unknown): string | null => {
  const root = record(value)
  return text(record(root?.thread)?.id) ?? text(root?.threadId)
}
const TURN_OPTIONS = new Set(['model', 'effort', 'approvalPolicy', 'approvalsReviewer', 'personality', 'serviceTier'])

export type CodexWireInput =
  | Readonly<{ type: 'text'; text: string }>
  | Readonly<{ type: 'localImage'; path: string }>
  | Readonly<{ type: 'image'; url: string }>

/** This is an owned protocol receipt, not a generic VerifiedEvidence factory. */
export type CodexNativeReceipt = Readonly<{
  connectionId: string
  threadId: string
  turnId: string
  clientMessageId: string
  submission: string
  observedAt: string
  source: 'TURN_START_RESPONSE' | 'CORRELATED_TURN_STARTED'
}>
export type CodexProtocolEvent = Readonly<{
  connectionId: string
  threadId: string | null
  turnId: string | null
  method: string
  observedAt: string
  receipt?: CodexNativeReceipt
  terminalStatus?: 'completed' | 'interrupted' | 'failed'
}>
type RequestState = {
  submission: string
  input: Readonly<{ clientMessageId: string; input: readonly CodexWireInput[]; options: Readonly<Record<string, string>> }>
  receipt?: CodexNativeReceipt
  notify: (receipt: CodexNativeReceipt) => void
  notified: Promise<CodexNativeReceipt>
  baseline?: unknown
  stoppedFact?: Readonly<{
    receipt: CodexNativeReceipt
    baseline: unknown
    connection: CodexAppServerConnection
  }>
  interruptAcknowledged?: boolean
}
export type CodexInterruptResult = Readonly<{
  requested: boolean; terminal: CodexProtocolEvent | null; descendantsStopped: boolean; acknowledged: boolean
}>
/** This describes only this connection's effect scope, never durable intake policy. */
export class CodexConnectionBusyError extends Error {
  readonly code = 'CODEX_CONNECTION_BUSY'
  constructor(
    readonly reason: 'REQUEST_IN_FLIGHT' | 'TURN_ACTIVE' | 'TURN_UNVERIFIABLE',
    readonly scope: Readonly<{ connectionId: string; threadId: string | null; clientMessageId: string | null; turnId: string | null }>
  ) {
    super(`Codex connection cannot dispatch (${reason})`)
    this.name = 'CodexConnectionBusyError'
    Object.freeze(scope)
  }
}
/** Exact params serialized by the existing app-server request transport. */
export function codexTurnStartParams(threadId: string, input: RequestState['input']): Record<string, unknown> {
  if (Object.keys(input.options).some((key) => !TURN_OPTIONS.has(key))) {throw new Error('CODEX_UNSUPPORTED_OPTION')}
  return { threadId, clientUserMessageId: input.clientMessageId, input: input.input, ...input.options }
}
export type CodexProtocolResult =
  | Readonly<{ effect: 'ADMITTED'; receipt: CodexNativeReceipt }>
  | Readonly<{ effect: 'UNKNOWN'; reason: 'RESPONSE_LOST' | 'TURN_UNNAMED' | 'CONNECTION_CLOSED' }>

export type CodexProtocolDependencies = {
  open: (launch: { command: string; args: string[]; cwd: string; env: Record<string, string> }, handlers: CodexAppServerConnectionHandlers) => Promise<CodexAppServerConnection>
  /** Captures/verifies descendants using the existing host process boundary. */
  capture?: (pid: number) => Promise<unknown>
  terminate?: (pid: number, baseline: unknown) => Promise<boolean>
  now?: () => string
  receiptWaitMs?: number
  requestTimeoutMs?: number
  onEvent?: (event: CodexProtocolEvent) => void
}

export class CodexProtocolSession {
  readonly connectionId = randomUUID()
  #connection: CodexAppServerConnection | null = null
  #threadId: string | null = null
  #historyPath: string | null = null
  #closed = false
  #opening = false
  #requests = new Map<string, RequestState>()
  #receipts = new WeakSet<object>()
  #byTurn = new Map<string, RequestState>()
  #terminals = new Map<string, CodexProtocolEvent>()
  #pending: string | null = null
  #latestRequest: RequestState | null = null
  #activeRequest: RequestState | null = null
  #interrupting = false

  constructor(private readonly dependencies: CodexProtocolDependencies) {}

  get threadId(): string | null { return this.#threadId }
  get historyPath(): string | null { return this.#historyPath }
  get closed(): boolean { return this.#closed || this.#connection?.closed === true }
  ownsReceipt(receipt: CodexNativeReceipt): boolean { return this.#receipts.has(receipt) }

  async open(input: {
    command: string; args: readonly string[]; cwd: string; codexHome: string
    resumeThreadId: string | null; resumePath?: string | null
    env?: Readonly<Record<string, string>>
  }): Promise<Readonly<{ threadId: string; historyPath: string | null; connectionId: string }>> {
    if (this.#connection || this.#opening || this.#closed) {throw new Error('CODEX_CONNECTION_ALREADY_USED')}
    // Reserve before the opener's first await; a refused executor never enters open.
    this.#opening = true
    try {
      const connection = await this.dependencies.open({
        command: input.command, args: [...input.args, 'app-server'], cwd: input.cwd,
        env: { ...input.env, CODEX_HOME: input.codexHome }
      }, {
        onNotification: (method, params) => this.#observe(method, params),
        onExit: () => { this.#closed = true },
        // These unconnected channels must not block a native process silently.
        onServerRequest: (request) => this.#connection?.respondWithError(request.id, -32000, 'Durable Codex driver does not support this reply channel')
      })
      this.#connection = connection
      const params = { threadId: input.resumeThreadId, cwd: input.cwd, ...(input.resumePath ? { path: input.resumePath } : {}) }
      const opened = input.resumeThreadId
        ? await connection.request('thread/resume', { ...params, excludeTurns: true }, { timeoutMs: this.dependencies.requestTimeoutMs })
        : await connection.request('thread/start', { cwd: input.cwd }, { timeoutMs: this.dependencies.requestTimeoutMs })
      const threadId = threadIdOf(opened)
      if (!threadId || (input.resumeThreadId !== null && input.resumeThreadId !== threadId)) {
        throw new Error('CODEX_NATIVE_THREAD_MISMATCH')
      }
      if (connection.closed || this.#closed) {throw new Error('CODEX_CONNECTION_CLOSED')}
      this.#threadId = threadId
      this.#historyPath = text(record(record(opened)?.thread)?.path)
      return Object.freeze({ threadId, historyPath: this.#historyPath, connectionId: this.connectionId })
    } catch (error) {
      this.#closed = true
      await this.#connection?.close()
      throw error
    } finally {
      this.#opening = false
    }
  }

  async dispatch(input: RequestState['input']): Promise<CodexProtocolResult> {
    if (!this.#connection || !this.#threadId || this.closed) {return Object.freeze({ effect: 'UNKNOWN', reason: 'CONNECTION_CLOSED' })}
    const snapshot = structuredClone(input)
    const params = codexTurnStartParams(this.#threadId, snapshot)
    const submission = JSON.stringify(params)
    const existing = this.#requests.get(input.clientMessageId)
    if (existing) {
      if (existing.submission !== submission) {throw new Error('CODEX_SUBMISSION_ID_CONFLICT')}
      return existing.receipt ? Object.freeze({ effect: 'ADMITTED', receipt: existing.receipt }) : Object.freeze({ effect: 'UNKNOWN', reason: 'RESPONSE_LOST' })
    }
    if (this.#pending !== null || this.#interrupting || this.#activeRequest !== null) {
      const original = this.#activeRequest ?? this.#latestRequest
      throw new CodexConnectionBusyError(
        this.#pending !== null || this.#interrupting ? 'REQUEST_IN_FLIGHT'
          : original?.receipt ? 'TURN_ACTIVE' : 'TURN_UNVERIFIABLE',
        { connectionId: this.connectionId, threadId: this.#threadId,
          clientMessageId: original?.input.clientMessageId ?? null, turnId: original?.receipt?.turnId ?? null }
      )
    }
    let notify!: RequestState['notify']
    const notified = new Promise<CodexNativeReceipt>((resolve) => { notify = resolve })
    const state: RequestState = { input: snapshot, submission, notify, notified }
    // Record the invocation before its first await. Reconciliation cannot issue another turn/start.
    this.#requests.set(input.clientMessageId, state)
    this.#latestRequest = state
    this.#activeRequest = state
    this.#pending = input.clientMessageId
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (this.#connection.pid !== undefined && this.dependencies.capture) {
        state.baseline = await this.dependencies.capture(this.#connection.pid)
      }
      const reply = await this.#connection.request('turn/start', params, { timeoutMs: this.dependencies.requestTimeoutMs })
      const reportedThread = threadIdOf(reply)
      const turnId = turnIdOf(reply)
      if (turnId && (reportedThread === null || reportedThread === this.#threadId)) {
        this.#admit(state, turnId, 'TURN_START_RESPONSE')
      }
      if (state.receipt) {return Object.freeze({ effect: 'ADMITTED', receipt: state.receipt })}
      const receipt = await Promise.race([
        notified,
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.dependencies.receiptWaitMs ?? 10_000) })
      ])
      return receipt ? Object.freeze({ effect: 'ADMITTED', receipt }) : Object.freeze({ effect: 'UNKNOWN', reason: 'TURN_UNNAMED' })
    } catch {
      return state.receipt ? Object.freeze({ effect: 'ADMITTED', receipt: state.receipt }) : Object.freeze({ effect: 'UNKNOWN', reason: 'RESPONSE_LOST' })
    } finally {
      if (timer) {clearTimeout(timer)}
      this.#pending = null
    }
  }

  /** A read of owned observations, not an interrupt or a new executor grant. */
  observedStop(receipt: CodexNativeReceipt): CodexInterruptResult {
    if (!this.#connection || !this.ownsReceipt(receipt) || receipt.connectionId !== this.connectionId || receipt.threadId !== this.#threadId) {
      return Object.freeze({ requested: false, terminal: null, descendantsStopped: false, acknowledged: false })
    }
    const state = this.#byTurn.get(receipt.turnId)
    if (!state || state.receipt !== receipt) {
      return Object.freeze({ requested: false, terminal: null, descendantsStopped: false, acknowledged: false })
    }
    const fact = state.stoppedFact
    const descendantsStopped = fact !== undefined && fact.receipt === receipt &&
      fact.baseline === state.baseline && fact.connection === this.#connection
    return Object.freeze({ requested: false, terminal: this.#terminals.get(receipt.turnId) ?? null,
      descendantsStopped, acknowledged: state.interruptAcknowledged === true })
  }

  async interrupt(receipt: CodexNativeReceipt): Promise<CodexInterruptResult> {
    const observed = this.observedStop(receipt)
    if (observed.terminal || observed.descendantsStopped) {return observed}
    if (!this.#connection || this.closed || !this.ownsReceipt(receipt) || receipt.connectionId !== this.connectionId || receipt.threadId !== this.#threadId) {
      return Object.freeze({ requested: false, terminal: null, descendantsStopped: false, acknowledged: false })
    }
    const state = this.#byTurn.get(receipt.turnId)
    // A baseline cannot attribute later descendants to an older turn. Never use
    // an older baseline after another dispatch, or while another effect runs.
    if (!state || state.receipt !== receipt || state !== this.#latestRequest || this.#pending !== null || this.#interrupting) {
      return Object.freeze({ requested: false, terminal: null, descendantsStopped: false, acknowledged: false })
    }
    this.#interrupting = true
    try {
      const connection = this.#connection
      const acknowledged = this.#connection.request('turn/interrupt', {
        threadId: receipt.threadId, turnId: receipt.turnId
      }, { timeoutMs: this.dependencies.requestTimeoutMs }).then(() => {
        state.interruptAcknowledged = true
        return true
      }, () => false)
      const stopped = this.#connection.pid !== undefined && state.baseline !== undefined && this.dependencies.terminate
        ? this.dependencies.terminate(this.#connection.pid, state.baseline).then((verified) => {
          if (verified) {state.stoppedFact = Object.freeze({ receipt, baseline: state.baseline, connection })}
          return verified
        }).catch(() => false)
        : Promise.resolve(false)
      const [ack, descendantsStopped] = await Promise.all([acknowledged, stopped])
      return Object.freeze({ requested: true, terminal: this.#terminals.get(receipt.turnId) ?? null, descendantsStopped, acknowledged: ack })
    } finally {
      this.#interrupting = false
    }
  }

  async close(): Promise<boolean> {
    this.#closed = true
    return this.#connection ? this.#connection.close() : true
  }

  #admit(state: RequestState, turnId: string, source: CodexNativeReceipt['source']): void {
    if (state.receipt || !this.#threadId) {return}
    if (this.#byTurn.has(turnId) && this.#byTurn.get(turnId) !== state) {return}
    const receipt: CodexNativeReceipt = Object.freeze({
      connectionId: this.connectionId, threadId: this.#threadId, turnId,
      clientMessageId: state.input.clientMessageId, submission: state.submission,
      observedAt: this.#now(), source
    })
    this.#receipts.add(receipt)
    this.#byTurn.set(turnId, state)
    state.receipt = receipt
    state.notify(receipt)
    this.dependencies.onEvent?.(Object.freeze({ connectionId: this.connectionId, threadId: this.#threadId, turnId, method: source, observedAt: receipt.observedAt, receipt }))
  }

  #observe(method: string, params: unknown): void {
    const threadId = threadIdOf(params)
    const turnId = turnIdOf(params)
    const root = record(params)
    if (!this.#closed && threadId === this.#threadId && turnId) {
      if (method === 'turn/started') {
        // A primary-thread notification without a caller identity may be an old turn.
        const clientId = text(root?.clientUserMessageId) ?? text(record(root?.turn)?.clientUserMessageId)
        const state = clientId ? this.#requests.get(clientId) : undefined
        if (state) {this.#admit(state, turnId, 'CORRELATED_TURN_STARTED')}
      }
      if (method === 'turn/completed') {
        const status = text(record(root?.turn)?.status) ?? text(root?.status)
        const state = this.#byTurn.get(turnId)
        if (state?.receipt && (status === 'completed' || status === 'interrupted' || status === 'failed')) {
          const event: CodexProtocolEvent = Object.freeze({ connectionId: this.connectionId, threadId, turnId, method, observedAt: this.#now(), terminalStatus: status, receipt: state.receipt })
          this.#terminals.set(turnId, event)
          // Only the exact original terminal releases this connection's turn slot.
          if (state === this.#activeRequest) {this.#activeRequest = null}
          this.dependencies.onEvent?.(event)
          return
        }
      }
    }
    // Preserve lineage without applying a mismatched/late record to a new binding.
    this.dependencies.onEvent?.(Object.freeze({ connectionId: this.connectionId, threadId, turnId, method, observedAt: this.#now() }))
  }

  #now(): string { return this.dependencies.now?.() ?? new Date().toISOString() }
}
