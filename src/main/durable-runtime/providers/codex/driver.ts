import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type {
  ProviderAdmissionProof, ProviderRef, ProviderStoppedProof, RuntimeReference
} from '../../runtime/runtime-evidence.ts'
import type { VerifiedContextDeliveryProof } from '../../context/types.ts'
import type {
  ProviderColdRequest, ProviderBinding, ReadyProviderBinding, ProviderEffectPermit,
  ProviderDispatchRequest, ProviderDispatchResult, ProviderSubmissionIdentity,
  ProviderObservationSink, ProviderCancelTarget, ProviderCancelResult
} from '../shared/contracts.ts'
import { invokeProviderEffect } from '../shared/effect-boundary.ts'
import { immutableSnapshot, renderRecoverySubmission, ProviderInputError } from '../shared/recovery-renderer.ts'
import { CodexProtocolSession, CodexConnectionBusyError, codexTurnStartParams, type CodexNativeReceipt, type CodexProtocolDependencies, type CodexProtocolEvent, type CodexWireInput } from './protocol.ts'

export type CodexColdLaunch = {
  readonly command: string
  readonly args: readonly string[]
  readonly options: Readonly<Record<string, string>>
  readonly resumePath?: string | null
  readonly env?: Readonly<Record<string, string>>
}
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')

/** The factory does not start a process or authenticate the upper executor's grants. */
export class DurableCodexDriver {
  readonly #protocol: CodexProtocolSession
  #binding: ReadyProviderBinding | null = null
  #options: Readonly<Record<string, string>> = {}
  #submissions = new Map<string, ProviderSubmissionIdentity>()
  #receipts = new Map<string, CodexNativeReceipt>()
  #proofs = new Map<string, Extract<ProviderDispatchResult, { state: 'ADMITTED' }>>()

