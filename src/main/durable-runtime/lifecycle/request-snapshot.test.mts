import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { inputPayloadHash } from '../input/canonical.ts'
import { requestUnitIntent, recordUnitIntent } from './intent.ts'
import type { UnitIntentRequest, UnitIntentAuthority } from './types.ts'

// Isolated actual-PG case, queued for the first permitted P1-13 run. Fixtures
// supply test authority only; they are not workload authentication evidence.
const database = process.env.PGDATABASE ?? ''
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function pausedPool(pool: Pool, match: (sql: string) => boolean) {
  const entered = deferred(), resume = deferred()
  let used = false
  const wrapper = new Proxy(pool, { get(target, key) {
    if (key === 'connect') {
      return async () => {
        const client = await target.connect()
        return new Proxy(client, { get(connection, field) {
          if (field === 'query') {
            return async (sql: string, values: readonly unknown[] = []) => {
              if (!used && match(sql)) { used = true; entered.resolve(); await resume.promise }
              return connection.query(sql, [...values])
            }
          }
          const value = Reflect.get(connection, field)
          return typeof value === 'function' ? value.bind(connection) : value
        } })
      }
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return { pool: wrapper, entered: entered.promise, release: resume.resolve }
}
function request(unit: string): UnitIntentRequest {
  const authority = { principalId: 'lifecycle-fixture-principal', runtimeUnitId: logicalId('runtime-unit', unit),
    scope: `lifecycle-fixture:${unit}` } as UnitIntentAuthority
  return { authority, operationKey: randomUUID(), desired: 'RUNNING', expectedRevision: counter('row:runtime-unit', '0'),
    expectedIntentRevision: counter('intent-revision', '0'), policy: { operationDeadlineMs: 60000, idleDurationMs: null } }
}
function mutateCaller(input: UnitIntentRequest) {
  const caller = input as unknown as { desired: string; operationKey: string;
    authority: { principalId: string; runtimeUnitId: string; scope: string };
    policy: { operationDeadlineMs: number; idleDurationMs: number | null } }
  caller.desired = 'DELETED'
  caller.operationKey = 'changed-after-await'
  caller.authority.principalId = 'changed-fixture-principal'
  caller.authority.runtimeUnitId = randomUUID()
  caller.authority.scope = 'changed-fixture-scope'
  caller.policy.operationDeadlineMs = 1
  caller.policy.idleDurationMs = 1
}

test('caller mutation while awaiting PG cannot diverge lifecycle receipt/effect or Catalog transaction input',
  { skip: !database.startsWith('orca_p113_') }, async () => {
    assert.match(database, /^orca_p113_[a-z0-9_]+$/)
    const pool = createDurablePool({ database })
    try {
      const unit = randomUUID()
      await pool.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'SUSPENDED','SUSPENDED')", [unit])
      const original = request(unit)
      const captured = { key: original.operationKey, principal: original.authority.principalId, scope: original.authority.scope }
      const expectedHash = inputPayloadHash([unit, captured.scope, 'RUNNING', '0', '0', 60000, null])
      const gate = pausedPool(pool, sql => sql.includes('SELECT session_id FROM durable_runtime.runtime_members'))
      const pending = requestUnitIntent(gate.pool, original)
      await gate.entered
      mutateCaller(original)
      gate.release()
      const outcome = await pending
      assert.equal(outcome.status, 'COMMITTED')
      const saved = await pool.query(`SELECT response,payload_hash FROM durable_runtime.rpc_receipts
        WHERE principal_id=$1 AND session_scope=$2 AND operation_key=$3`, [captured.principal, captured.scope, captured.key])
      assert.equal(saved.rowCount, 1)
      assert.equal(saved.rows[0].payload_hash, expectedHash)
      assert.equal(saved.rows[0].response.desired, 'RUNNING')
      const operation = await pool.query(`SELECT kind,deadline_at>clock_timestamp()+interval '1 second' AS original_deadline
        FROM durable_runtime.operations WHERE runtime_unit_id=$1`, [unit])
      assert.equal(operation.rows[0].kind, 'WAKE')
      assert.equal(operation.rows[0].original_deadline, true)

      const catalogUnit = randomUUID()
      await pool.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'SUSPENDED','SUSPENDED')", [catalogUnit])
      const direct = request(catalogUnit)
      const second = pausedPool(pool, sql => sql.includes('FOR UPDATE'))
      const transaction = withDurableTransaction(second.pool, tx => recordUnitIntent(tx, direct, []))
      await second.entered
      mutateCaller(direct)
      second.release()
      const recorded = await transaction
      assert.equal(recorded.runtimeUnitId, catalogUnit)
      assert.equal(recorded.desired, 'RUNNING')
      const state = await pool.query('SELECT desired_mode FROM durable_runtime.runtime_units WHERE id=$1', [catalogUnit])
      assert.equal(state.rows[0].desired_mode, 'RUNNING')
    } finally { await pool.end() }
  })
