// One isolated PG callback; synthetic controller identities only, no provider/native calls.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { writeFile } from 'node:fs/promises'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { createDurablePool, DurableDatabaseError } from '../db/connection.ts'
import { LockedGatewayAuthority } from '../runtime/gateway/authority.ts'
import { originalIdentity, takeOverCommand } from '../runtime/gateway/store.ts'
import type { GatewayContext, CommandRow } from '../runtime/gateway/types.ts'
import { executionFixture, stage, dispatch, submitDispatch, claim, inExecution } from './execution-fixtures.mts'
import type { ExecutionFixture } from './execution-fixtures.mts'
import { instrumentPool } from './verification-fixtures.mts'
import { reconcileInputAfterOwnerLoss } from './owner-loss.ts'
import type { InputOwnerLossRequest } from './owner-loss-types.ts'

const database = 'orca_unhandled_wake_expiry_20261016'
const evidenceRoot = process.env.ORCA_INPUT_OWNER_LOSS_EVIDENCE_ROOT
if (process.env.ORCA_INPUT_OWNER_LOSS_APPROVED !== 'root-first-verification' ||
    process.env.PGDATABASE !== database || !evidenceRoot) { throw new Error('OWNER_LOSS_APPROVED_DB_REQUIRED') }

async function commandRow(pool: Pool, f: ExecutionFixture) {
  return (await pool.query<CommandRow>("SELECT * FROM durable_runtime.runtime_commands WHERE operation_id=$1 AND command_name='dispatchInput'", [f.context.operationId])).rows[0]
}
async function moveLease(pool: Pool, f: ExecutionFixture, term: string): Promise<GatewayContext> {
  const controller = { ...f.context.controller, owner: `owner-loss:${randomUUID()}`, term: counter('controller-term', term) }
  // Only the new fixture's private synthetic scope; never the normal controller lease.
  await pool.query('UPDATE durable_runtime.controller_leases SET owner=$2,term=$3,revision=revision+1 WHERE scope=$1',
    [controller.scope, controller.owner, controller.term])
  return { ...f.context, controller }
}
async function seed(pool: Pool, executionTerm = '1') {
  const f = await executionFixture(pool)
  await pool.query("UPDATE durable_runtime.operations SET kind='INPUT_DELIVERY' WHERE id=$1", [f.context.operationId])
  const staged = await stage(pool, f), request = dispatch(f, staged.deliveryId)
  assert.equal((await submitDispatch(pool, f, request)).disposition, 'ACCEPTED')
  if (executionTerm !== '1') {
    f.context = await moveLease(pool, f, executionTerm)
    await pool.query('UPDATE durable_runtime.operations SET controller_term=$2 WHERE id=$1', [f.context.operationId, executionTerm])
    await inExecution(pool, f, async tx => {
      const authority = await LockedGatewayAuthority.acquire(tx, f.context), row = await commandRow(pool, f)
      await takeOverCommand(authority, originalIdentity(row))
    })
  }
  const claimed = await claim(pool, f, request)
  assert.equal(claimed.disposition, 'CLAIMED')
  const row = await commandRow(pool, f)
  assert.ok(row.execution_token)
  return { f, row, request: { context: f.context, commandId: row.id, executionToken: row.execution_token,
    messageId: f.messageId, deliveryAttemptId: staged.deliveryId } satisfies InputOwnerLossRequest }
}
async function snapshot(pool: Pool, fixtures: readonly ExecutionFixture[]) {
  const sessions = fixtures.map(f => f.authority.sessionId), units = fixtures.map(f => f.context.runtimeUnitId)
  return (await pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.runtime_units r WHERE id=ANY($2::uuid[])) AS units,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.operations r WHERE runtime_unit_id=ANY($2::uuid[])) AS operations,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.attempts r WHERE runtime_unit_id=ANY($2::uuid[])) AS attempts,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.execution_grants r WHERE runtime_unit_id=ANY($2::uuid[])) AS grants,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.scope) FROM durable_runtime.controller_leases r WHERE scope=ANY($3::text[])) AS leases,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.runtime_commands r WHERE runtime_unit_id=ANY($2::uuid[])) AS commands,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.runtime_command_history r WHERE command_id IN
      (SELECT id FROM durable_runtime.runtime_commands WHERE runtime_unit_id=ANY($2::uuid[]))) AS history,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.messages r WHERE session_id=ANY($1::uuid[])) AS messages,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.delivery_attempts r WHERE session_id=ANY($1::uuid[])) AS deliveries,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.input_components r WHERE session_id=ANY($1::uuid[])) AS components,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.session_context_records r WHERE session_id=ANY($1::uuid[])) AS contexts,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.event_id) FROM durable_runtime.session_events r WHERE session_id=ANY($1::uuid[])) AS journal,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.runtime_audit_events r WHERE session_id=ANY($1::uuid[])) AS audit,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.outbox_events r WHERE aggregate_id=ANY($2::uuid[])
      OR aggregate_id IN (SELECT id FROM durable_runtime.messages WHERE session_id=ANY($1::uuid[]))) AS outbox,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.principal_id,r.session_scope,r.method,r.operation_key)
      FROM durable_runtime.rpc_receipts r WHERE principal_id=ANY($4::text[])) AS receipts`,
    [sessions, units, fixtures.map(f => f.context.controller.scope), fixtures.map(f => f.authority.principal)])).rows[0]
}

test('owner loss records only original input UNKNOWN atomically without a new execution claim', async t => {
  const pool = createDurablePool({ database, max: 4, application_name: 'input-owner-loss-first' })
  t.after(() => pool.end())
  const identity = (await pool.query(`SELECT current_database() AS database,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system,pg_backend_pid() AS backend_pid,clock_timestamp() AS at`)).rows[0]
  assert.equal(identity.database, database); assert.equal(identity.oid, '96658'); assert.equal(identity.system, '7696101282789175327')
  assert.deepEqual((await pool.query('SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows, [{ dataset_name: 'orca-1012-dev-v1' }])
  await writeFile(`${evidenceRoot}/fixture-identity.json`, `${JSON.stringify(identity)}\n`, { flag: 'wx', mode: 0o600 })
  const ledger = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length, 23)
  const first = await seed(pool, '2'), { f } = first, cases: string[] = []
  // Original accept term 1 differs from actual execution history term 2.
  assert.equal(first.row.original_controller_term, '1')
  const beforeSame = await snapshot(pool, [f])
  const same = await reconcileInputAfterOwnerLoss(pool, first.request)
  assert.equal(same.ok, false); if (!same.ok) { assert.equal(same.error.code, 'INPUT_OWNER_LOSS_EXECUTION_HISTORY') }
  assert.deepEqual(await snapshot(pool, [f]), beforeSame); cases.push('CURRENT_EXECUTION_TERM_REJECTED')
  const context = await moveLease(pool, f, '3'), request = { ...first.request, context }
  for (const wrong of [{ ...request, executionToken: logicalId('runtime-command-execution', randomUUID()) },
    { ...request, deliveryAttemptId: logicalId('delivery-attempt', randomUUID()) }]) {
    const before = await snapshot(pool, [f]), outcome = await reconcileInputAfterOwnerLoss(pool, wrong)
    assert.equal(outcome.ok, false); assert.deepEqual(await snapshot(pool, [f]), before)
  }
  cases.push('WRONG_TOKEN_AND_DELIVERY_REJECTED')
  // Generic gateway adoption may already have changed owner_controller_term.
  await inExecution(pool, f, async tx => {
    const authority = await LockedGatewayAuthority.acquire(tx, context)
    await takeOverCommand(authority, originalIdentity(first.row))
  })
  const stable = await snapshot(pool, [f])
  for (const sql of ['INSERT INTO durable_runtime.session_events', 'INSERT INTO durable_runtime.outbox_events']) {
    const broken = instrumentPool(pool, { beforeQuery: query => {
      if (query.includes(sql)) { throw new DurableDatabaseError('OWNER_LOSS_SYNTHETIC_WRITE_FAILURE') }
    } })
    const rolled = await reconcileInputAfterOwnerLoss(broken, request)
    assert.equal(rolled.ok, false); assert.equal(rolled.settlement, 'ROLLED_BACK')
    assert.deepEqual(await snapshot(pool, [f]), stable, 'journal/outbox failure rolls back command and both input rows')
  }
  cases.push('JOURNAL_AND_OUTBOX_FAILURE_ROLLBACK')
  const recovered = await reconcileInputAfterOwnerLoss(pool, request)
  assert.ok(recovered.ok); assert.equal(recovered.commitOutcome, 'ACKNOWLEDGED')
  assert.equal(recovered.value.disposition, 'UNKNOWN_RECORDED'); assert.ok(recovered.value.eventId)
  assert.ok(!('claim' in recovered.value) && !('proof' in recovered.value))
  const after = await snapshot(pool, [f])
  for (const key of ['units', 'operations', 'attempts', 'grants', 'leases', 'components', 'receipts']) {
    assert.deepEqual(after[key], stable[key], `${key} must remain unchanged`)
  }
  const row = await commandRow(pool, f)
  assert.equal(row.state, 'UNKNOWN'); assert.equal(row.execution_token, first.row.execution_token)
  assert.equal(row.executor_id, first.row.executor_id); assert.equal(row.original_controller_term, '1')
  assert.deepEqual(row.input, first.row.input)
  assert.equal(after.messages[0].intake_status, 'UNKNOWN'); assert.equal(after.deliveries[0].state, 'UNKNOWN')
  assert.equal(after.journal.filter((e: { body: { reasonCode?: string } }) => e.body.reasonCode === 'INPUT_OWNER_LOST').length, 1)
  assert.equal(after.contexts.length, (stable.contexts?.length ?? 0) + 1)
  for (const originalContext of stable.contexts ?? []) { assert.deepEqual(after.contexts.find((r: { id: string }) => r.id === originalContext.id), originalContext) }
  const duplicate = await reconcileInputAfterOwnerLoss(pool, request)
  assert.ok(duplicate.ok); assert.equal(duplicate.value.disposition, 'ALREADY_UNKNOWN')
  assert.deepEqual(await snapshot(pool, [f]), after); cases.push('OLDER_HISTORY_RECOVERED_AND_DUPLICATE_NO_WRITE')

  for (const state of ['ADMITTED', 'SETTLED', 'INTERRUPTED', 'CANCELLED', 'CLOSED']) {
    const terminal = await seed(pool), id = terminal.request.deliveryAttemptId
    if (state === 'CLOSED') { await pool.query("UPDATE durable_runtime.sessions SET lifecycle='CLOSING' WHERE id=$1", [terminal.f.authority.sessionId]) }
    else {
      // Explicit fixture-only terminal state; no provider proof is created.
      await pool.query(`UPDATE durable_runtime.delivery_attempts SET state=$2,
        provider_ref=CASE WHEN $2 IN ('ADMITTED','SETTLED') THEN 'synthetic-final-provider' ELSE NULL END,
        admitted_at=CASE WHEN $2 IN ('ADMITTED','SETTLED') THEN clock_timestamp() ELSE NULL END,
        completed_at=CASE WHEN $2='SETTLED' THEN clock_timestamp() ELSE NULL END WHERE id=$1`, [id, state])
      await pool.query('UPDATE durable_runtime.messages SET intake_status=$2 WHERE id=$1', [terminal.f.messageId, state])
    }
    const terminalContext = await moveLease(pool, terminal.f, '2'), before = await snapshot(pool, [terminal.f])
    const noChange = await reconcileInputAfterOwnerLoss(pool, { ...terminal.request, context: terminalContext })
    assert.ok(noChange.ok); assert.equal(noChange.value.disposition, 'NOT_APPLICABLE')
    assert.deepEqual(await snapshot(pool, [terminal.f]), before)
  }
  cases.push('FINAL_AND_CLOSING_INPUTS_PRESERVED')
  const ambiguous = await seed(pool), newer = await moveLease(pool, ambiguous.f, '3')
  await pool.query(`INSERT INTO durable_runtime.runtime_command_history(id,command_id,stage,controller_term,executor_id,execution_token)
    VALUES($1,$2,'EXECUTING',4,$3,$4)`, [randomUUID(), ambiguous.row.id, ambiguous.row.executor_id, ambiguous.row.execution_token])
  const beforeAmbiguous = await snapshot(pool, [ambiguous.f])
  const badHistory = await reconcileInputAfterOwnerLoss(pool, { ...ambiguous.request, context: newer })
  assert.equal(badHistory.ok, false); assert.deepEqual(await snapshot(pool, [ambiguous.f]), beforeAmbiguous)
  cases.push('AMBIGUOUS_FUTURE_HISTORY_REJECTED')
  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  await writeFile(`${evidenceRoot}/fixture-result.json`, `${JSON.stringify({ cases, nativeCalls: 0, newExecutionClaims: 0,
    ledger23Unchanged: true, syntheticAuthorityOnly: true })}\n`, { flag: 'wx', mode: 0o600 })
  for (const name of cases) { t.diagnostic(name) }
})
