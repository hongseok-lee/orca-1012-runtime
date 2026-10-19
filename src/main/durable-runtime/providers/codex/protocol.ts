import { CodexExecutionPolicyMismatch, CodexExecutionPolicyTracker, type CodexExecutionPolicy, type CodexExecutionPolicyObservation } from './execution-policy.ts'
import { randomUUID } from 'node:crypto'
import { captureCatalogJson } from '../../catalog/immutable.ts'
import { CodexConnectionBusyError, codexTurnStartParams, record, text, threadIdOf, turnIdOf } from './protocol-types.ts'
import type { CodexInterruptResult, CodexNativeNotification, CodexNativeReceipt, CodexProtocolEvent, CodexProtocolResult, RequestState } from './protocol-types.ts'
export { CodexConnectionBusyError, codexTurnStartParams } from './protocol-types.ts'
export type { CodexInterruptResult, CodexNativeNotification, CodexNativeReceipt, CodexProtocolEvent, CodexProtocolResult, CodexWireInput } from './protocol-types.ts'
import type { CodexAppServerConnection, CodexAppServerConnectionHandlers } from '../../../codex/codex-app-server-connection-types'

export type CodexProtocolDependencies = {
  open: (launch: { command: string; args: string[]; cwd: string; env: Record<string, string> }, handlers: CodexAppServerConnectionHandlers) => Promise<CodexAppServerConnection>
  /** Captures/verifies descendants using the existing host process boundary. */
  capture?: (pid: number) => Promise<unknown>
  terminate?: (pid: number, baseline: unknown) => Promise<boolean>
  now?: () => string
  receiptWaitMs?: number
  requestTimeoutMs?: number
  onEvent?: (event: CodexProtocolEvent) => void
  onNativeNotification?: (event: CodexNativeNotification) => void
  onExecutionPolicyObservation?: (observation: CodexExecutionPolicyObservation) => void
  /** Stable native connection identity, e.g. the Pod-local control id; a fresh UUID when absent. */
  connectionId?: string
  /** Sequence of the transport frame being delivered; stable across re-attach and owners. */
  frameSequence?: () => number
  /** Re-attaches to a native connection an earlier owner opened. Used only by adopt(). */
  attach?: (handlers: CodexAppServerConnectionHandlers) => Promise<CodexAppServerConnection>
}

export class CodexProtocolSession {
  readonly connectionId: string
  #connection: CodexAppServerConnection | null = null
  #threadId: string | null = null
  #cwd: string | null = null
  #policyBlocked = false
  readonly #policyTracker: CodexExecutionPolicyTracker
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
  #notificationSequence = 0n
  readonly #nativeNotification: CodexProtocolDependencies['onNativeNotification']

  constructor(private readonly dependencies: CodexProtocolDependencies) {
    this.#nativeNotification = dependencies.onNativeNotification?.bind(dependencies)
    this.#policyTracker = new CodexExecutionPolicyTracker(dependencies.onExecutionPolicyObservation?.bind(dependencies), dependencies.requestTimeoutMs)
    this.connectionId = dependencies.connectionId ?? randomUUID()
  }

