import * as Wire from '../../../shared/rpc-contract/structured-agent-session-params'
import {
  computeAgentSessionPayloadFingerprint,
  agentSessionFingerprintConflict
} from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope, AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { SessionFence } from '../../../shared/durable-runtime/identity.ts'
import { structuredFenceToDecimal } from './counters.ts'
import { snapshotStructuredJson, StructuredPreparationError, type JsonSnapshot } from './snapshot.ts'

const schemas = {
  'agentSession.createSupport': Wire.CreateSupportParams,
  'agentSession.create': Wire.CreateParams,
  'agentSession.send': Wire.SendParams,
  'agentSession.history': Wire.HistoryParams,
  'agentSession.subscribe': Wire.SubscribeParams,
  'agentSession.cancel': Wire.CancelParams,
  'agentSession.respondToQuestion': Wire.RespondParams,
  'agentSession.respondToApproval': Wire.RespondParams,
  'agentSession.setOption': Wire.SetOptionParams,
  'agentSession.conversationCommand': Wire.ConversationCommandParams,
  'agentSession.rewind': Wire.RewindParams,
  'agentSession.requestHandoff': Wire.HandoffParams
} as const
export type StructuredMethod = keyof typeof schemas
type JsonObject = Readonly<Record<string, JsonSnapshot>>
export type StructuredTarget =
  | Readonly<{ kind: 'SESSION'; publicSessionId: string }>
  | Readonly<{ kind: 'WORKTREE'; worktree: string; publicSessionId: string | null }>
  | Readonly<{
      kind: 'WORKSPACE_LOCATION'; publicSessionId: string; workspaceId: string
      executionHostId: string; wslDistro: string | null; workspaceKind: string
    }>
export type PreparedStructuredMutation = Readonly<{
  publicSessionId: string
  operationKey: string
  fingerprintMethod: string
  wireFingerprint: string
  semanticBody: JsonObject
  wireFence: number | null
  sessionFence: SessionFence | null
  clientMessageId: string | null
  handoffOperationFingerprint: string | null
}>
export type PreparedStructuredWire = Readonly<{
  method: StructuredMethod
  params: JsonObject
  capabilities: readonly string[]
  target: StructuredTarget
  mutation: PreparedStructuredMutation | null
}>
export type StructuredWirePreparation =
  | { readonly ok: true; readonly value: PreparedStructuredWire }
  | { readonly ok: false; readonly refusal: AgentSessionWireRefusal }

function object(value: JsonSnapshot): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StructuredPreparationError('STRUCTURED_NON_OBJECT')
  }
  return value as JsonObject
}
function text(value: JsonSnapshot): string {
  if (typeof value !== 'string') {
    throw new StructuredPreparationError('STRUCTURED_INVALID_IDENTITY')
  }
  return value
}
function pick(params: JsonObject, keys: readonly string[]): JsonObject {
  const fields: Record<string, JsonSnapshot> = Object.create(null)
  for (const key of keys) {
    if (Object.hasOwn(params, key)) {
      fields[key] = params[key]
    }
  }
  return Object.freeze(fields)
}

function semantic(method: StructuredMethod, params: JsonObject): { method: string; fields: JsonObject } {
  switch (method) {
    case 'agentSession.create':
      if (Object.hasOwn(params, 'worktree')) {
        return { method, fields: pick(params, ['worktree', 'agent', 'resumeFrom']) }
      }
      // Exact attachFingerprintFields contract. No adopt is allowed by the wire schema.
      return { method: 'agentSession.attach', fields: Object.freeze({
        ...pick(params, ['location', 'provider', 'agent', 'accountHome', 'runtimeKind', 'providerHandle']),
        expectedRuntimeFence: object(params.envelope).expectedRuntimeFence
      }) }
    case 'agentSession.send': return { method, fields: pick(params, ['body']) }
    case 'agentSession.cancel': return { method, fields: pick(params, ['turnId', 'scope', 'taskId']) }
    case 'agentSession.respondToQuestion':
    case 'agentSession.respondToApproval':
      return {
        method: method === 'agentSession.respondToQuestion' ? 'agentSession.respondTo:question' : 'agentSession.respondTo:approval',
        fields: pick(params, ['itemId', 'expectedRevision', 'optionId'])
      }
    case 'agentSession.setOption': return { method, fields: pick(params, ['key', 'value']) }
    case 'agentSession.conversationCommand': return { method, fields: pick(params, ['command']) }
    case 'agentSession.rewind': return { method, fields: pick(params, ['itemId', 'expectedEpoch']) }
    case 'agentSession.requestHandoff':
      return { method, fields: Object.freeze({ ...pick(params, ['direction', 'mode']), action: params.action ?? 'start' }) }
    default: throw new StructuredPreparationError('STRUCTURED_NOT_MUTATION')
  }
}

