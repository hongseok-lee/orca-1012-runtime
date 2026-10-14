import type { Pool } from 'pg'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import type { RuntimeUnitId } from '../../../shared/durable-runtime/identity.ts'
import { runDurableMutation, resolveReceipt } from '../db/atomic.ts'
import type { MutationOutcome, ReceiptResolution } from '../db/atomic.ts'
import { withDurableTransaction, type DurableTransaction } from '../db/connection.ts'
import { appendSessionEvent, enqueueOutbox } from '../journal/store.ts'
import { prepareInputRequest, inputScopeKey } from './canonical.ts'
import { assertInputScope, discoverInputUnit, assertNewInputState } from './authority.ts'
import { validateInputAttachments, appendInputComponent } from './append.ts'
import { closeLatestMergeable, requireInputSessionLock } from './composition.ts'
import { InputStoreError, type InputRequest, type InputAuthority } from './types.ts'

/** Authenticated scope first; P1-03 owns replay/race/uncertain COMMIT behavior. */
export async function acceptInput(pool: Pool, request: InputRequest): Promise<MutationOutcome> {
  const prepared = prepareInputRequest(request)
  const authority = prepared.request.authority
  const discovered = await discoverInputUnit(pool, authority)
  return runDurableMutation(
    pool,
    {
      ...prepared.identity,
      locks: { sessionIds: [authority.sessionId], runtimeUnitIds: discovered ? [discovered] : [] }
    },
    (tx) => acceptInputInTransaction(tx, prepared.request, discovered)
  )
}
/** Upper outer receipt/transaction owns COMMIT. The caller fixes the request
 * before its first await; this entry also owns a complete prepared snapshot.
 * Existing Session/Unit locks and original membership are required. No discovery,
 * replacement Unit, nested transaction or external effect is created here.
 */
export async function acceptInputInTransaction(
  tx: DurableTransaction,
  snapshotRequest: InputRequest,
  expectedUnitId: RuntimeUnitId | null
) {
  const prepared = prepareInputRequest(snapshotRequest)
  const authority = prepared.request.authority
  requireInputSessionLock(tx, authority.sessionId)
  if (expectedUnitId !== null && !tx.isLockHeld(2, expectedUnitId)) {
    throw new InputStoreError('INPUT_UNIT_UNAVAILABLE')
  }
  const unit = await assertNewInputState(
    tx,
    authority,
    prepared.request.sessionFence,
    expectedUnitId
  )
  await validateInputAttachments(tx, prepared)
  const appended = await appendInputComponent(tx, prepared)
  const runtime = await tx.query<{ intent_revision: string; revision: string }>(
    `UPDATE durable_runtime.runtime_units
   SET intent_revision=intent_revision+CASE WHEN desired_mode='SUSPENDED' THEN 1 ELSE 0 END,
       desired_mode='RUNNING',reconcile_due_at=LEAST(COALESCE(reconcile_due_at,clock_timestamp()),clock_timestamp()),
       last_work_event_at=clock_timestamp(),revision=revision+1
   WHERE id=$1 AND desired_mode<>'DELETED' RETURNING intent_revision,revision`,
    [unit]
  )
  // No controller term/lease, provider work, synthetic wake operation or READY phase.
  const event = await appendSessionEvent(tx, {
    sessionId: authority.sessionId,
    source: {
      kind: 'PRODUCER',
      sourceKind: 'INPUT_SUBMISSION',
      producerId: authority.sessionId,
      incarnation: 'durable-input-v1',
      producerSeq: counter('sequence:producer', appended.inputSequence)
    },
    body: {
      kind: 'INPUT_SUBMISSION',
      ...appended,
      originalPayloadHash: prepared.identity.payloadHash
    }
  })
  await enqueueOutbox(tx, {
    eventId: event.eventId,
    aggregateId: unit,
    aggregateKind: 'runtime-unit',
    revision: counter('row:runtime-unit', runtime.rows[0].revision),
    event: {
      kind: 'RECONCILE_INPUT',
      runtimeUnitId: unit,
      sessionId: authority.sessionId,
      inputId: appended.inputId,
      inputSequence: appended.inputSequence,
      journalEventId: event.eventId,
      intentRevision: runtime.rows[0].intent_revision
    }
  })
  return {
    ...appended,
    runtimeUnitId: unit,
    intentRevision: runtime.rows[0].intent_revision,
    submissionEventId: event.eventId,
    journalSequence: event.sequence
  }
}

export async function resolveInputReceipt(
  pool: Pool,
  request: InputRequest
): Promise<ReceiptResolution> {
  const prepared = prepareInputRequest(request)
  await withDurableTransaction(pool, (tx) => assertInputScope(tx, prepared.request.authority))
  return resolveReceipt(pool, prepared.identity)
}
/** Future raw/semantic adapter uses its existing transaction; no PTY/wake/activity here. */
export async function closeInputMergeBoundary(
  tx: DurableTransaction,
  authority: InputAuthority
): Promise<string | null> {
  inputScopeKey(authority)
  requireInputSessionLock(tx, logicalId('session', authority.sessionId))
  await assertInputScope(tx, authority)
  return closeLatestMergeable(tx, authority.sessionId)
}
