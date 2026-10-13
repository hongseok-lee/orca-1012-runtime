import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { withDurableTransaction, DurableDatabaseError } from '../db/connection.ts'
import { acceptInput } from '../input/intake.ts'
import type { InputRequest } from '../input/types.ts'
import { requestUnitIntent } from './intent.ts'
import { reserveSleep } from './sleep.ts'
import { joinPendingUnitIntent } from './pending.ts'
import { prepareReconcileStep } from './controller.ts'
import { recordReconcileObservation } from './observation.ts'
import { readUnitProjection } from './projection.ts'
import { listDueReconciliations } from './due.ts'
import { activity, controller, executor, fixture, intent, ownPool, policy, stoppedMetadataAttempt } from './verification-fixtures.mts'

const enabled = (process.env.PGDATABASE ?? '').startsWith('orca_p113_')
function failure(code: string) {
  return (error: unknown) => error instanceof DurableDatabaseError && error.code === code
}
function input(f: Awaited<ReturnType<typeof fixture>>, member = 0): InputRequest {
  return { authority: { principal: 'lifecycle-fixture-input' as InputRequest['authority']['principal'],
    sessionId: f.sessions[member], scope: { kind: 'SESSION' } }, method: 'fixture.accept-input',
    operationKey: randomUUID(), inputKind: 'GENERAL', sessionFence: counter('session-fence', '0'),
    payload: { text: 'independent lifecycle fixture input' }, attachments: [] }
}

test('concurrent compatible wake contenders and a revision-refresh share one original operation/name/deadline', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool)
    const requests = [await intent(pool, f), await intent(pool, f)]
    const outcomes = await Promise.allSettled(requests.map(request => requestUnitIntent(pool, request)))
    assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1)
    assert.equal(outcomes.filter(x => x.status === 'rejected' && failure('LIFECYCLE_STALE_REVISION')(x.reason)).length, 1)
    const first = await pool.query('SELECT id,external_resource_name,deadline_at,intent_revision FROM durable_runtime.operations WHERE runtime_unit_id=$1', [f.unit])
    await requestUnitIntent(pool, await intent(pool, f))
    const after = await pool.query('SELECT id,external_resource_name,deadline_at,intent_revision FROM durable_runtime.operations WHERE runtime_unit_id=$1', [f.unit])
    assert.equal(first.rowCount, 1); assert.deepEqual(after.rows, first.rows)
    assert.equal(after.rows[0].intent_revision, '0')
    assert.equal((await pool.query('SELECT id FROM durable_runtime.attempts WHERE runtime_unit_id=$1', [f.unit])).rowCount, 0)
    // Exact expected Unit revision is checked for each new request. The stale
    // concurrent contender is not reported as a second concurrently accepted ACK.
  } finally { await pool.end() }
})

test('receipt-first lifecycle replay after deletion cannot resurrect Unit or rewrite the stored response', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool)
    const running = await intent(pool, f)
    const first = await requestUnitIntent(pool, running)
    await requestUnitIntent(pool, await intent(pool, f, 'DELETED'))
    const replay = await requestUnitIntent(pool, running)
    assert.equal(replay.status, 'REPLAYED')
    if (first.status !== 'UNCERTAIN' && replay.status !== 'UNCERTAIN') { assert.deepEqual(replay.receipt.response, first.receipt.response) }
    assert.equal((await pool.query('SELECT desired_mode FROM durable_runtime.runtime_units WHERE id=$1', [f.unit])).rows[0].desired_mode, 'DELETED')
  } finally { await pool.end() }
})

