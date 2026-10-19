import type { JsonValue } from '../../db/atomic.ts'
import type { CodexAppServerConnection } from '../../../codex/codex-app-server-connection-types'

type RecordValue = Record<string, unknown>
export const record = (value: unknown): RecordValue | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : null
export const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null
export const turnIdOf = (value: unknown): string | null => {
  const root = record(value)
  return text(record(root?.turn)?.id) ?? text(root?.turnId)
}
export const threadIdOf = (value: unknown): string | null => {
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
/** Actual app-server notification, separate from admission/stop observations. */
export type CodexNativeNotification = Readonly<{
  connectionId: string
  sequence: string
  method: string
  params: JsonValue
  observedAt: string
}>
export type RequestState = {
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