  constructor(dependencies: CodexProtocolDependencies, private readonly sink: ProviderObservationSink) {
    this.#protocol = new CodexProtocolSession({ ...dependencies, onEvent: (event) => {
      dependencies.onEvent?.(event)
      this.#observe(event)
    } })
  }

  get connectionInstanceId(): string { return this.#protocol.connectionId }

  async cold(request: ProviderColdRequest<CodexColdLaunch>, commandClaim: ProviderDispatchRequest['commandClaim'], permit: ProviderEffectPermit): Promise<ReadyProviderBinding> {
    const original = immutableSnapshot({ request, commandClaim })
    if (original.request.mode !== 'COLD' || original.request.binding.connectionInstanceId !== this.connectionInstanceId || this.#binding) {
      throw new Error('CODEX_COLD_BINDING_MISMATCH')
    }
    const native = original.request.native
    if (native.kind === 'RESUME' && native.providerRef.provider !== 'codex') {throw new Error('CODEX_RESUME_PROVIDER_MISMATCH')}
    return invokeProviderEffect(permit, { kind: 'COLD', binding: original.request.binding, commandClaim: original.commandClaim }, async () => {
      const opened = await this.#protocol.open({
        command: original.request.launch.command, args: original.request.launch.args,
        cwd: original.request.checkout, codexHome: original.request.persistentHome,
        resumeThreadId: native.kind === 'RESUME' ? native.providerRef.nativeSessionRef : null,
        resumePath: original.request.launch.resumePath,
        env: original.request.launch.env
      })
      // This private cast follows an exact native thread/start or thread/resume response.
      const providerRef: ProviderRef = Object.freeze({ provider: 'codex', nativeSessionRef: opened.threadId as RuntimeReference<'provider-session'> })
      this.#options = immutableSnapshot(original.request.launch.options)
      this.#binding = immutableSnapshot({ ...original.request.binding, providerRef })
      return this.#binding
    })
  }

  async dispatch(request: ProviderDispatchRequest, permit: ProviderEffectPermit): Promise<ProviderDispatchResult> {
    const binding = this.#requireBinding()
    const frozen = immutableSnapshot(request)
    if (frozen.context.sessionId !== binding.sessionId) {throw new Error('CODEX_CONTEXT_SESSION_MISMATCH')}
    let rendered: ReturnType<typeof renderRecoverySubmission>
    try { rendered = renderRecoverySubmission(frozen.context, frozen.sealed) } catch (error) {
      if (error instanceof ProviderInputError && (error.code === 'UNSUPPORTED_KIND' || error.code === 'NO_NORMAL_INPUT')) {
        return Object.freeze({ state: 'UNSUPPORTED', reason: error.code })
      }
      throw error
    }
    if (frozen.attachments.length !== rendered.attachmentOrder.length) {throw new Error('CODEX_MATERIALIZED_ATTACHMENT_MISMATCH')}
    // Inline immutable bytes; a later change to a materializer path cannot change the native submission.
    const input: CodexWireInput[] = [{ type: 'text', text: rendered.text }]
    for (const [index, expected] of rendered.attachmentOrder.entries()) {
      const attachment = frozen.attachments[index]
      if (attachment.inputId !== expected.inputId || attachment.position !== expected.position ||
          attachment.aliasPath !== expected.aliasPath || attachment.contentHash !== expected.contentHash) {
        throw new Error('CODEX_MATERIALIZED_ATTACHMENT_MISMATCH')
      }
      const bytes = await readFile(attachment.path)
      if (sha256(bytes) !== expected.contentHash) {throw new Error('CODEX_ATTACHMENT_HASH_MISMATCH')}
      const mime = imageMime(bytes)
      if (!mime) {return Object.freeze({ state: 'UNSUPPORTED', reason: 'NATIVE_IMAGE_FORMAT_UNCONFIRMED' })}
      input.push({ type: 'image', url: `data:${mime};base64,${bytes.toString('base64')}` })
    }
    const nativeRequestId = `codex:${binding.connectionInstanceId}:${frozen.deliveryAttemptId}`
    const actual = immutableSnapshot({ clientMessageId: nativeRequestId, input, options: this.#options })
    const serialized = JSON.stringify(codexTurnStartParams(binding.providerRef.nativeSessionRef, actual))
    const identity: ProviderSubmissionIdentity = immutableSnapshot({
      binding, messageId: frozen.sealed.messageId, deliveryAttemptId: frozen.deliveryAttemptId,
      sealedRevision: frozen.sealed.sealedRevision, sealedPayloadHash: frozen.sealed.payloadHash,
      contextRevision: frozen.context.revision, contextHash: frozen.context.hash,
      commandClaim: frozen.commandClaim, nativeRequestId, submissionHash: sha256(serialized)
    })
    const prior = this.#submissions.get(nativeRequestId)
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(identity)) {throw new Error('CODEX_DELIVERY_IDENTITY_CONFLICT')}
      // A lookup is not execution authority. In particular UNKNOWN never invokes another permit.
      return this.#proofs.get(nativeRequestId) ?? Object.freeze({ state: 'UNKNOWN', identity: prior })
    }
    this.#submissions.set(nativeRequestId, identity)
    let outcome: Awaited<ReturnType<CodexProtocolSession['dispatch']>>
    try {
      outcome = await invokeProviderEffect(permit, {
        kind: 'DISPATCH', binding, commandClaim: frozen.commandClaim,
        messageId: identity.messageId, deliveryAttemptId: identity.deliveryAttemptId,
        sealedRevision: identity.sealedRevision, sealedPayloadHash: identity.sealedPayloadHash,
        contextRevision: identity.contextRevision, contextHash: identity.contextHash
      }, () => this.#protocol.dispatch(actual))
    } catch (error) {
      // Busy is a known refusal before native I/O, not an UNKNOWN submission.
      if (error instanceof CodexConnectionBusyError && this.#submissions.get(nativeRequestId) === identity) {
        this.#submissions.delete(nativeRequestId)
      }
      throw error
    }
    if (outcome.effect === 'ADMITTED') {return this.#verifyAdmission(outcome.receipt, identity)}
    this.sink(immutableSnapshot({ kind: 'UNKNOWN', source: 'PROVIDER_PROTOCOL', identity,
      observedAt: new Date().toISOString(), reason: 'WRITE_OUTCOME_LOST' }))
    return immutableSnapshot({ state: 'UNKNOWN', identity })
  }

  async cancel(target: ProviderCancelTarget, commandClaim: ProviderDispatchRequest['commandClaim'], permit: ProviderEffectPermit): Promise<ProviderCancelResult> {
    const fixed = immutableSnapshot({ target, commandClaim })
    const binding = this.#requireBinding()
    const identity = this.#submissions.get(fixed.target.identity.nativeRequestId)
    const receipt = this.#receipts.get(fixed.target.identity.nativeRequestId)
    if (!identity || !receipt || !sameBinding(binding, fixed.target.identity.binding) ||
        JSON.stringify(identity) !== JSON.stringify(fixed.target.identity) ||
        fixed.target.providerRef.provider !== 'codex' || fixed.target.providerRef.nativeSessionRef !== receipt.threadId ||
        fixed.target.providerRef.nativeTurnId !== receipt.turnId) {
      return Object.freeze({ state: 'UNCONFIRMED', requested: false })
    }
    const observed = this.#protocol.observedStop(receipt)
    const result = observed.terminal || observed.descendantsStopped ? observed
      : await invokeProviderEffect(permit, { kind: 'CANCEL', binding, commandClaim: fixed.commandClaim,
      messageId: identity.messageId, deliveryAttemptId: identity.deliveryAttemptId, nativeTurnId: receipt.turnId }, () => this.#protocol.interrupt(receipt))
    // Neither an ACK nor descendant termination alone confirms the native target ended.
    if (!result.terminal || result.terminal.terminalStatus !== 'interrupted' || !result.descendantsStopped) {
      return Object.freeze({ state: 'UNCONFIRMED', requested: result.requested })
    }
    const providerRef = this.#nativeRef(receipt)
    const stopped = immutableSnapshot({ kind: 'PROVIDER_TARGET_STOPPED',
      evidenceRef: `codex:turn-interrupted:${receipt.connectionId}:${receipt.turnId}`,
      observedAt: result.terminal.observedAt, attemptId: binding.attemptId, podUid: binding.podUid,
      executionEpoch: binding.executionEpoch, targetMessageId: identity.messageId,
      targetTurnId: providerRef.nativeTurnId, providerRef }) as ProviderStoppedProof
    this.sink(immutableSnapshot({ kind: 'TARGET_STOPPED', source: 'PROVIDER_PROTOCOL', identity,
      observedAt: result.terminal.observedAt, stopped }))
    return immutableSnapshot({ state: 'OBSERVED', requested: result.requested, stopped })
  }

  #verifyAdmission(receipt: CodexNativeReceipt, identity: ProviderSubmissionIdentity): Extract<ProviderDispatchResult, { state: 'ADMITTED' }> {
    if (!this.#protocol.ownsReceipt(receipt) || receipt.connectionId !== identity.binding.connectionInstanceId ||
        receipt.threadId !== identity.binding.providerRef.nativeSessionRef || receipt.clientMessageId !== identity.nativeRequestId ||
        sha256(receipt.submission) !== identity.submissionHash) {throw new Error('CODEX_NATIVE_RECEIPT_MISMATCH')}
    const prior = this.#proofs.get(identity.nativeRequestId)
    if (prior) {return prior}
    const providerRef = this.#nativeRef(receipt)
    const admission = immutableSnapshot({ kind: 'PROVIDER_ADMISSION', source: 'PROVIDER_PROTOCOL',
      evidenceRef: `codex:admission:${receipt.connectionId}:${receipt.turnId}`, observedAt: receipt.observedAt,
      attemptId: identity.binding.attemptId, podUid: identity.binding.podUid,
      executionEpoch: identity.binding.executionEpoch, messageId: identity.messageId,
      deliveryAttemptId: identity.deliveryAttemptId, providerRef }) as ProviderAdmissionProof
    const contextDelivery = immutableSnapshot({ kind: 'PROVIDER_CONTEXT_DELIVERY', source: 'PROVIDER_PROTOCOL',
      evidenceRef: admission.evidenceRef, observedAt: receipt.observedAt,
      sessionId: identity.binding.sessionId, contextRevision: identity.contextRevision,
      contextHash: identity.contextHash, providerBindingRevision: identity.binding.providerBindingRevision,
      runtimeUnitId: identity.binding.runtimeUnitId, attemptId: identity.binding.attemptId,
      podUid: identity.binding.podUid, executionEpoch: identity.binding.executionEpoch, providerRef }) as VerifiedContextDeliveryProof
    const result = immutableSnapshot({ state: 'ADMITTED' as const, identity, admission, contextDelivery })
    this.#receipts.set(identity.nativeRequestId, receipt)
    this.#proofs.set(identity.nativeRequestId, result)
    this.sink(immutableSnapshot({ kind: 'ADMITTED', source: 'PROVIDER_PROTOCOL', identity,
      observedAt: receipt.observedAt, admission, contextDelivery }))
    return result
  }

  #observe(event: CodexProtocolEvent): void {
    if (!event.receipt) {return}
    const identity = this.#submissions.get(event.receipt.clientMessageId)
    if (!identity || !this.#binding || !sameBinding(identity.binding, this.#binding)) {return}
    if (event.method === 'TURN_START_RESPONSE' || event.method === 'CORRELATED_TURN_STARTED') {
      this.#verifyAdmission(event.receipt, identity)
    }
    if (event.method === 'turn/completed' && event.terminalStatus === 'completed') {
      this.sink(immutableSnapshot({ kind: 'COMPLETED', source: 'PROVIDER_PROTOCOL', identity, observedAt: event.observedAt }))
    }
  }

  #nativeRef(receipt: CodexNativeReceipt): ProviderRef {
    // Only called after the owned native receipt has been checked against its exact tuple.
    return Object.freeze({ provider: 'codex', nativeSessionRef: receipt.threadId as RuntimeReference<'provider-session'>,
      nativeTurnId: receipt.turnId as RuntimeReference<'provider-turn-id'> })
  }
  #requireBinding(): ReadyProviderBinding {
    if (!this.#binding || this.#protocol.closed) {throw new Error('CODEX_BINDING_NOT_READY')}
    return this.#binding
  }
}
function sameBinding(left: ProviderBinding, right: ProviderBinding): boolean {
  return left.sessionId === right.sessionId && left.tabId === right.tabId &&
    left.terminalHandle === right.terminalHandle && left.providerBindingRevision === right.providerBindingRevision &&
    left.runtimeUnitId === right.runtimeUnitId && left.attemptId === right.attemptId &&
    left.podUid === right.podUid && left.executionEpoch === right.executionEpoch &&
    left.connectionInstanceId === right.connectionInstanceId
}
function imageMime(bytes: Uint8Array): string | null {
  const b = Buffer.from(bytes)
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {return 'image/png'}
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) {return 'image/jpeg'}
  if (b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a') {return 'image/gif'}
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') {return 'image/webp'}
  return null
}