test('sleep then real P1-05 input invalidates the old barrier once and later inputs share current wake', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool)
    const reserved = await withDurableTransaction(pool, tx => reserveSleep(tx, { unitId: f.unit, actorId: 'fixture-catalog',
      discoveredMembers: f.sessions, expectedRevision: counter('row:runtime-unit', '0'), expectedIntentRevision: counter('intent-revision', '0'),
      policy, activityFreshnessMs: 60000, activity: null }))
    assert.equal(reserved.status, 'RESERVED')
    const accepted = await acceptInput(pool, input(f))
    assert.equal(accepted.status, 'COMMITTED')
    await acceptInput(pool, input(f, 1))
    const unit = (await pool.query('SELECT * FROM durable_runtime.runtime_units WHERE id=$1', [f.unit])).rows[0]
    assert.equal(unit.desired_mode, 'RUNNING'); assert.equal(unit.intent_revision, '2')
    const first = await withDurableTransaction(pool, tx => joinPendingUnitIntent(tx, { unitId: f.unit,
      actorId: 'fixture-reconciler', discoveredMembers: f.sessions, policy }))
    const second = await withDurableTransaction(pool, tx => joinPendingUnitIntent(tx, { unitId: f.unit,
      actorId: 'fixture-reconciler', discoveredMembers: f.sessions, policy }))
    assert.ok(first && second); assert.equal(first.operation.id, second.operation.id)
    const operations = await pool.query('SELECT kind,step,result FROM durable_runtime.operations WHERE runtime_unit_id=$1', [f.unit])
    assert.equal(operations.rows.filter(row => row.kind === 'WAKE').length, 1)
    assert.equal(operations.rows.find(row => row.kind === 'SLEEP')?.step, 'CANCELLED')
    assert.equal((await pool.query('SELECT id FROM durable_runtime.input_components WHERE session_id=ANY($1::uuid[])', [f.sessions])).rowCount, 2)
  } finally { await pool.end() }
})

test('real input before sleep and either close order preserve accepted input without reopening a closed member', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool)
    await acceptInput(pool, input(f))
    const row = (await pool.query('SELECT revision,intent_revision FROM durable_runtime.runtime_units WHERE id=$1', [f.unit])).rows[0]
    const sleeping = await withDurableTransaction(pool, tx => reserveSleep(tx, { unitId: f.unit, actorId: 'fixture-catalog',
      discoveredMembers: f.sessions, expectedRevision: counter('row:runtime-unit', row.revision),
      expectedIntentRevision: counter('intent-revision', row.intent_revision), policy, activityFreshnessMs: 60000, activity: null }))
    assert.deepEqual(sleeping, { status: 'DEFERRED', reason: 'RUNNABLE_PENDING' })
    await pool.query("UPDATE durable_runtime.sessions SET lifecycle='CLOSED' WHERE id=$1", [f.sessions[0]])
    await assert.rejects(acceptInput(pool, input(f)), error => error instanceof DurableDatabaseError && error.code === 'INPUT_SESSION_CLOSED')
    assert.equal((await pool.query('SELECT id FROM durable_runtime.input_components WHERE session_id=$1', [f.sessions[0]])).rowCount, 1)
    const g = await fixture(pool)
    await pool.query("UPDATE durable_runtime.sessions SET lifecycle='CLOSING' WHERE id=$1", [g.sessions[0]])
    const closeFirst = await withDurableTransaction(pool, tx => reserveSleep(tx, { unitId: g.unit, actorId: 'fixture-catalog',
      discoveredMembers: g.sessions, expectedRevision: counter('row:runtime-unit', '0'), expectedIntentRevision: counter('intent-revision', '0'),
      policy, activityFreshnessMs: 60000, activity: null }))
    assert.deepEqual(closeFirst, { status: 'DEFERRED', reason: 'SESSION_CLOSING' })
  } finally { await pool.end() }
})

test('all members participate: one active member or missing current writer evidence prevents reservation', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool), a = await stoppedMetadataAttempt(pool, f, true)
    const args = { unitId: f.unit, actorId: 'fixture-catalog', discoveredMembers: f.sessions,
      expectedRevision: counter('row:runtime-unit', '0'), expectedIntentRevision: counter('intent-revision', '0'),
      policy, activityFreshnessMs: 60000 }
    assert.deepEqual(await withDurableTransaction(pool, tx => reserveSleep(tx, { ...args, activity: activity(f, a, f.sessions[1]) })),
      { status: 'DEFERRED', reason: 'MEMBER_ACTIVE' })
    assert.deepEqual(await withDurableTransaction(pool, tx => reserveSleep(tx, { ...args, activity: null })),
      { status: 'DEFERRED', reason: 'WRITER_UNVERIFIABLE' })
  } finally { await pool.end() }
})

test('read/due projection does not update activity, idle deadline, wake, receipt or operation', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool)
    await requestUnitIntent(pool, await intent(pool, f))
    const before = await pool.query('SELECT to_jsonb(u) AS state FROM durable_runtime.runtime_units u WHERE id=$1', [f.unit])
    const receipts = await pool.query('SELECT count(*)::text AS count FROM durable_runtime.rpc_receipts')
    await readUnitProjection(pool, f.unit); await listDueReconciliations(pool); await readUnitProjection(pool, f.unit)
    assert.deepEqual((await pool.query('SELECT to_jsonb(u) AS state FROM durable_runtime.runtime_units u WHERE id=$1', [f.unit])).rows, before.rows)
    assert.deepEqual((await pool.query('SELECT count(*)::text AS count FROM durable_runtime.rpc_receipts')).rows, receipts.rows)
  } finally { await pool.end() }
})