/** Runs entirely before any await. Parsing is the existing strict schema, not a new DTO. */
export function prepareStructuredWire(
  method: StructuredMethod,
  rawParams: unknown,
  rawCapabilities: readonly string[]
): StructuredWirePreparation {
  if (!Object.hasOwn(schemas, method)) {
    throw new StructuredPreparationError('STRUCTURED_METHOD_NOT_PREPARED')
  }
  const params = object(snapshotStructuredJson(schemas[method].parse(snapshotStructuredJson(rawParams))))
  if (Object.hasOwn(params, 'expectedRevision') &&
    (typeof params.expectedRevision !== 'number' || !Number.isSafeInteger(params.expectedRevision))) {
    throw new StructuredPreparationError('STRUCTURED_UNREADABLE_COUNTER')
  }
  if (Object.hasOwn(params, 'cursor') && !Number.isSafeInteger(object(params.cursor).sequence)) {
    throw new StructuredPreparationError('STRUCTURED_UNREADABLE_COUNTER')
  }
  const capabilities = snapshotStructuredJson(rawCapabilities)
  if (!Array.isArray(capabilities) || !capabilities.every((entry) => typeof entry === 'string')) {
    throw new StructuredPreparationError('STRUCTURED_INVALID_CAPABILITIES')
  }
  let mutation: PreparedStructuredMutation | null = null
  if (Object.hasOwn(params, 'envelope')) {
    const envelope = object(params.envelope)
    const publicSessionId = text(envelope.sessionId)
    const fence = envelope.expectedRuntimeFence
    if (method === 'agentSession.create' ? fence !== null : typeof fence !== 'number') {
      throw new StructuredPreparationError('STRUCTURED_INVALID_FENCE')
    }
    const sessionFence = fence === null ? null : structuredFenceToDecimal(fence as number)
    const body = semantic(method, params)
    const fingerprint = computeAgentSessionPayloadFingerprint({ method: body.method, sessionId: publicSessionId, fields: body.fields })
    const conflict = agentSessionFingerprintConflict(envelope as unknown as AgentSessionMutationEnvelope, fingerprint)
    if (conflict) {
      return Object.freeze({ ok: false, refusal: Object.freeze(conflict) })
    }
    const operationKey = text(envelope.clientOperationId)
    mutation = Object.freeze({
      publicSessionId, operationKey, fingerprintMethod: body.method, wireFingerprint: fingerprint,
      semanticBody: body.fields, wireFence: fence as number | null, sessionFence,
      clientMessageId: method === 'agentSession.send' ? operationKey : null,
      handoffOperationFingerprint: method === 'agentSession.requestHandoff'
        ? computeAgentSessionPayloadFingerprint({ method: 'agentSession.requestHandoff.operation', sessionId: publicSessionId, fields: { direction: params.direction } }) : null
    })
  }
  let target: StructuredTarget
  if (Object.hasOwn(params, 'worktree')) {
    target = Object.freeze({ kind: 'WORKTREE', worktree: text(params.worktree), publicSessionId: mutation?.publicSessionId ?? null })
  } else if (Object.hasOwn(params, 'location')) {
    const location = object(params.location)
    target = Object.freeze({
      kind: 'WORKSPACE_LOCATION', publicSessionId: mutation!.publicSessionId,
      workspaceId: text(location.workspaceId), executionHostId: text(location.executionHostId),
      wslDistro: location.wslDistro === null ? null : text(location.wslDistro), workspaceKind: text(location.workspaceKind)
    })
  } else {
    target = Object.freeze({ kind: 'SESSION', publicSessionId: mutation?.publicSessionId ?? text(params.sessionId) })
  }
  return Object.freeze({ ok: true, value: Object.freeze({ method, params, capabilities: capabilities as readonly string[], target, mutation }) })
}
