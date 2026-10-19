import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { DurableTransaction } from '../db/connection.ts'
import { runDurableTransaction, withDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import type { ReadyProviderBinding } from '../providers/shared/contracts.ts'
import type { TerminalFloorPin } from './durable-contracts.ts'
import { TerminalDraftStoreError } from './durable-contracts.ts'
import { assertTerminalFloorPin, readTerminalFloorInTransaction } from './floor-repository.ts'
import { TERMINAL_INPUT_MAX_BYTES } from '../../../shared/terminal-input.ts'

type Result = Readonly<{ status: 'WRITTEN' | 'UNKNOWN' | 'REJECTED'; bytesWritten: number }>
type Row = { id: string; payload_hash: string; state: 'REQUESTED' | Result['status']; bytes_written: number }
const unknown: Result = Object.freeze({ status: 'UNKNOWN', bytesWritten: 0 })
function original(row: Row, hash: string): Result {
  if (row.payload_hash !== hash) { throw new TerminalDraftStoreError('TERMINAL_RAW_REQUEST_CONFLICT') }
  return row.state === 'REQUESTED' ? unknown : Object.freeze({ status: row.state, bytesWritten: row.bytes_written })
}

export async function readRawTerminalResult(pool: Pool, terminal: string, principal: string,
  connection: string, requestKey: string, bytes: Uint8Array): Promise<Result | null> {
  const found = await pool.query<Row>(`SELECT id,payload_hash,state,bytes_written FROM durable_runtime.terminal_raw_observations
    WHERE terminal_handle=$1 AND principal_id=$2 AND connection_id=$3 AND request_key=$4`,
  [terminal, principal, connection, requestKey])
  return found.rowCount ? original(found.rows[0], createHash('sha256').update(bytes).digest('hex')) : null
}

/** One-shot raw effect. A committed observation authorizes only the invocation
 * still held by this call; no recovery path dispatches a stored observation.
 * A response-loss/retry may read its result but can never write again. */
export async function writeRawTerminal(pool: Pool, input: Readonly<{
  binding: ReadyProviderBinding; floor: TerminalFloorPin; incarnationId: string; requestKey: string; bytes: Uint8Array
  assertCurrent(tx: DurableTransaction): Promise<void>
  write(requestId: string, bytes: string): Promise<unknown>
}>): Promise<Result> {
  const bytes = Buffer.from(input.bytes), b = input.binding, floor = input.floor
  if (!input.requestKey || input.requestKey.length > 1024 || bytes.length > TERMINAL_INPUT_MAX_BYTES ||
      floor.binding.mode !== 'RAW_TERMINAL' || floor.binding.sessionId !== b.sessionId ||
      floor.binding.logicalHandle !== b.terminalHandle || !/^[0-9a-f-]{36}$/.test(input.incarnationId)) {
    throw new TerminalDraftStoreError('TERMINAL_RAW_SCOPE')
  }
  const hash = createHash('sha256').update(bytes).digest('hex'), id = randomUUID()
  const identity = [b.terminalHandle, floor.binding.principalId, floor.binding.connectionId, input.requestKey]
  const existing = await pool.query<Row>(`SELECT id,payload_hash,state,bytes_written FROM durable_runtime.terminal_raw_observations
    WHERE terminal_handle=$1 AND principal_id=$2 AND connection_id=$3 AND request_key=$4`, identity)
  if (existing.rowCount) { return original(existing.rows[0], hash) }
  const authorized = async (tx: DurableTransaction) => {
    await lockAggregates(tx, { sessionIds: [b.sessionId], runtimeUnitIds: [b.runtimeUnitId] })
    await input.assertCurrent(tx)
    assertTerminalFloorPin(await readTerminalFloorInTransaction(tx, floor.binding), floor)
  }
  const reserved = await withDurableTransaction(pool, async tx => {
    await authorized(tx)
    const inserted = await tx.query(`INSERT INTO durable_runtime.terminal_raw_observations
      (id,session_id,terminal_handle,principal_id,connection_id,request_key,attempt_id,pty_incarnation_id,payload_hash,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'REQUESTED') ON CONFLICT DO NOTHING RETURNING id`,
    [id,b.sessionId,...identity,b.attemptId,input.incarnationId,hash])
    return inserted.rowCount === 1
  })
  if (!reserved) {
    const saved = await pool.query<Row>('SELECT id,payload_hash,state,bytes_written FROM durable_runtime.terminal_raw_observations WHERE terminal_handle=$1 AND principal_id=$2 AND connection_id=$3 AND request_key=$4', identity)
    if (saved.rowCount !== 1) { throw new TerminalDraftStoreError('TERMINAL_RAW_OBSERVATION_UNAVAILABLE') }
    return original(saved.rows[0], hash)
  }
  let attempted = false
  const settled = await runDurableTransaction(pool, async tx => {
    // Hold the same Session/Unit locks until write settles. A floor takeover or
    // runtime retirement cannot overtake this effect after its last PG check.
    await authorized(tx)
    let result: Result = unknown
    attempted = true
    try {
      const response = await input.write(id, bytes.toString('base64'))
      if (response && typeof response === 'object' &&
          Reflect.get(response, 'incarnationId') === input.incarnationId &&
          Reflect.get(response, 'status') === 'WRITTEN' && Reflect.get(response, 'bytesWritten') === bytes.length) {
        result = Object.freeze({ status: 'WRITTEN', bytesWritten: bytes.length })
      }
    } catch { /* delivery evidence remains UNKNOWN; never retry */ }
    await tx.query(`UPDATE durable_runtime.terminal_raw_observations SET state=$2,bytes_written=$3,settled_at=clock_timestamp()
      WHERE id=$1 AND state='REQUESTED'`, [id,result.status,result.bytesWritten])
    return result
  })
  if (settled.ok) { return settled.value }
  if (!attempted && (settled.settlement === 'ROLLED_BACK' || settled.settlement === 'NOT_STARTED')) {
    await pool.query("UPDATE durable_runtime.terminal_raw_observations SET state='REJECTED',settled_at=clock_timestamp() WHERE id=$1 AND state='REQUESTED'", [id])
    return Object.freeze({ status: 'REJECTED', bytesWritten: 0 })
  }
  return unknown
}
