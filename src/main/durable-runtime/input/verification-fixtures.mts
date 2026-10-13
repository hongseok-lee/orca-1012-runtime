import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { pairedDeviceAttachmentPrincipal } from '../attachments/types.ts'
import { withDurableTransaction } from '../db/connection.ts'
import type { MutationOutcome, JsonValue } from '../db/atomic.ts'
import { lockAggregates } from '../db/locks.ts'
import { closeInputMergeBoundary } from './intake.ts'
import type { InputRequest, InputAuthority } from './types.ts'

export async function fixture(pool: Pool, mode = 'SUSPENDED') {
  const ids = Array.from({ length: 6 }, () => randomUUID())
  await withDurableTransaction(pool, async (tx) => {
    await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES ($1,'verification')", [
      ids[0]
    ])
    await tx.query(
      "INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES ($1,$2,'input verification','READY')",
      [ids[1], ids[1]]
    )
    await tx.query(
      "INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES ($1,$2,$3,'OPEN')",
      [ids[2], ids[0], ids[1]]
    )
    await tx.query(
      "INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES ($1,$2,'ABSENT')",
      [ids[3], mode]
    )
    await tx.query(
      "INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES ($1,'verification')",
      [ids[4]]
    )
    await tx.query(
      "INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state) VALUES ($1,$2,'verification','/verification','READY')",
      [ids[5], ids[4]]
    )
    await tx.query(
      'INSERT INTO durable_runtime.runtime_members(session_id,runtime_unit_id,storage_binding_id) VALUES ($1,$2,$3)',
      [ids[2], ids[3], ids[5]]
    )
  })
  const terminalHandle = `input-verification-${randomUUID()}`
  await pool.query(
    "INSERT INTO durable_runtime.tabs(id,workspace_id,session_id,kind,terminal_handle,ui_order,lifecycle) VALUES ($1,$2,$3,'terminal',$4,0,'OPEN')",
    [randomUUID(), ids[1], ids[2], terminalHandle]
  )
  const authority: InputAuthority = {
    principal: pairedDeviceAttachmentPrincipal(randomUUID()),
    sessionId: logicalId('session', ids[2]),
    scope: { kind: 'SESSION' }
  }
  const request: InputRequest = {
    authority,
    method: 'verification.submit',
    operationKey: randomUUID(),
    inputKind: 'GENERAL',
    sessionFence: counter('session-fence', '0'),
    payload: { text: 'synthetic original input' },
    attachments: []
  }
  return { request, terminalHandle, unitId: ids[3] }
}
export function response(result: MutationOutcome): Record<string, JsonValue> {
  assert.ok(result.status !== 'UNCERTAIN')
  const value = result.receipt.response
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value
}
export function field(value: Record<string, JsonValue>, name: string): string {
  const item = value[name]
  assert.ok(typeof item === 'string')
  return item
}
export async function counts(pool: Pool, authority: InputAuthority, unitId: string) {
  const result = await pool.query(
    `SELECT
    (SELECT count(*)::text FROM durable_runtime.input_components WHERE session_id=$1) AS inputs,
    (SELECT count(*)::text FROM durable_runtime.messages WHERE session_id=$1) AS messages,
    (SELECT count(*)::text FROM durable_runtime.rpc_receipts WHERE principal_id=$2) AS receipts,
    (SELECT count(*)::text FROM durable_runtime.session_events WHERE session_id=$1) AS journal,
    (SELECT count(*)::text FROM durable_runtime.outbox_events WHERE aggregate_id=$3) AS outbox,
    (SELECT intent_revision::text FROM durable_runtime.runtime_units WHERE id=$3::uuid) AS intent`,
    [authority.sessionId, authority.principal, unitId]
  )
  return result.rows[0]
}
export async function boundary(pool: Pool, authority: InputAuthority) {
  return withDurableTransaction(pool, async (tx) => {
    await lockAggregates(tx, { sessionIds: [authority.sessionId] })
    return closeInputMergeBoundary(tx, authority)
  })
}
/** Wrap only this test's checked-out clients; never fail/restart PG or COMMIT. */
export function instrumentPool(
  pool: Pool,
  hooks: { onConnect?: (number: number) => Promise<void>; beforeQuery?: (sql: string) => void }
) {
  let connections = 0
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'connect') {
        return async () => {
          const client = await target.connect()
          try {
            await hooks.onConnect?.(++connections)
          } catch (error) {
            client.release()
            throw error
          }
          return new Proxy(client, {
            get(connection, key) {
              if (key === 'query') {
                return (...args: unknown[]) => {
                  hooks.beforeQuery?.(String(args[0]))
                  return Reflect.apply(connection.query, connection, args)
                }
              }
              const value = Reflect.get(connection, key)
              return typeof value === 'function' ? value.bind(connection) : value
            }
          })
        }
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}
