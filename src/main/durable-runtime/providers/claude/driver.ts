import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { readClaudeInit, readClaudeFrameString } from '../../../claude/claude-init-observation.ts'
import { CLAUDE_STREAM_JSON_FRAME_KINDS } from '../../../native-chat/agent-session-wire/claude-stream-json-frame-schema.ts'
import type { CommandClaim } from '../../runtime/gateway/types.ts'
import type { ProviderRef, ProviderAdmissionProof, ProviderStoppedProof } from '../../runtime/runtime-evidence.ts'
import { claudeCompletedProof } from './completion-proof.ts'
import type { VerifiedContextDeliveryProof } from '../../context/types.ts'
import type {
  ProviderCancelResult, ProviderCancelTarget, ProviderDispatchRequest, ProviderDispatchResult,
  ProviderEffectPermit, ProviderObservationSink, ProviderSubmissionIdentity, ReadyProviderBinding
} from '../shared/contracts.ts'
import { invokeProviderEffect } from '../shared/effect-boundary.ts'
import { immutableSnapshot, ProviderInputError, renderRecoverySubmission } from '../shared/recovery-renderer.ts'
import { claudeSubmissionContent } from './submission.ts'
import type { ClaudeColdRequest, ClaudeProtocolConnection, OpenClaudeTransport } from './transport.ts'

