import type { DurableTransaction } from '../db/connection.ts'
import type { JsonValue } from '../db/atomic.ts'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { inputDigest, canonicalInput } from '../runtime/gateway/input.ts'
import type { CommandEnvelope } from '../runtime/command-types.ts'
import { assertOriginal, originalIdentity } from '../runtime/gateway/store.ts'
import type { CommandRow } from '../runtime/gateway/types.ts'
import type { InputAuthority } from './types.ts'
import { InputStoreError } from './types.ts'

export function commandObject(value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputStoreError('INPUT_COMMAND_PAYLOAD')
  }
  return value
}
function stringField(value: Record<string, JsonValue>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || !field) {
    throw new InputStoreError('INPUT_STAGE_BINDING')
  }
  return field
}
export function stageBinding(value: JsonValue) {
  const row = commandObject(value)
  if (
    Object.keys(row).sort().join(',') !==
    'bodyRef,contextRevision,deliveryAttemptId,messageId,payloadHash,sealedRevision'
  ) {
    throw new InputStoreError('INPUT_STAGE_BINDING')
  }
  const payloadHash = stringField(row, 'payloadHash')
  if (!/^[a-f0-9]{64}$/.test(payloadHash)) {
    throw new InputStoreError('INPUT_STAGE_BINDING')
  }
  return {
    messageId: logicalId('message', stringField(row, 'messageId')),
    deliveryAttemptId: logicalId('delivery-attempt', stringField(row, 'deliveryAttemptId')),
    sealedRevision: counter('message-revision', stringField(row, 'sealedRevision')),
    contextRevision: counter('context-revision', stringField(row, 'contextRevision')),
    payloadHash,
    bodyRef: stringField(row, 'bodyRef')
  }
}
export async function originalStageForDelivery(
  tx: DurableTransaction,
  deliveryId: string
): Promise<CommandRow | null> {
  const rows = await tx.query<CommandRow>(
    `SELECT * FROM durable_runtime.runtime_commands WHERE command_name='stageInput'
     AND input->>'deliveryAttemptId'=$1`,
    [deliveryId]
  )
  if (rows.rows.length > 1) {
    throw new InputStoreError('INPUT_STAGE_BINDING_CONFLICT')
  }
  const row = rows.rows[0]
  if (row) {
    assertOriginal(row, originalIdentity(row))
  }
  return row ?? null
}
export async function readInputExecutionTarget(
  tx: DurableTransaction,
  authority: InputAuthority,
  unitId: string
) {
  const rows = await tx.query<{
    lifecycle: string
    context_revision: string
    provider_binding_revision: string
    desired_mode: string
    phase: string
    active_attempt_id: string | null
    execution_epoch: string
    pod_uid: string | null
  }>(
    `SELECT s.lifecycle,s.context_revision,s.provider_binding_revision,u.desired_mode,u.phase,
     u.active_attempt_id,u.execution_epoch,a.pod_uid FROM durable_runtime.sessions s
     JOIN durable_runtime.runtime_members m ON m.session_id=s.id
     JOIN durable_runtime.runtime_units u ON u.id=m.runtime_unit_id
     LEFT JOIN durable_runtime.attempts a ON a.id=u.active_attempt_id
     WHERE s.id=$1 AND u.id=$2`,
    [authority.sessionId, unitId]
  )
  const row = rows.rows[0]
  if (!row) {
    throw new InputStoreError('INPUT_EXECUTION_SCOPE')
  }
  return row
}
export function sameStageInput(a: JsonValue, b: JsonValue): boolean {
  return inputDigest(a) === inputDigest(b)
}

/** Owned plain JSON, frozen recursively; no caller reference survives an await. */
export function ownedInputJson(value: JsonValue): JsonValue {
  const snapshot: JsonValue = JSON.parse(canonicalInput(value))
  function freeze(item: JsonValue): void {
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child)
      Object.freeze(item)
    }
  }
  freeze(snapshot)
  return snapshot
}
/** Value validation only, not controller/workload authentication or permission. */
export function snapshotInputEnvelope(envelope: CommandEnvelope): CommandEnvelope {
  const snapshot = Object.freeze({ ...envelope })
  logicalId('operation', snapshot.operationId)
  counter('controller-term', snapshot.controllerTerm)
  counter('step-revision', snapshot.stepRevision)
  counter('execution-epoch', snapshot.executionEpoch)
  counter('intent-revision', snapshot.intentRevision)
  if ((snapshot.podTarget === 'EXISTING_POD' && !!snapshot.expectedPodUid) ||
      (snapshot.podTarget === 'CREATE_WITHOUT_POD' && snapshot.expectedPodUid === null)) return snapshot
  throw new InputStoreError('INPUT_COMMAND_TARGET')
}
