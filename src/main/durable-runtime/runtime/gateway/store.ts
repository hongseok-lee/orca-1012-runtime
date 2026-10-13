import { createHash, randomUUID } from 'node:crypto'
import { logicalId } from '../../../../shared/durable-runtime/identity.ts'
import type {
  CommandEnvelope,
  ExternalCommandIdentity,
  SettledCommandReceipt
} from '../command-types.ts'
import { DurableDatabaseError } from '../../db/connection.ts'
import type { LockedGatewayAuthority } from './authority.ts'
import { currentAuthoritySql } from './authority.ts'
import { canonicalInput, inputDigest } from './input.ts'
import type { CommandId, CommandRow, JsonValue, SubmitCommand, SubmitResult } from './types.ts'

export function originalIdentity(row: CommandRow): ExternalCommandIdentity {
  const authority = {
    operationId: row.operation_id,
    controllerTerm: row.original_controller_term,
    stepRevision: row.step_revision,
    executionEpoch: row.execution_epoch,
    intentRevision: row.intent_revision
  }
  let originalEnvelope: CommandEnvelope
  if (row.pod_target === 'CREATE_WITHOUT_POD' && row.expected_pod_uid === null) {
    originalEnvelope = { ...authority, podTarget: 'CREATE_WITHOUT_POD', expectedPodUid: null }
  } else if (row.pod_target === 'EXISTING_POD' && row.expected_pod_uid !== null) {
    originalEnvelope = {
      ...authority,
      podTarget: 'EXISTING_POD',
      expectedPodUid: row.expected_pod_uid
    }
  } else {
    throw new DurableDatabaseError('COMMAND_STORED_TARGET_INVALID')
  }
  return { command: row.command_name, originalEnvelope, inputHash: row.input_hash }
}
export function assertOriginal(row: CommandRow, expected: ExternalCommandIdentity): void {
  const actual = originalIdentity(row)
  const a = actual.originalEnvelope
  const b = expected.originalEnvelope
  if (
    actual.command !== expected.command ||
    actual.inputHash !== expected.inputHash ||
    a.operationId !== b.operationId ||
    a.controllerTerm !== b.controllerTerm ||
    a.stepRevision !== b.stepRevision ||
    a.podTarget !== b.podTarget ||
    a.expectedPodUid !== b.expectedPodUid ||
    a.executionEpoch !== b.executionEpoch ||
    a.intentRevision !== b.intentRevision ||
    inputDigest(row.input) !== row.input_hash
  ) {
    throw new DurableDatabaseError('COMMAND_IDENTITY_CONFLICT')
  }
}

export async function appendHistory(
  authority: LockedGatewayAuthority,
  row: CommandRow,
  stage: string
): Promise<void> {
  const { controller } = authority.context
  const history = await authority.tx.query(
    `INSERT INTO durable_runtime.runtime_command_history
     (id,command_id,stage,controller_term,executor_id,execution_token,evidence_refs)
     SELECT $4,$5,$6,$3,$7,$8,$9::jsonb WHERE ${currentAuthoritySql}`,
    [
      controller.scope,
      controller.owner,
      controller.term,
      randomUUID(),
      row.id,
      stage,
      row.executor_id,
      row.execution_token,
      JSON.stringify(row.evidence_refs)
    ]
  )
  if (history.rowCount !== 1) {
    throw new DurableDatabaseError('COMMAND_AUTHORITY_STALE')
  }
}

// Helpers never COMMIT, reconnect, retry a transaction, or perform external I/O.
// Caller must propagate failure so command/history and future audit/outbox roll
// back together. P1-03 owns the eventual commit/uncertain-COMMIT orchestration.
export async function lookupCommand(
  authority: LockedGatewayAuthority,
  original: ExternalCommandIdentity
): Promise<CommandRow | null> {
  await authority.assertCurrent()
  if (original.originalEnvelope.operationId !== authority.context.operationId) {
    throw new DurableDatabaseError('COMMAND_OPERATION_SCOPE')
  }
  const result = await authority.tx.query<CommandRow>(
    `SELECT * FROM durable_runtime.runtime_commands
     WHERE operation_id=$1 AND runtime_unit_id=$2 AND step_revision=$3 AND command_name=$4`,
    [
      authority.context.operationId,
      authority.context.runtimeUnitId,
      original.originalEnvelope.stepRevision,
      original.command
    ]
  )
  const row = result.rows[0]
  if (!row) {
    return null
  }
  assertOriginal(row, original)
  return row
}

async function assertPredecessor(
  authority: LockedGatewayAuthority,
  receipt: SettledCommandReceipt<JsonValue>
): Promise<void> {
  const { identity } = receipt
  const result = await authority.tx.query<CommandRow>(
    `SELECT * FROM durable_runtime.runtime_commands
     WHERE operation_id=$1 AND step_revision=$2 AND command_name=$3 AND runtime_unit_id=$4`,
    [
      identity.originalEnvelope.operationId,
      identity.originalEnvelope.stepRevision,
      identity.command,
      authority.context.runtimeUnitId
    ]
  )
  const row = result.rows[0]
  if (!row) {
    throw new DurableDatabaseError('COMMAND_PREDECESSOR_INVALID')
  }
  assertOriginal(row, identity)
  // Validate the predecessor against its own exact original target, not the
  // next target (e.g. old Pod fence -> create without a Pod). New execution
  // authority/target are checked independently by assertExecutionTarget.
  if (
    row.state !== receipt.state ||
    (receipt.state === 'RESOLVED' &&
      canonicalInput(row.result) !== canonicalInput(receipt.result)) ||
    (receipt.state === 'REFUSED' && row.refusal_code !== receipt.reason)
  ) {
    throw new DurableDatabaseError('COMMAND_PREDECESSOR_INVALID')
  }
}

