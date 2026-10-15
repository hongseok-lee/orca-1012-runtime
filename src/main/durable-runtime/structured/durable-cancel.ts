import type { AgentSessionCancelResult, AgentSessionMutationResult } from '../../../shared/agent-session-wire'
import { Identifier, JournalCursor, SessionId as PublicSessionId } from '../../../shared/rpc-contract/structured-agent-session-params'
import { counter } from '../../../shared/durable-runtime/identity.ts'
import { runDurableMutation, type JsonValue, type MutationOutcome } from '../db/atomic.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import { discoverInputUnit, assertNewInputState } from '../input/authority.ts'
import { recordObservedTurnCancel } from '../input/cancel.ts'
import type { InputAuthority } from '../input/types.ts'
import { resolveStructuredSession, readStructuredSessionAlias } from './durable-alias.ts'
import { capturedJson, jsonValue, prepareDurableStructuredCall, structuredReceiptIdentity } from './durable-common.ts'
import type { DurableStructuredCall, StructuredWorkspaceExpectation } from './durable-types.ts'
import { structuredCounterToNumber, structuredFenceToDecimal } from './counters.ts'
import { snapshotStructuredJson } from './snapshot.ts'

export type DurableStructuredCancelCall = DurableStructuredCall & Readonly<{
  workspace: StructuredWorkspaceExpectation
}>
export type DurableStructuredCancelOutcome =
  | Extract<MutationOutcome, { status: 'UNCERTAIN' }>
  | (Exclude<MutationOutcome, { status: 'UNCERTAIN' }> & Readonly<{
      wireResult: AgentSessionMutationResult<AgentSessionCancelResult>
    }>)

function record(value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DurableDatabaseError('STRUCTURED_RECEIPT_UNREADABLE')
  }
  return value
}
/** Read the original committed response; later observations never rewrite a false receipt. */
function storedWire(response: JsonValue, replayed: boolean, turnId: string): AgentSessionMutationResult<AgentSessionCancelResult> {
  try {
    const saved = record(jsonValue(snapshotStructuredJson(response)))
    if (typeof saved.fence !== 'number') {
      throw new DurableDatabaseError('STRUCTURED_RECEIPT_UNREADABLE')
    }
    structuredFenceToDecimal(saved.fence)
    const cursor = JournalCursor.parse(saved.cursor)
    counter('journal-epoch', cursor.epoch)
    if (!Number.isSafeInteger(cursor.sequence) || cursor.sequence < 1) {
      throw new DurableDatabaseError('STRUCTURED_RECEIPT_UNREADABLE')
    }
    const value = record(saved.value)
    if (Identifier('Invalid turn id').parse(value.turnId) !== turnId || typeof value.cancelled !== 'boolean') {
      throw new DurableDatabaseError('STRUCTURED_RECEIPT_UNREADABLE')
    }
    return Object.freeze({ ok: true, replayed, fence: saved.fence, cursor: Object.freeze(cursor),
      value: Object.freeze({ turnId, cancelled: value.cancelled }) })
  } catch {
    throw new DurableDatabaseError('STRUCTURED_RECEIPT_UNREADABLE')
  }
}

/** Internal receipt-first adapter. Caller already authenticated/authorized the public alias. */
export async function cancelDurableStructuredTurn(call: DurableStructuredCancelCall): Promise<DurableStructuredCancelOutcome> {
  const { wire, authority } = prepareDurableStructuredCall(call, 'agentSession.cancel')
  const mutation = wire.mutation!
  const workspace = capturedJson(call.workspace)
  const owner = call.pool, connect = owner.connect.bind(owner), query = owner.query.bind(owner)
  const pool = new Proxy(owner, { get(target, key) {
    if (key === 'connect') { return connect }
    if (key === 'query') { return query }
    return Reflect.get(target, key, target)
  } })
  PublicSessionId.parse(mutation.publicSessionId)
  const turnId = Identifier('Invalid turn id').parse(wire.params.turnId)
  if (mutation.sessionFence === null || mutation.wireFence === null) {
    throw new DurableDatabaseError('STRUCTURED_INVALID_FENCE')
  }
  const sessionFence = mutation.sessionFence, wireFence = mutation.wireFence
  // Only the existing original turnId/scope/taskId fields enter the payload hash.
  const original = jsonValue(mutation.semanticBody)
  const identity = structuredReceiptIdentity(wire, authority, original)
  const alias = await resolveStructuredSession(pool, authority, workspace)
  const inputAuthority: InputAuthority = Object.freeze({ principal: authority.principal,
    sessionId: alias.sessionId, scope: Object.freeze({ kind: 'SESSION' }) })
  const expectedUnitId = await discoverInputUnit(pool, inputAuthority)
  const outcome = await runDurableMutation(pool, {
    ...identity, locks: { sessionIds: [alias.sessionId], runtimeUnitIds: expectedUnitId ? [expectedUnitId] : [] }
  }, async tx => {
    const current = await readStructuredSessionAlias(tx, authority, workspace)
    if (current.sessionId !== alias.sessionId || current.workspace.provider !== workspace.provider ||
        current.workspace.executionHostId !== workspace.executionHostId) {
      throw new DurableDatabaseError('STRUCTURED_SESSION_ALIAS_SCOPE')
    }
    // Unsupported background scope must not become a successful whole-turn cancellation.
    if (Object.hasOwn(wire.params, 'scope') || Object.hasOwn(wire.params, 'taskId')) {
      throw new DurableDatabaseError('STRUCTURED_BACKGROUND_CANCEL_NOT_CONNECTED')
    }
    const unit = await assertNewInputState(tx, inputAuthority, sessionFence, expectedUnitId)
    const cancellation = await recordObservedTurnCancel(tx, {
      authority: inputAuthority, provider: workspace.provider, nativeTurnId: turnId,
      method: wire.method, operationKey: mutation.operationKey, originalPayload: original
    }, unit)
    const cancelled = cancellation.interruptStatus === 'ALREADY_SETTLED' &&
      cancellation.target.provenance.some(entry => entry.classification === 'ORIGINAL_EXECUTION' && entry.state === 'INTERRUPTED')
    counter('journal-epoch', cancellation.journalEpoch)
    return { fence: wireFence, cursor: { epoch: cancellation.journalEpoch,
      sequence: structuredCounterToNumber(cancellation.sequence, 1) },
      value: { turnId, cancelled } }
  })
  if (outcome.status === 'UNCERTAIN') { return outcome }
  return Object.freeze({ ...outcome, wireResult: storedWire(outcome.receipt.response, outcome.status === 'REPLAYED', turnId) })
}