test('controller takeover preserves durable command/name/deadline and returns original lookup without another execution', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool)
    await requestUnitIntent(pool, await intent(pool, f))
    const op = (await pool.query('SELECT * FROM durable_runtime.operations WHERE runtime_unit_id=$1', [f.unit])).rows[0]
    const firstController = await controller(pool, 'fixture-controller-one', '1')
    const request = { context: { runtimeUnitId: f.unit, operationId: logicalId('operation', op.id), controller: firstController },
      mutationKey: randomUUID(), expectedUnitRevision: counter('row:runtime-unit', '1'), expectedIntentRevision: counter('intent-revision', '0'),
      expectedStepRevision: counter('step-revision', '0'), step: 'ENSURE_ATTEMPT' as const, executorId: executor, input: { namespace: 'fixture' } }
    const prepared = await prepareReconcileStep(pool, request)
    assert.equal(prepared.execution.disposition, 'COMMITTED_EXECUTE')
    assert.equal((await prepareReconcileStep(pool, request)).execution.disposition, 'NO_EXECUTION')
    const secondController = await controller(pool, 'fixture-controller-two', '2')
    await assert.rejects(prepareReconcileStep(pool, { ...request, mutationKey: randomUUID() }), failure('COMMAND_AUTHORITY_STALE'))
    const adopted = await prepareReconcileStep(pool, { ...request, mutationKey: randomUUID(),
      context: { ...request.context, controller: secondController } })
    assert.equal(adopted.execution.disposition, 'NO_EXECUTION')
    const after = (await pool.query('SELECT * FROM durable_runtime.operations WHERE id=$1', [op.id])).rows[0]
    assert.equal(after.external_resource_name, op.external_resource_name)
    assert.equal(after.deadline_at.getTime(), op.deadline_at.getTime()); assert.equal(after.retry_at, op.retry_at)
    const commands = await pool.query('SELECT state,original_controller_term,owner_controller_term FROM durable_runtime.runtime_commands WHERE runtime_unit_id=$1', [f.unit])
    assert.equal(commands.rowCount, 1); assert.equal(commands.rows[0].state, 'EXECUTING')
    assert.equal(commands.rows[0].original_controller_term, '1'); assert.equal(commands.rows[0].owner_controller_term, '2')
  } finally { await pool.end() }
})

test('historical stopped metadata cannot authorize replacement writer or erase the retained attempt', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool)
    await stoppedMetadataAttempt(pool, f, false)
    await requestUnitIntent(pool, await intent(pool, f))
    const op = (await pool.query('SELECT * FROM durable_runtime.operations WHERE runtime_unit_id=$1', [f.unit])).rows[0]
    const current = await controller(pool, 'fixture-controller-fence', '1')
    const result = await prepareReconcileStep(pool, { context: { runtimeUnitId: f.unit, operationId: logicalId('operation', op.id), controller: current },
      mutationKey: randomUUID(), expectedUnitRevision: counter('row:runtime-unit', '1'), expectedIntentRevision: counter('intent-revision', '0'),
      expectedStepRevision: counter('step-revision', '0'), step: 'ENSURE_ATTEMPT', executorId: executor, input: {} })
    assert.equal(result.execution.disposition, 'NO_EXECUTION')
    assert.equal((await pool.query('SELECT phase FROM durable_runtime.runtime_units WHERE id=$1', [f.unit])).rows[0].phase, 'BLOCKED')
    assert.equal((await pool.query('SELECT id FROM durable_runtime.runtime_commands WHERE runtime_unit_id=$1', [f.unit])).rowCount, 0)
  } finally { await pool.end() }
})