export async function submitCommand(
  authority: LockedGatewayAuthority,
  request: SubmitCommand
): Promise<SubmitResult> {
  // Seal the input serialization before awaiting queries; don't persist mutable
  // caller input after hashing a different version of it.
  const serializedInput = canonicalInput(request.input)
  if (createHash('sha256').update(serializedInput).digest('hex') !== request.inputHash) {
    throw new DurableDatabaseError('COMMAND_INPUT_HASH')
  }
  const original = {
    command: request.command,
    originalEnvelope: { ...request.envelope },
    inputHash: request.inputHash
  }
  const existing = await lookupCommand(authority, original)
  if (existing) {
    if (canonicalInput(existing.input) !== serializedInput) {
      throw new DurableDatabaseError('COMMAND_IDENTITY_CONFLICT')
    }
    return { disposition: 'REPLAYED', command: existing }
  }
  await authority.assertExecutionTarget(original.originalEnvelope, true)
  if (request.predecessor.kind === 'RECONCILED') {
    await assertPredecessor(authority, request.predecessor.receipt)
  }
  const unresolved = await authority.tx.query<CommandRow>(
    `SELECT * FROM durable_runtime.runtime_commands WHERE runtime_unit_id=$1
     AND state IN ('ACCEPTED','EXECUTING','UNKNOWN')`,
    [authority.context.runtimeUnitId]
  )
  if (unresolved.rows[0]) {
    return {
      disposition: 'BLOCKED_BY_UNRESOLVED_COMMAND',
      command: unresolved.rows[0],
      newCommandAccepted: false
    }
  }
  const { controller, runtimeUnitId } = authority.context
  const envelope = original.originalEnvelope
  const inserted = await authority.tx.query<CommandRow>(
    `INSERT INTO durable_runtime.runtime_commands
     (id,operation_id,runtime_unit_id,command_name,original_controller_term,step_revision,pod_target,
      expected_pod_uid,execution_epoch,intent_revision,input_hash,input,state,owner_controller_term,evidence_refs)
     SELECT $4,$5,$6,$7,$3,$8,$9,$10,$11,$12,$13,$14::jsonb,'ACCEPTED',$3,'[]'::jsonb
     WHERE ${currentAuthoritySql} RETURNING *`,
    [
      controller.scope,
      controller.owner,
      controller.term,
      logicalId('runtime-command', randomUUID()),
      envelope.operationId,
      runtimeUnitId,
      original.command,
      envelope.stepRevision,
      envelope.podTarget,
      envelope.expectedPodUid,
      envelope.executionEpoch,
      envelope.intentRevision,
      original.inputHash,
      serializedInput
    ]
  )
  const row = inserted.rows[0]
  if (!row) {
    throw new DurableDatabaseError('COMMAND_AUTHORITY_STALE')
  }
  await appendHistory(authority, row, 'ACCEPTED')
  return { disposition: 'ACCEPTED', command: row }
}

export async function takeOverCommand(
  authority: LockedGatewayAuthority,
  original: ExternalCommandIdentity
): Promise<CommandRow | null> {
  const row = await lookupCommand(authority, original)
  if (!row || row.state === 'RESOLVED' || row.state === 'REFUSED') {
    return row
  }
  const { controller } = authority.context
  if (row.owner_controller_term === controller.term) {
    return row
  }
  if (BigInt(row.owner_controller_term) > BigInt(controller.term)) {
    throw new DurableDatabaseError('COMMAND_AUTHORITY_STALE')
  }
  const updated = await authority.tx.query<CommandRow>(
    `UPDATE durable_runtime.runtime_commands SET owner_controller_term=$3,revision=revision+1
     WHERE id=$4 AND runtime_unit_id=$5 AND revision=$6
     AND state IN ('ACCEPTED','EXECUTING','UNKNOWN') AND owner_controller_term<$3
     AND ${currentAuthoritySql} RETURNING *`,
    [
      controller.scope,
      controller.owner,
      controller.term,
      row.id,
      authority.context.runtimeUnitId,
      row.revision
    ]
  )
  const adopted = updated.rows[0]
  if (!adopted) {
    throw new DurableDatabaseError('COMMAND_ADOPTION_CONFLICT')
  }
  await appendHistory(authority, adopted, 'TAKEN_OVER')
  // Original input/term/target/state/token remain untouched. Adoption is never
  // permission to re-claim an EXECUTING/UNKNOWN command.
  return adopted
}

export async function commandById(
  authority: LockedGatewayAuthority,
  id: CommandId
): Promise<CommandRow> {
  await authority.assertCurrent()
  const result = await authority.tx.query<CommandRow>(
    'SELECT * FROM durable_runtime.runtime_commands WHERE id=$1 AND runtime_unit_id=$2 AND operation_id=$3',
    [id, authority.context.runtimeUnitId, authority.context.operationId]
  )
  const row = result.rows[0]
  if (!row) {
    throw new DurableDatabaseError('COMMAND_NOT_FOUND')
  }
  return row
}
