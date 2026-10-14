import type { Pool } from 'pg'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { RuntimeUnitId } from '../../../shared/durable-runtime/identity.ts'
import { isTerminalQueryReply } from '../../../shared/terminal-query-reply'
import { withDurableTransaction, type DurableTransaction } from '../db/connection.ts'
import { runDurableMutation, resolveReceipt } from '../db/atomic.ts'
import type { MutationOutcome, ReceiptResolution, JsonValue } from '../db/atomic.ts'
import { assertInputScope, assertNewInputState, discoverInputUnit } from '../input/authority.ts'
import { acceptInputInTransaction } from '../input/intake.ts'
import { requireInputSessionLock } from '../input/composition.ts'
import { canonicalInputJson } from '../input/canonical.ts'
import { emptyTerminalDraft, reduceTerminalDraft } from './draft-reducer'
import { draftAttachmentsAfterReduction } from './durable-codec'
import { readTerminalDraftInTransaction, saveTerminalDraftInTransaction } from './draft-repository'
import { assertTerminalFloorPin, readTerminalFloorInTransaction } from './floor-repository'
import { TerminalDraftStoreError } from './durable-contracts'
import type { ManagedTerminalIngressRequest } from './durable-contracts'
import { prepareManagedTerminalIngress, requireCurrentTerminalIngress, terminalIntakePayload } from './managed-preparation'
import type { PreparedManagedTerminalIngress } from './managed-preparation'

/** Internal outcome only. P103 owns original receipt replay, observed COMMIT and uncertainty. */
export async function applyManagedTerminalIngress(
  pool: Pool,
  request: ManagedTerminalIngressRequest
): Promise<MutationOutcome> {
  const prepared = prepareManagedTerminalIngress(request)
  prepared.authorize()
  await withDurableTransaction(pool, (tx) => assertInputScope(tx, prepared.authority))
  prepared.authorize()
  const existing = await resolveReceipt(pool, prepared.identity)
  prepared.authorize()
  if (existing.status === 'FOUND') {
    // P103 observes the replay transaction's COMMIT; no mutable floor/draft or Unit rediscovery.
    return runDurableMutation(pool, { ...prepared.identity, locks: {} }, async () => {
      throw new TerminalDraftStoreError('TERMINAL_REPLAY_RECEIPT_DISAPPEARED')
    })
  }
  if (existing.status === 'UNAVAILABLE') {
    throw new TerminalDraftStoreError('TERMINAL_RECEIPT_UNAVAILABLE')
  }
  if (prepared.snapshot.scope.binding.mode !== 'AGENT_CHAT_COMPAT' ||
    prepared.snapshot.action.inputKind === 'query-reply' ||
    (prepared.snapshot.source === 'BINARY' && prepared.snapshot.inputBytes !== null &&
      isTerminalQueryReply(new TextDecoder().decode(Uint8Array.from(prepared.snapshot.inputBytes))))) {
    throw new TerminalDraftStoreError('TERMINAL_NON_DRAFT_TRAFFIC')
  }
  const unit = await discoverInputUnit(pool, prepared.authority)
  prepared.authorize()
  return runDurableMutation(pool, { ...prepared.identity,
    locks: { sessionIds: [prepared.authority.sessionId], runtimeUnitIds: unit ? [unit] : [] } },
    (tx) => applyManagedTerminalIngressInTransaction(tx, prepared, unit))
}