test('late stopped observation is original-attempt history only and cannot overwrite newer RUNNING intent', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool), a = await stoppedMetadataAttempt(pool, f, true)
    await requestUnitIntent(pool, await intent(pool, f))
    const op = (await pool.query('SELECT * FROM durable_runtime.operations WHERE runtime_unit_id=$1', [f.unit])).rows[0]
    const current = await controller(pool, 'fixture-controller-observation', '1')
    await pool.query('UPDATE durable_runtime.operations SET controller_term=1 WHERE id=$1', [op.id])
    await pool.query('UPDATE durable_runtime.runtime_units SET intent_revision=1 WHERE id=$1', [f.unit])
    const before = (await pool.query('SELECT desired_mode,intent_revision,active_attempt_id,phase FROM durable_runtime.runtime_units WHERE id=$1', [f.unit])).rows
    const result = await recordReconcileObservation(pool, { context: { runtimeUnitId: f.unit, operationId: logicalId('operation', op.id), controller: current },
      originalStepRevision: counter('step-revision', '0'), originalIntentRevision: counter('intent-revision', '0'), originalControllerTerm: counter('controller-term', '1'),
      attemptId: a.attempt, podUid: a.podUid, executionEpoch: counter('execution-epoch', '0'), producerId: logicalId('producer', randomUUID()),
      sequence: counter('sequence:producer', '1'), watermark: counter('sequence:observation', '1'), source: 'K8S_WATCH', resourceVersion: 'opaque-fixture-rv', kind: 'STOPPED' })
    assert.equal(result.status, 'COMMITTED')
    if (result.status !== 'UNCERTAIN') { assert.equal((result.receipt.response as { disposition: string }).disposition, 'STALE_HISTORY_ONLY') }
    assert.deepEqual((await pool.query('SELECT desired_mode,intent_revision,active_attempt_id,phase FROM durable_runtime.runtime_units WHERE id=$1', [f.unit])).rows, before)
    assert.equal((await pool.query('SELECT status FROM durable_runtime.attempts WHERE id=$1', [a.attempt])).rows[0].status, 'OBSERVED_STOPPED')
  } finally { await pool.end() }
})

test('membership discovery mismatch rolls back the whole lifecycle mutation without late Session locks', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool)
    const before = (await pool.query('SELECT to_jsonb(u) AS state FROM durable_runtime.runtime_units u WHERE id=$1', [f.unit])).rows
    await assert.rejects(withDurableTransaction(pool, tx => reserveSleep(tx, { unitId: f.unit, actorId: 'fixture-catalog',
      discoveredMembers: [f.sessions[0]], expectedRevision: counter('row:runtime-unit', '0'), expectedIntentRevision: counter('intent-revision', '0'),
      policy, activityFreshnessMs: 60000, activity: null })), failure('LIFECYCLE_MEMBERSHIP_CHANGED'))
    assert.deepEqual((await pool.query('SELECT to_jsonb(u) AS state FROM durable_runtime.runtime_units u WHERE id=$1', [f.unit])).rows, before)
    assert.equal((await pool.query('SELECT id FROM durable_runtime.operations WHERE runtime_unit_id=$1', [f.unit])).rowCount, 0)
  } finally { await pool.end() }
})

test('lifecycle outbox SQL failure rolls back Unit/operation/audit/receipt together', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool)
    const request = await intent(pool, f, 'DELETED')
    const failing: Pool = new Proxy(pool, { get(target, key) {
      if (key === 'connect') {
        return async () => {
          const client = await target.connect()
          return new Proxy(client, { get(connection, field) {
            if (field === 'query') {
              return (sql: string, values: readonly unknown[] = []) =>
                connection.query(sql.includes('INSERT INTO durable_runtime.outbox_events') ? 'SELECT 1/0' : sql,
                  sql.includes('INSERT INTO durable_runtime.outbox_events') ? [] : [...values])
            }
            const value = Reflect.get(connection, field)
            return typeof value === 'function' ? value.bind(connection) : value
          } })
        }
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    await assert.rejects(requestUnitIntent(failing, request), failure('22012'))
    assert.equal((await pool.query('SELECT desired_mode FROM durable_runtime.runtime_units WHERE id=$1', [f.unit])).rows[0].desired_mode, 'RUNNING')
    assert.equal((await pool.query('SELECT id FROM durable_runtime.operations WHERE runtime_unit_id=$1', [f.unit])).rowCount, 0)
    assert.equal((await pool.query('SELECT id FROM durable_runtime.runtime_audit_events WHERE runtime_unit_id=$1', [f.unit])).rowCount, 0)
    assert.equal((await pool.query('SELECT id FROM durable_runtime.outbox_events WHERE aggregate_id=$1', [f.unit])).rowCount, 0)
    assert.equal((await pool.query('SELECT operation_key FROM durable_runtime.rpc_receipts WHERE session_scope=$1', [request.authority.scope])).rowCount, 0)
  } finally { await pool.end() }
})
