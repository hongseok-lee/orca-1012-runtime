import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, withDurableTransaction } from '../db/connection.ts'
import { LockedGatewayAuthority } from '../runtime/gateway/authority.ts'
import { submitCommand, originalIdentity } from '../runtime/gateway/store.ts'
import { claimCommand, markCommandUnknown } from '../runtime/gateway/claim.ts'
import { inputDigest } from '../runtime/gateway/input.ts'
import type { VerifiedControllerIdentity } from '../runtime/gateway/types.ts'
import type { PayloadHash } from '../runtime/runtime-evidence.ts'
import { expireInitialWake, prepareReconcileStep } from './controller.ts'
import type { InitialWakeExpiryRequest } from './controller.ts'
import { requestUnitIntent } from './intent.ts'
import { lockUnitMembers } from './locks.ts'
import { executor, fixture, intent, stoppedMetadataAttempt } from './verification-fixtures.mts'

// Backend's parent fixture owns the actual Session acquire/assertCurrent/release
// and Pool. This module registers no top-level test and issues no nominal identity.
export type InitialWakeExpiryDatabaseIdentity = Readonly<{ database: string; oid: string; system: string }>
export async function runInitialWakeExpiryCases(t: TestContext, pool: Pool,
  controller: VerifiedControllerIdentity, actualExpectedDatabaseIdentity: InitialWakeExpiryDatabaseIdentity): Promise<void> {
  const expected = Object.freeze({ ...actualExpectedDatabaseIdentity })
  if (expected.database !== 'orca_unhandled_wake_expiry_20261016' || expected.system !== '7696101282789175327' ||
      typeof expected.oid !== 'string' || !/^[1-9][0-9]*$/u.test(expected.oid) || ['16384','92238'].includes(expected.oid)) {
    throw new Error('Root-assigned new isolated database OID required')
  }
  const owner = controller.owner, term = controller.term
  const fail = (code: string) => (error: unknown) => error instanceof DurableDatabaseError && error.code === code
  async function seed(desired: 'RUNNING' | 'DELETED' = 'RUNNING') {
    const f = await fixture(pool, 1)
    assert.equal((await requestUnitIntent(pool, await intent(pool, f, desired))).status, 'COMMITTED')
    const op = (await pool.query('SELECT id FROM durable_runtime.operations WHERE runtime_unit_id=$1', [f.unit])).rows[0]
    return { ...f, context: { runtimeUnitId: f.unit, operationId: logicalId('operation', op.id), controller } }
  }
  type Seed = Awaited<ReturnType<typeof seed>>
  async function oldTerm(f: Seed) {
    assert.ok(BigInt(term) > 0n)
    // Additive synthetic stale-term operation only; actual parent lease is untouched.
    await pool.query('UPDATE durable_runtime.operations SET controller_term=$2 WHERE id=$1', [f.context.operationId, String(BigInt(term) - 1n)])
  }
  async function expired(f: Seed) {
    // Only this fixture's newly inserted operation is seeded with a past deadline.
    await pool.query(`UPDATE durable_runtime.operations SET deadline_at=clock_timestamp()-interval '1 minute',
      retry_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [f.context.operationId])
  }
  async function request(f: Seed): Promise<InitialWakeExpiryRequest> {
    const row = (await pool.query(`SELECT u.revision,u.intent_revision,o.step_revision
      FROM durable_runtime.runtime_units u JOIN durable_runtime.operations o ON o.runtime_unit_id=u.id
      WHERE u.id=$1 AND o.id=$2`, [f.unit, f.context.operationId])).rows[0]
    return { context: f.context, mutationKey: randomUUID(), expectedUnitRevision: counter('row:runtime-unit', row.revision),
      expectedIntentRevision: counter('intent-revision', row.intent_revision), expectedStepRevision: counter('step-revision', row.step_revision) }
  }
  async function snapshot(f: Seed) {
    const result: Record<string, unknown> = {}
    const scopes = {
      runtime_units: ['id=$1', [f.unit]], operations: ['id=$1', [f.context.operationId]],
      runtime_commands: ['runtime_unit_id=$1', [f.unit]], agent_pod_plans: ['runtime_unit_id=$1', [f.unit]],
      attempts: ['runtime_unit_id=$1', [f.unit]], execution_grants: ['runtime_unit_id=$1', [f.unit]],
      resource_profiles: ['runtime_unit_id=$1', [f.unit]], storage_write_grants: ['storage_binding_id=$1', [f.binding]],
      storage_bindings: ['id=$1', [f.binding]], sessions: ['id=ANY($1::uuid[])', [f.sessions]],
      runtime_audit_events: ['runtime_unit_id=$1', [f.unit]],
      outbox_events: ['aggregate_id=ANY($1::uuid[])', [[f.unit, ...f.sessions, f.context.operationId]]]
    } as const
    for (const [table, [where, values]] of Object.entries(scopes)) {
      result[table] = (await pool.query(`SELECT to_jsonb(t)::text AS body FROM durable_runtime.${table} t WHERE ${where} ORDER BY body`, [...values])).rows
    }
    return result
  }
  async function fixed(f: Seed) {
    return (await pool.query(`SELECT id,runtime_unit_id,kind,intent_revision,execution_epoch,expected_pod_uid,
      external_resource_name,deadline_at::text,retry_at::text FROM durable_runtime.operations WHERE id=$1`, [f.context.operationId])).rows[0]
  }
  async function counts(f: Seed) {
    return (await pool.query(`SELECT
      (SELECT count(*)::text FROM durable_runtime.runtime_audit_events WHERE operation_id=$1 AND kind='RECONCILE_OPERATION_DEADLINE_EXPIRED') AS audit,
      (SELECT count(*)::text FROM durable_runtime.outbox_events WHERE aggregate_id=$2 AND event->>'kind'='RECONCILE_OPERATION_DEADLINE_EXPIRED') AS outbox,
      (SELECT count(*)::text FROM durable_runtime.rpc_receipts WHERE session_scope=$3 AND method='lifecycle.expire-initial-wake') AS expiry_receipts`,
    [f.context.operationId, f.unit, `runtime-unit:${f.unit}`])).rows[0]
  }
  function borrowed(beforeQuery: (sql: string) => void, replace: (sql: string) => string = sql => sql): Pool {
    // Reviewed actual-client proxy convention: retain receiver/transaction scope.
    return new Proxy(pool, { get(target, key) {
      if (key === 'connect') {
        return async () => {
          const client = await target.connect()
          return new Proxy(client, { get(connection, field) {
            if (field === 'query') {
              return (sql: string, values: readonly unknown[] = []) => {
                beforeQuery(sql)
                const next = replace(sql)
                return connection.query(next, next === sql ? [...values] : [])
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
  }

  const actual = await withDurableTransaction(pool, async tx => {
    const row = (await tx.query(`SELECT current_database() AS database,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
      (SELECT system_identifier::text FROM pg_control_system()) AS system,pg_backend_pid() AS backend_pid`)).rows[0]
    assert.equal(row.database, expected.database); assert.equal(row.oid, expected.oid); assert.equal(row.system, expected.system)
    assert.deepEqual((await tx.query('SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows, [{ dataset_name: 'orca-1012-dev-v1' }])
    assert.equal((await tx.query(`SELECT scope FROM durable_runtime.controller_leases WHERE scope=$1 AND owner=$2
      AND term=$3 AND expires_at>clock_timestamp()`, [controller.scope, owner, term])).rowCount, 1)
    return row
  })
  t.diagnostic(`isolated identity ${JSON.stringify(actual)}`)
  const ledger = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length, 23)
  const lease = (await pool.query('SELECT to_jsonb(c) AS body FROM durable_runtime.controller_leases c WHERE scope=$1', [controller.scope])).rows
  for (const entry of ['expiry-only','existing-step'] as const) {
    await t.test(`${entry} shares initial expiry for an already BLOCKED Unit and retains its original tuple`, async () => {
      const f = await seed()
      await pool.query("UPDATE durable_runtime.runtime_units SET phase='BLOCKED',revision=revision+1 WHERE id=$1", [f.unit])
      await expired(f)
      await oldTerm(f)
      const original = await fixed(f), before = await snapshot(f), input = await request(f)
      const outcome = entry === 'expiry-only' ? await expireInitialWake(pool, input) : await prepareReconcileStep(pool, {
        ...input, step: 'ENSURE_ATTEMPT', executorId: executor, input: {} })
      assert.equal(outcome.mutation.status, 'COMMITTED')
      if ('reason' in outcome) { assert.deepEqual(Object.keys(outcome).sort(), ['mutation','reason']); assert.equal(outcome.reason, 'DEADLINE_EXPIRED') }
      else { assert.deepEqual(outcome.execution, { disposition: 'NO_EXECUTION', reason: 'DEADLINE_EXPIRED' }) }
      assert.deepEqual((await pool.query('SELECT step,result FROM durable_runtime.operations WHERE id=$1', [f.context.operationId])).rows[0],
        { step: 'FAILED', result: { state: 'FAILED', reason: 'DEADLINE_EXPIRED_BEFORE_ACCEPTANCE' } })
      assert.equal((await pool.query('SELECT phase,revision FROM durable_runtime.runtime_units WHERE id=$1', [f.unit])).rows[0].revision,
        String(BigInt(input.expectedUnitRevision) + 1n))
      assert.deepEqual(await fixed(f), original)
      const after = await snapshot(f)
      for (const table of ['runtime_commands','agent_pod_plans','attempts','execution_grants','resource_profiles',
        'storage_write_grants','storage_bindings','sessions']) { assert.deepEqual(after[table], before[table]) }
      if (entry === 'expiry-only') {
        assert.deepEqual(await counts(f), { audit: '1', outbox: '1', expiry_receipts: '1' })
        const replay = await expireInitialWake(pool, input)
        assert.equal(replay.mutation.status, 'REPLAYED'); assert.equal(replay.reason, 'RECEIPT_REPLAY')
        const repeated = await expireInitialWake(pool, await request(f))
        assert.equal(repeated.reason, 'DEADLINE_EXPIRED'); assert.deepEqual(Object.keys(repeated).sort(), ['mutation','reason'])
        assert.deepEqual(await snapshot(f), after); assert.deepEqual(await counts(f), { audit: '1', outbox: '1', expiry_receipts: '2' })
      }
    })
  }
  for (const boundary of ['future-recheck','null-deadline','other-kind','other-step'] as const) {
    await t.test(`${boundary} cannot terminalize or issue any execution claim`, async () => {
      const f = await seed(boundary === 'other-kind' ? 'DELETED' : 'RUNNING')
      await expired(f)
      if (boundary === 'future-recheck') {
        assert.equal((await pool.query('SELECT deadline_at<=clock_timestamp() AS expired FROM durable_runtime.operations WHERE id=$1', [f.context.operationId])).rows[0].expired, true)
        // A conflicting synthetic seed replaces this new row's candidate view;
        // no real operation deadline is extended or used as authorization input.
        await pool.query("UPDATE durable_runtime.operations SET deadline_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [f.context.operationId])
      }
      if (boundary === 'null-deadline') { await pool.query('UPDATE durable_runtime.operations SET deadline_at=NULL WHERE id=$1', [f.context.operationId]) }
      if (boundary === 'other-step') { await pool.query("UPDATE durable_runtime.operations SET step='ENSURE_ATTEMPT',step_revision=1 WHERE id=$1", [f.context.operationId]) }
      await oldTerm(f)
      const before = await snapshot(f), outcome = await expireInitialWake(pool, await request(f))
      assert.deepEqual(Object.keys(outcome).sort(), ['mutation','reason'])
      assert.equal(outcome.reason, boundary === 'other-kind' || boundary === 'other-step' ? 'DEADLINE_EXPIRED' : 'DEADLINE_NOT_EXPIRED')
      assert.deepEqual(await snapshot(f), before); assert.deepEqual(await counts(f), { audit: '0', outbox: '0', expiry_receipts: '1' })
    })
  }
  await t.test('UNKNOWN command retains original token and wins before stale requested revision', async () => {
    const f = await seed()
    await withDurableTransaction(pool, async tx => {
      await lockUnitMembers(tx, f.unit, f.sessions)
      const authority = await LockedGatewayAuthority.acquire(tx, f.context)
      const submitted = await submitCommand(authority, { command: 'ensureAttempt', envelope: { operationId: f.context.operationId,
        controllerTerm: controller.term, stepRevision: counter('step-revision', '0'), executionEpoch: counter('execution-epoch', '0'),
        intentRevision: counter('intent-revision', '0'), podTarget: 'CREATE_WITHOUT_POD', expectedPodUid: null },
        input: {}, inputHash: inputDigest({}) as PayloadHash, predecessor: { kind: 'NONE' } })
      const claimed = await claimCommand(authority, originalIdentity(submitted.command), executor)
      assert.equal(claimed.disposition, 'CLAIMED')
      if (claimed.disposition === 'CLAIMED') { await markCommandUnknown(authority, claimed.claim) }
    })
    await expired(f); await oldTerm(f)
    const before = await snapshot(f), input = await request(f)
    const outcome = await expireInitialWake(pool, { ...input, expectedUnitRevision: counter('row:runtime-unit', '0') })
    assert.deepEqual(Object.keys(outcome).sort(), ['mutation','reason']); assert.equal(outcome.reason, 'LOOKUP_ORIGINAL')
    assert.deepEqual(await snapshot(f), before); assert.deepEqual(await counts(f), { audit: '0', outbox: '0', expiry_receipts: '1' })
  })
  await t.test('a retained stopped attempt blocks the shared expiry guard without physical inference', async () => {
    const f = await seed(); await stoppedMetadataAttempt(pool, f, false); await expired(f); await oldTerm(f)
    const before = await snapshot(f), outcome = await expireInitialWake(pool, await request(f))
    assert.equal(outcome.reason, 'DEADLINE_EXPIRED'); assert.deepEqual(await snapshot(f), before)
    assert.deepEqual(await counts(f), { audit: '0', outbox: '0', expiry_receipts: '1' })
  })
  await t.test('stale lease/CAS and receipt SQL failure preserve the whole original mutation', async () => {
    const f = await seed(); await expired(f)
    const before = await snapshot(f), input = await request(f)
    await assert.rejects(expireInitialWake(pool, { ...input, context: { ...input.context,
      controller: { ...controller, owner: `${owner}-stale` } } }), fail('COMMAND_AUTHORITY_STALE'))
    await assert.rejects(expireInitialWake(pool, { ...input, expectedUnitRevision: counter('row:runtime-unit', '0') }), fail('LIFECYCLE_STEP_STALE'))
    const failing = borrowed(() => {}, sql => sql.includes('INSERT INTO durable_runtime.rpc_receipts') ? 'SELECT 1/0' : sql)
    await assert.rejects(expireInitialWake(failing, input), fail('22012'))
    assert.deepEqual(await snapshot(f), before); assert.deepEqual(await counts(f), { audit: '0', outbox: '0', expiry_receipts: '0' })
  })
  await t.test('request/context are captured before the first borrowed query awaits', async () => {
    const f = await seed(); await expired(f)
    const mutable = { ...await request(f) }, originalKey = mutable.mutationKey
    let changed = false
    const borrowedPool = borrowed(() => {
      if (changed) { return }
      changed = true; mutable.mutationKey = randomUUID(); mutable.expectedUnitRevision = counter('row:runtime-unit', '999')
      mutable.context = { ...mutable.context, controller: { ...controller, owner: `${owner}-changed` } }
    })
    const outcome = await expireInitialWake(borrowedPool, mutable)
    assert.equal(changed, true); assert.equal(outcome.reason, 'DEADLINE_EXPIRED')
    assert.equal(outcome.mutation.status, 'COMMITTED'); assert.deepEqual(Object.keys(outcome).sort(), ['mutation','reason'])
    assert.equal(outcome.mutation.receipt.key.operationKey, originalKey)
  })
  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  assert.deepEqual((await pool.query('SELECT to_jsonb(c) AS body FROM durable_runtime.controller_leases c WHERE scope=$1', [controller.scope])).rows, lease)
}