  get threadId(): string | null { return this.#threadId }
  get historyPath(): string | null { return this.#historyPath }
  get closed(): boolean { return this.#closed || this.#connection?.closed === true }
  ownsReceipt(receipt: CodexNativeReceipt): boolean { return this.#receipts.has(receipt) }

  #handlers(): CodexAppServerConnectionHandlers {
    return {
      onNotification: (method, params) => {
        const originalParams = this.#nativeNotification ? captureCatalogJson(params ?? null) : null
        this.#observe(method, params)
        // Protocol admission/terminal state is settled by the original path.
        // The owned sink persists errors separately; this is never an ACK.
        if (this.#nativeNotification) {
          // A host frame sequence names the same notification for every owner,
          // so a replay after re-attach is the same spool record, not a new one.
          const frame = this.dependencies.frameSequence?.() ?? 0
          this.#notificationSequence++
          this.#nativeNotification(Object.freeze({ connectionId: this.connectionId,
            sequence: String(frame > 0 ? frame : this.#notificationSequence), method,
            params: originalParams, observedAt: this.#now() }))
        }
      },
      onExit: () => { this.#closed = true },
      // These unconnected channels must not block a native process silently.
      onServerRequest: (request) => this.#connection?.respondWithError(request.id, -32000, 'Durable Codex driver does not support this reply channel')
    }
  }

  /** Binds to a native thread already open on a connection an earlier owner
   * created. No process or thread is created; on failure the live connection
   * is left untouched, since closing it would stop the provider. */
  async adopt(input: { threadId: string; cwd: string; executionPolicy?: CodexExecutionPolicy }): Promise<Readonly<{ threadId: string; connectionId: string }>> {
    if (this.#connection || this.#opening || this.#closed || !this.dependencies.attach) {throw new Error('CODEX_CONNECTION_ALREADY_USED')}
    this.#opening = true
    try {
      const connection = await this.dependencies.attach(this.#handlers())
      this.#connection = connection
      const opened = await connection.request('thread/resume', { threadId: input.threadId, cwd: input.cwd, excludeTurns: true,
        ...(input.executionPolicy ? { approvalPolicy: input.executionPolicy.approvalPolicy, sandbox: input.executionPolicy.sandbox } : {}) },
        { timeoutMs: this.dependencies.requestTimeoutMs })
      if (threadIdOf(opened) !== input.threadId) {throw new Error('CODEX_NATIVE_THREAD_MISMATCH')}
      if (input.executionPolicy) {
        try { this.#policyTracker.verify(opened, input.executionPolicy, 'ADOPT', input.threadId) }
        catch (error) {
          if (!(error instanceof CodexExecutionPolicyMismatch)) { throw error }
          // Installed 0.160.1 explicitly ignores resume overrides for an already
          // loaded thread. Retain the identity; certify no permission here. The
          // next ordinary turn carries the typed override and is read back.
          this.#policyTracker.observe({ stage: 'ADOPT', state: 'AWAITING_TURN_OVERRIDE', threadId: input.threadId, ...error.diagnostic })
        }
      }
      if (connection.closed || this.#closed) {throw new Error('CODEX_CONNECTION_CLOSED')}
      this.#threadId = input.threadId
      this.#cwd = input.cwd
      this.#historyPath = text(record(record(opened)?.thread)?.path)
      return Object.freeze({ threadId: input.threadId, connectionId: this.connectionId })
    } catch (error) {
      this.#closed = true
      throw error
    } finally {
      this.#opening = false
    }
  }

  async open(input: {
    command: string; args: readonly string[]; cwd: string; codexHome: string
    resumeThreadId: string | null; resumePath?: string | null
    env?: Readonly<Record<string, string>>
    executionPolicy?: CodexExecutionPolicy
  }): Promise<Readonly<{ threadId: string; historyPath: string | null; connectionId: string }>> {
    if (this.#connection || this.#opening || this.#closed) {throw new Error('CODEX_CONNECTION_ALREADY_USED')}
    // Reserve before the opener's first await; a refused executor never enters open.
    this.#opening = true
    try {
      const connection = await this.dependencies.open({
        command: input.command, args: [...input.args, 'app-server'], cwd: input.cwd,
        env: { ...input.env, CODEX_HOME: input.codexHome }
      }, this.#handlers())
      this.#connection = connection
      const policy = input.executionPolicy ? { approvalPolicy: input.executionPolicy.approvalPolicy, sandbox: input.executionPolicy.sandbox } : {}
      const params = { threadId: input.resumeThreadId, cwd: input.cwd, ...policy, ...(input.resumePath ? { path: input.resumePath } : {}) }
      const opened = input.resumeThreadId
        ? await connection.request('thread/resume', { ...params, excludeTurns: true }, { timeoutMs: this.dependencies.requestTimeoutMs })
        : await connection.request('thread/start', { cwd: input.cwd, ...policy }, { timeoutMs: this.dependencies.requestTimeoutMs })
      const threadId = threadIdOf(opened)
      if (!threadId || (input.resumeThreadId !== null && input.resumeThreadId !== threadId)) {
        throw new Error('CODEX_NATIVE_THREAD_MISMATCH')
      }
      if (input.executionPolicy) { this.#policyTracker.verify(opened, input.executionPolicy, 'OPEN', threadId) }
      if (connection.closed || this.#closed) {throw new Error('CODEX_CONNECTION_CLOSED')}
      this.#threadId = threadId
      this.#cwd = input.cwd
      this.#historyPath = text(record(record(opened)?.thread)?.path)
      return Object.freeze({ threadId, historyPath: this.#historyPath, connectionId: this.connectionId })
    } catch (error) {
      this.#closed = true
      // Managed policy refusal/mismatch leaves the physical lifetime intact.
      // No input has been dispatched; the lifecycle owner retains the host.
      if (!input.executionPolicy) { await this.#connection?.close() }
      throw error
    } finally {
      this.#opening = false
    }
  }

  async dispatch(input: RequestState['input']): Promise<CodexProtocolResult> {
    if (!this.#connection || !this.#threadId || this.closed) {return Object.freeze({ effect: 'UNKNOWN', reason: 'CONNECTION_CLOSED' })}
    if (this.#policyBlocked) { throw new Error('CODEX_EXECUTION_POLICY_UNCONFIRMED') }
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
      if (snapshot.executionPolicy) {
        try {
          const nativeTurnId = state.receipt?.turnId
          // turn/start can acknowledge a queued operation before its thread
          // applies turn settings. Read only after that exact turn has started.
          if (!nativeTurnId || !await this.#policyTracker.awaitStarted(nativeTurnId)) { throw new Error('CODEX_EXECUTION_POLICY_UNCONFIRMED') }
          // This reads the loaded thread after the supported turn-level override.
          // It does not resend the input or change an already-running turn.
          const effective = await this.#connection.request('thread/resume', { threadId: this.#threadId, cwd: this.#cwd,
            excludeTurns: true }, { timeoutMs: this.dependencies.requestTimeoutMs })
          if (threadIdOf(effective) !== this.#threadId) { throw new Error('CODEX_NATIVE_THREAD_MISMATCH') }
          this.#policyTracker.verify(effective, snapshot.executionPolicy, 'TURN', this.#threadId)
        } catch (error) {
          this.#policyBlocked = true
          if (!(error instanceof CodexExecutionPolicyMismatch)) {
            this.#policyTracker.observe({ stage: 'TURN', state: 'UNCONFIRMED', threadId: this.#threadId,
              approvalPolicy: null, sandboxType: null })
          }
          // Input admission is a separate fact. Preserve an actual native receipt
          // or UNKNOWN, never replay an entered input to repair policy evidence.
        }
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
        this.#policyTracker.started(turnId)
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