/** No nested receipt/pool wrapper, COMMIT, provider/PTY or FS effect in this entry. */
export async function applyManagedTerminalIngressInTransaction(
  tx: DurableTransaction,
  prepared: PreparedManagedTerminalIngress,
  expectedUnitId: RuntimeUnitId | null
): Promise<JsonValue> {
  const scope = prepared.snapshot.scope
  requireInputSessionLock(tx, logicalId('session', scope.binding.sessionId))
  requireCurrentTerminalIngress(prepared)
  await assertNewInputState(tx, prepared.authority, prepared.sessionFence, expectedUnitId)
  requireCurrentTerminalIngress(prepared)
  const floor = await readTerminalFloorInTransaction(tx, scope.binding)
  requireCurrentTerminalIngress(prepared)
  assertTerminalFloorPin(floor, { binding: scope.binding, revision: prepared.expectedFloorRevision })
  const original = await readTerminalDraftInTransaction(tx, scope.binding)
  requireCurrentTerminalIngress(prepared)
  const draft = original?.draft ?? emptyTerminalDraft(scope.binding, '0')
  if (draft.revision !== scope.draftRevision) {
    throw new TerminalDraftStoreError('TERMINAL_STALE_DRAFT_REVISION')
  }
  const reduced = reduceTerminalDraft(draft, prepared.snapshot)
  if ((reduced.kind !== 'DRAFT_EDIT' && reduced.kind !== 'SUBMIT_CANDIDATE') || !reduced.draft) {
    // Protocol/raw/Stop/unsupported traffic produces no draft receipt, input or new target.
    throw new TerminalDraftStoreError('TERMINAL_SEMANTIC_UNSUPPORTED')
  }
  const attachments = draftAttachmentsAfterReduction(reduced.draft, original?.attachments ?? [], prepared.attachments)
  let input: JsonValue = null
  let nextDraft = reduced.draft
  let nextAttachments = attachments
  if (reduced.kind === 'SUBMIT_CANDIDATE') {
    if (!reduced.candidate || expectedUnitId === null) {
      throw new TerminalDraftStoreError('TERMINAL_SUBMIT_SCOPE')
    }
    const candidate = reduced.candidate
    const payload = terminalIntakePayload(prepared, candidate.text,
      candidate.chunks.map((chunk) => ({ ingressId: chunk.ingressId,
        text: chunk.text, attachments: chunk.attachments.map((ref) => ({ ...ref })) })))
    const accepted = await acceptInputInTransaction(tx, {
      authority: prepared.authority, method: 'terminal.send',
      operationKey: prepared.identity.key.operationKey, inputKind: 'GENERAL',
      sessionFence: prepared.sessionFence, payload,
      attachments: attachments.map(({ aliasPath, contentHash }) => ({ aliasPath, contentHash }))
    }, expectedUnitId)
    requireCurrentTerminalIngress(prepared)
    input = JSON.parse(canonicalInputJson(accepted)) as JsonValue
    // The original input is now transaction-local; a later failure rolls it and this reset back together.
    nextDraft = emptyTerminalDraft(scope.binding, draft.revision)
    nextAttachments = []
  }
  const saved = await saveTerminalDraftInTransaction(tx, { draft: nextDraft,
    attachments: nextAttachments, lastIngress: prepared.wire }, draft.revision, original !== null)
  requireCurrentTerminalIngress(prepared)
  return { version: 1, kind: reduced.kind === 'SUBMIT_CANDIDATE' ? 'SUBMITTED' : 'DRAFT_EDIT',
    terminalHandle: scope.binding.logicalHandle, draftRevision: saved.draft.revision,
    floorRevision: prepared.expectedFloorRevision, input }
}

export async function resolveManagedTerminalIngressReceipt(
  pool: Pool,
  request: ManagedTerminalIngressRequest
): Promise<ReceiptResolution> {
  const prepared = prepareManagedTerminalIngress(request)
  prepared.authorize()
  await withDurableTransaction(pool, (tx) => assertInputScope(tx, prepared.authority))
  prepared.authorize()
  return resolveReceipt(pool, prepared.identity)
}

/** Public wiring is absent; an uncertain COMMIT never produces accepted=true here. */
export function managedTerminalIngressWireResult(outcome: MutationOutcome):
  Readonly<{ send: Readonly<{ handle: string; accepted: true; bytesWritten: 0 }> }> | null {
  if (outcome.status === 'UNCERTAIN') {
    return null
  }
  const response = outcome.receipt.response
  if (!response || typeof response !== 'object' || Array.isArray(response) ||
    response.version !== 1 || !['DRAFT_EDIT', 'SUBMITTED'].includes(String(response.kind)) ||
    typeof response.terminalHandle !== 'string' || !response.terminalHandle) {
    throw new TerminalDraftStoreError('TERMINAL_RECEIPT_RESPONSE')
  }
  return Object.freeze({ send: Object.freeze({ handle: response.terminalHandle, accepted: true, bytesWritten: 0 }) })
}