type Pending = {
  identity: ProviderSubmissionIdentity
  wire: Record<string, unknown>
  written: boolean
  ended: boolean
  nativeRef?: ProviderRef
  admission?: ProviderAdmissionProof
  contextDelivery?: VerifiedContextDeliveryProof
  stopped?: ProviderStoppedProof
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Internal driver; no public RPC registration or production permit implementation. */
export class ClaudeDurableProvider {
  #nativeSessionObserved = false
  nativeSessionObserved(): boolean { return this.#nativeSessionObserved }

  #connection?: ClaudeProtocolConnection
  #ready?: ReadyProviderBinding
  #active?: Pending
  #pending = new Map<string, Pending>()
  #faulted = false
  #starting = false
  #interrupting = false

  constructor(readonly openTransport: OpenClaudeTransport, readonly sink: ProviderObservationSink,
    readonly connectionInstanceId: string = randomUUID(),
    readonly onNativeSessionObserved?: (binding: ReadyProviderBinding) => Promise<void>) {}

  #certify(binding: ReadyProviderBinding): void {
    this.#nativeSessionObserved = true
    if (this.#ready) {
      void this.onNativeSessionObserved?.(binding).catch(() => { this.#faulted = true; this.#connectionLost() })
    }
  }

  ownsReadyBinding(binding: ReadyProviderBinding): boolean {
    return !!this.#ready && !this.#faulted && !!this.#connection && !this.#connection.closed &&
      digest(this.#ready) === digest(binding) && binding.connectionInstanceId === this.connectionInstanceId
  }

  /** Takes over a live session an earlier owner started; its deliveries stay with owner-loss recovery. */
  async adopt(binding: ReadyProviderBinding, attach: (handlers: Parameters<OpenClaudeTransport>[1]) => Promise<ClaudeProtocolConnection>): Promise<ReadyProviderBinding> {
    if (this.#starting || this.#connection || this.#faulted || binding.providerRef.provider !== 'claude' ||
        binding.connectionInstanceId !== this.connectionInstanceId) { throw new Error('CLAUDE_ADOPT_INVALID') }
    const ready = immutableSnapshot(binding)
    const lost = () => { this.#faulted = true; this.#connectionLost() }
    this.#connection = await attach({ onFault: lost, onExit: lost, onMessage: (message) => {
      const init = readClaudeInit(message)
      if (!init) { this.#observe(message, ready) }
      else if (init.providerSessionId !== ready.providerRef.nativeSessionRef) { lost() }
      else { this.#certify(ready) }
    } })
    this.#ready = ready
    return ready
  }

  async cold(request: ClaudeColdRequest, commandClaim: CommandClaim,
    permit: ProviderEffectPermit, readinessTimeoutMs = 10_000): Promise<ReadyProviderBinding> {
    if (this.#starting || this.#connection || this.#faulted) { throw new Error('CLAUDE_CONNECTION_ALREADY_ACQUIRED') }
    request = immutableSnapshot(request)
    if (request.mode !== 'COLD' || !request.binding.connectionInstanceId || !request.binding.terminalHandle ||
        !request.persistentHome || !request.checkout || request.launch.env.HOME !== request.persistentHome ||
        (request.native.kind === 'RESUME' && request.native.providerRef.provider !== 'claude')) {
      throw new Error('CLAUDE_COLD_IDENTITY_INVALID')
    }
    this.#starting = true
    try {
      return await invokeProviderEffect(permit, { kind: 'COLD', binding: request.binding, commandClaim,
        coldRequest: request }, async () => {
        let resolveInit!: (value: ReadyProviderBinding) => void
        let rejectInit!: (reason: Error) => void
        let initial: ReadyProviderBinding | undefined
        let abandoned = false
        const initialized = new Promise<ReadyProviderBinding>((resolve, reject) => {
          resolveInit = resolve; rejectInit = reject
        })
        let rejectCold!: (reason: Error) => void
        const failed = new Promise<never>((_resolve, reject) => { rejectCold = reject })
        // Observe rejection before opening can synchronously fault or stall.
        void initialized.catch(() => {})
        void failed.catch(() => {})
        const expiresAt = performance.now() + readinessTimeoutMs
        const fail = (reason: string): void => {
          if (!this.#ready) { abandoned = true }
          this.#faulted = true
          const error = new Error(reason)
          rejectInit(error)
          rejectCold(error)
          this.#connectionLost()
        }
        const timer = setTimeout(() => fail('CLAUDE_NATIVE_IDENTITY_UNCONFIRMED'), readinessTimeoutMs)
        // Init arrives only with a turn: a session named by this launch (its own
        // --session-id, or the resumed one) is served once open answers initialize.
        const presetSession = request.native.kind === 'NEW' && typeof request.launch.options.sessionId === 'string'
          ? request.launch.options.sessionId : request.native.kind === 'RESUME' ? request.native.providerRef.nativeSessionRef : null
        try {
          const opening = Promise.resolve().then(() => this.openTransport(request, {
            onMessage: (message) => {
              if (abandoned) { return }
              const init = readClaudeInit(message)
              if (init) {
                if ((request.native.kind === 'RESUME' &&
                    request.native.providerRef.nativeSessionRef !== init.providerSessionId) ||
                    (initial && initial.providerRef.nativeSessionRef !== init.providerSessionId)) {
                  fail('CLAUDE_RESUME_IDENTITY_MISMATCH')
                  return
                }
                // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Actual init/SessionStart response supplies this native identity, never a logical UUID.
                const providerRef = { provider: 'claude', nativeSessionRef: init.providerSessionId } as ProviderRef
                initial = immutableSnapshot({ ...request.binding, providerRef })
                this.#certify(initial)
                resolveInit(initial)
              } else if (initial) {
                this.#observe(message, initial)
              }
            }, onFault: () => fail('CLAUDE_CONNECTION_LOST'), onExit: () => fail('CLAUDE_CONNECTION_LOST')
          })).then((connection) => {
            // Retain late ownership; opening/timeout is not provider stop evidence.
            this.#connection = connection
            // NEW with its own --session-id serves once open answered initialize (init comes only with a turn).
            if (presetSession && !initial && !abandoned) {
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native session id fixed by this cold's own launch options.
              const providerRef = { provider: 'claude', nativeSessionRef: presetSession } as ProviderRef
              initial = immutableSnapshot({ ...request.binding, providerRef })
              resolveInit(initial)
            }
            return connection
          })
          const [connection, ready] = await Promise.race([Promise.all([opening, initialized]), failed])
          if (performance.now() >= expiresAt) { fail('CLAUDE_NATIVE_IDENTITY_UNCONFIRMED') }
          if (abandoned || this.#faulted || connection.closed) { throw new Error('CLAUDE_CONNECTION_UNAVAILABLE') }
          this.#ready = ready
          return ready
        } catch (error) {
          abandoned = true
          this.#faulted = true
          // Account diagnostics/logs are not propagated through this new boundary.
          throw new Error(error instanceof Error && error.message === 'CLAUDE_RESUME_IDENTITY_MISMATCH'
            ? 'CLAUDE_RESUME_IDENTITY_MISMATCH' : 'CLAUDE_NATIVE_IDENTITY_UNCONFIRMED')
        } finally {
          clearTimeout(timer)
        }
      })
    } finally {
      this.#starting = false
    }
  }

  async dispatch(request: ProviderDispatchRequest, permit: ProviderEffectPermit): Promise<ProviderDispatchResult> {
    request = immutableSnapshot(request)
    try { renderRecoverySubmission(request.context, request.sealed) } catch (error) {
      if (error instanceof ProviderInputError && ['UNSUPPORTED_KIND', 'NO_NORMAL_INPUT'].includes(error.code)) {
        return { state: 'UNSUPPORTED', reason: error.code }
      }
      throw error
    }
    const binding = this.#available()
    if (request.context.sessionId !== binding.sessionId) { throw new Error('CLAUDE_CONTEXT_SESSION_MISMATCH') }
    if ([...this.#pending.values()].some((item) => item.identity.deliveryAttemptId === request.deliveryAttemptId)) {
      throw new Error('CLAUDE_DELIVERY_ALREADY_SUBMITTED')
    }
    if (this.#active && !this.#active.ended || this.#interrupting) { throw new Error('CLAUDE_TURN_UNSETTLED') }
    const nativeRequestId = randomUUID()
    // Reserve before attachment I/O; overlapping prepares cannot change the interrupt target.
    const reserved: Pending = { identity: undefined!, wire: {}, written: false, ended: false }
    this.#active = reserved
    try {
      const content = await claudeSubmissionContent(request)
      const wire = immutableSnapshot({ type: 'user', uuid: nativeRequestId,
        session_id: binding.providerRef.nativeSessionRef,
        message: { role: 'user', content }, parent_tool_use_id: null })
      const identity = immutableSnapshot({ binding, messageId: request.sealed.messageId,
        deliveryAttemptId: request.deliveryAttemptId, sealedRevision: request.sealed.sealedRevision,
        sealedPayloadHash: request.sealed.payloadHash, contextRevision: request.context.revision,
        contextHash: request.context.hash, commandClaim: request.commandClaim,
        nativeRequestId, submissionHash: digest(wire) })
      reserved.identity = identity; reserved.wire = wire
      return await invokeProviderEffect(permit, { kind: 'DISPATCH', binding,
        commandClaim: request.commandClaim, messageId: identity.messageId,
        deliveryAttemptId: identity.deliveryAttemptId, sealedRevision: identity.sealedRevision,
        sealedPayloadHash: identity.sealedPayloadHash, contextRevision: identity.contextRevision,
        contextHash: identity.contextHash }, async () => {
        const connection = this.#availableConnection(binding)
        this.#pending.set(nativeRequestId, reserved)
        reserved.written = true
        try { await connection.send(wire) } catch {
          this.#emitUnknown(reserved, 'WRITE_OUTCOME_LOST')
          return { state: 'UNKNOWN', identity }
        }
        if (reserved.admission && reserved.contextDelivery) { return { state: 'ADMITTED', identity,
          admission: reserved.admission, contextDelivery: reserved.contextDelivery } }
        return { state: this.#faulted ? 'UNKNOWN' : 'PENDING', identity }
      })
    } catch (error) {
      if (!reserved.written && this.#active === reserved) { this.#active = undefined }
      throw error
    }
  }

  cancelTarget(deliveryAttemptId: string, nativeTurnId: string): ProviderCancelTarget | null {
    for (const pending of this.#pending.values()) {
      if (pending.identity.deliveryAttemptId === deliveryAttemptId && pending.nativeRef?.nativeTurnId === nativeTurnId) {
        return immutableSnapshot({ identity: pending.identity, providerRef: pending.nativeRef })
      }
    }
    return null
  }

  async cancel(target: ProviderCancelTarget, commandClaim: CommandClaim,
    permit: ProviderEffectPermit): Promise<ProviderCancelResult> {
    target = immutableSnapshot(target)
    const pending = this.#pending.get(target.identity.nativeRequestId)
    if (!pending || !pending.nativeRef || digest(target.identity) !== digest(pending.identity) ||
        digest(target.providerRef) !== digest(pending.nativeRef)) { return { state: 'UNCONFIRMED', requested: false } }
    if (pending.stopped) { return { state: 'OBSERVED', requested: false, stopped: pending.stopped } }
    if (this.#faulted || this.#active !== pending || pending.ended || this.#interrupting) {
      return { state: 'UNCONFIRMED', requested: false }
    }
    this.#interrupting = true
    try {
      return await invokeProviderEffect(permit, { kind: 'CANCEL', binding: pending.identity.binding,
        commandClaim, messageId: pending.identity.messageId, deliveryAttemptId: pending.identity.deliveryAttemptId,
        nativeTurnId: pending.nativeRef.nativeTurnId }, async () => {
        if (this.#active !== pending || pending.ended) { return { state: 'UNCONFIRMED', requested: false } }
        const connection = this.#availableConnection(pending.identity.binding)
        try { await connection.interrupt({ cancelQueued: false }) } catch { /* ACK loss is not terminal proof. */ }
        return pending.stopped ? { state: 'OBSERVED', requested: true, stopped: pending.stopped }
          : { state: 'UNCONFIRMED', requested: true }
      })
    } finally { this.#interrupting = false }
  }

  #available(): ReadyProviderBinding {
    if (!this.#ready || !this.#connection || this.#faulted || this.#connection.closed) {
      throw new Error('CLAUDE_NATIVE_NOT_READY')
    }
    return this.#ready
  }
  #availableConnection(binding: ReadyProviderBinding): ClaudeProtocolConnection {
    if (digest(this.#available()) !== digest(binding) || !this.#connection) { throw new Error('CLAUDE_BINDING_CHANGED') }
    return this.#connection
  }

  #observe(message: Record<string, unknown>, binding: ReadyProviderBinding): void {
    if (readClaudeFrameString(message, 'session_id') !== binding.providerRef.nativeSessionRef) { return }
    const uuid = readClaudeFrameString(message, 'uuid')
    const requestId = readClaudeFrameString(message, 'user_message_uuid') ?? uuid
    if (!uuid || !requestId) { return }
    const pending = this.#pending.get(requestId)
    if (!pending || digest(pending.identity.binding) !== digest(binding) || !pending.written) { return }
    const body = message.message
    const isUser = message.type === 'user' && message.parent_tool_use_id === null && body &&
      typeof body === 'object' && 'role' in body && body.role === 'user'
    const observedAt = new Date().toISOString()
    if (isUser && !pending.admission) {
      const sent = pending.wire.message
      if (!('content' in body) || !sent || typeof sent !== 'object' || !('content' in sent) ||
          digest(body.content) !== digest(sent.content)) { return }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Exact native user receipt on the original connection/session/request UUID supplies the turn identity.
      const providerRef = immutableSnapshot({ ...binding.providerRef, nativeTurnId: uuid }) as ProviderRef
      const tuple = pending.identity
      const evidenceRef = `claude-protocol:${digest({ connection: binding.connectionInstanceId, message })}`
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Method-specific parser matched immutable original binding, sent request and actual native receipt above.
      const admission = immutableSnapshot({ kind: 'PROVIDER_ADMISSION', source: 'PROVIDER_PROTOCOL', evidenceRef,
        observedAt, attemptId: binding.attemptId, podUid: binding.podUid, executionEpoch: binding.executionEpoch,
        messageId: tuple.messageId, deliveryAttemptId: tuple.deliveryAttemptId, providerRef }) as ProviderAdmissionProof
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Same exact receipt acknowledges the entire frozen wire submission and its original context hash/revision.
      const contextDelivery = immutableSnapshot({ kind: 'PROVIDER_CONTEXT_DELIVERY', source: 'PROVIDER_PROTOCOL',
        evidenceRef, observedAt, sessionId: binding.sessionId, contextRevision: tuple.contextRevision,
        contextHash: tuple.contextHash, providerBindingRevision: binding.providerBindingRevision,
        runtimeUnitId: binding.runtimeUnitId, attemptId: binding.attemptId, podUid: binding.podUid,
        executionEpoch: binding.executionEpoch, providerRef }) as VerifiedContextDeliveryProof
      pending.nativeRef = providerRef; pending.admission = admission; pending.contextDelivery = contextDelivery
      this.sink(immutableSnapshot({ source: 'PROVIDER_PROTOCOL', kind: 'ADMITTED', identity: tuple,
        observedAt, providerRef, nativeEventId: uuid, admission, contextDelivery }))
    }
    if (message.type !== 'result' || !pending.nativeRef || pending.ended ||
        readClaudeFrameString(message, 'user_message_uuid') !== pending.identity.nativeRequestId) { return }
    const turn = readClaudeFrameString(message, 'turn_uuid')
    if (turn && turn !== pending.nativeRef.nativeTurnId) { return }
    if (!CLAUDE_STREAM_JSON_FRAME_KINDS.some((kind) => kind === `message:result:${message.subtype}`)) { return }
    pending.ended = true
    if (message.terminal_reason === 'aborted_streaming' || message.terminal_reason === 'aborted_tools') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Exact original request/session/connection and admitted native target correlate this aborted terminal; no process/tree stop claim.
      pending.stopped = immutableSnapshot({ kind: 'PROVIDER_TARGET_STOPPED',
        evidenceRef: `claude-terminal:${digest(message)}`, observedAt,
        attemptId: binding.attemptId, podUid: binding.podUid, executionEpoch: binding.executionEpoch,
        providerRef: pending.nativeRef, targetMessageId: pending.identity.messageId,
        targetTurnId: pending.nativeRef.nativeTurnId }) as ProviderStoppedProof
      this.sink(immutableSnapshot({ source: 'PROVIDER_PROTOCOL', kind: 'TARGET_STOPPED',
        identity: pending.identity, observedAt, providerRef: pending.nativeRef,
        nativeEventId: uuid, stopped: pending.stopped }))
    } else {
      const completed = claudeCompletedProof(binding, pending.identity, pending.nativeRef, uuid, observedAt)
      this.sink(immutableSnapshot({ source: 'PROVIDER_PROTOCOL', kind: 'COMPLETED',
        identity: pending.identity, observedAt, providerRef: pending.nativeRef, nativeEventId: uuid, completed }))
    }
  }
  #emitUnknown(pending: Pending, reason: 'CONNECTION_LOST' | 'WRITE_OUTCOME_LOST'): void {
    if (pending.ended) { return }
    this.sink(immutableSnapshot({ source: 'PROVIDER_PROTOCOL', kind: 'UNKNOWN',
      identity: pending.identity, observedAt: new Date().toISOString(), providerRef: pending.nativeRef, reason }))
  }
  #connectionLost(): void {
    for (const pending of this.#pending.values()) { this.#emitUnknown(pending, 'CONNECTION_LOST') }
  }
}
