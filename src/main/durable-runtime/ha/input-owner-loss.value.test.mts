import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createDurablePool } from '../db/connection.ts'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { controller as fixtureController } from '../lifecycle/verification-fixtures.mts'
import { ControllerInstance, CONTROLLER_SCOPE, type LeaseRecord } from './instance.ts'
import { ControllerLeaseSession } from './session.ts'
import { runControllerPass, type ControllerInputRecoveryResult, type ControllerPassRequest } from './pass.ts'
import type { ControllerTakeoverSnapshot, TakeoverCommand, TakeoverOperation, TakeoverUnit } from './takeover.ts'
import { captureOrcadControllerConfig, captureOrcadInputRecoveryTarget } from '../../orcad/orcad-controller-config.ts'

if (process.env.ORCA_INPUT_OWNER_LOSS_HA_APPROVED !== 'root-first-focus') {
  throw new Error('Root input owner-loss HA focused value assignment required')
}

await test('input recovery is selected before lifecycle planning, cannot dispatch, and stops on uncertain COMMIT', async () => {
  // Scheduling-only synthetic fixture. No PG connection, lease authentication,
  // provider proof or production authority is established by these objects.
  const pool = createDurablePool({ max: 1 })
  let fixtureQueries = 0
  Object.defineProperty(pool, 'query', { value: async (sql: string) => {
    assert.match(sql, /^INSERT INTO durable_runtime.controller_leases/u)
    fixtureQueries++
    return { rows: [], rowCount: 1 }
  } })
  Object.defineProperty(pool, 'connect', { value: () => { throw new Error('unexpected PG connection') } })
  try {
    // Reuse the existing explicitly synthetic fixture issuer. Product code has
    // no row/principal-to-authority conversion or additional proof factory.
    const identity = await fixtureController(pool, 'synthetic-input-recovery-owner', '2')
    const lease: LeaseRecord = { ...identity, revision: counter('row:controller', '1'), expiresAt: new Date(Date.now() + 60000).toISOString() }
    const unitId = logicalId('runtime-unit', randomUUID()), operationId = logicalId('operation', randomUUID())
    const operation: TakeoverOperation = { id: operationId, runtime_unit_id: unitId,
      kind: 'INPUT_DELIVERY', controller_scope: identity.scope, controller_term: counter('controller-term', '1'),
      intent_revision: counter('intent-revision', '1'), execution_epoch: counter('execution-epoch', '0'),
      step: 'INPUT', step_revision: counter('step-revision', '0'), revision: counter('row:operation', '1'),
      expected_pod_uid: 'synthetic-pod', external_resource_name: null, deadline_at: null, retry_at: null,
      terminal: false, retry_due: true, deadline_expired: false }
    const unit: TakeoverUnit = { id: unitId, intent_revision: operation.intent_revision, execution_epoch: operation.execution_epoch,
      active_attempt_id: logicalId('attempt', randomUUID()), revision: counter('row:runtime-unit', '1'),
      desired_mode: 'RUNNING', phase: 'READY', last_work_event_at: null, idle_due_at: null,
      observation_lost_at: null, reconcile_due_at: null, attempt_status: 'RUNNING', pod_uid: 'synthetic-pod' }
    const command: TakeoverCommand = { id: randomUUID(), operation_id: operationId, runtime_unit_id: unitId,
      command_name: 'dispatchInput', original_controller_term: counter('controller-term', '1'),
      step_revision: operation.step_revision, pod_target: 'EXISTING_POD', expected_pod_uid: 'synthetic-pod',
      execution_epoch: operation.execution_epoch, intent_revision: operation.intent_revision, input_hash: 'a'.repeat(64),
      state: 'EXECUTING', owner_controller_term: counter('controller-term', '1'), executor_id: 'synthetic-executor',
      execution_token: randomUUID(), revision: counter('row:runtime-command', '1'), accepted_at: new Date(),
      claimed_at: new Date(), settled_at: null, refusal_code: null }
    const snapshot: ControllerTakeoverSnapshot = { lease, readAt: new Date().toISOString(),
      operations: [operation], units: [unit], commands: [command], producers: [], queueHeads: [] }
    class SyntheticSession extends ControllerLeaseSession {
      stops = 0
      override get lease(): LeaseRecord { return lease }
      override assertCurrent(): Promise<LeaseRecord> { return Promise.resolve(lease) }
      override readTakeoverSnapshot(): Promise<ControllerTakeoverSnapshot> { return Promise.resolve(snapshot) }
      override stop(): void { this.stops++; super.stop() }
    }
    for (const outcome of [
      { status: 'HANDLED', disposition: 'UNKNOWN_RECORDED' },
      { status: 'HANDLED', disposition: 'ALREADY_UNKNOWN' },
      { status: 'NOT_APPLICABLE' },
      { status: 'UNCERTAIN', settlement: 'UNCONFIRMED', commitOutcome: 'UNKNOWN', cleanupFailed: true }
    ] satisfies readonly ControllerInputRecoveryResult[]) {
      const session = new SyntheticSession(pool, new ControllerInstance(CONTROLLER_SCOPE), { revision: 'synthetic-recovery', durationMs: 60000 })
      let callbacks = 0, nativeCalls = 0
      const request: ControllerPassRequest = { controller: identity, maximumWork: 10, externalBudgetMs: 1000,
        recoverInput: async (actualCommand, actualOperation, signal, context) => {
          callbacks++
          assert.equal(actualCommand, command); assert.equal(actualOperation, operation)
          assert.deepEqual(context, { controller: identity, runtimeUnitId: unitId, operationId })
          assert.ok(Object.isFrozen(context)); assert.ok(Object.isFrozen(context.controller)); assert.equal(signal.aborted, false)
          await Promise.resolve()
          return outcome
        },
        // No lifecycle planner is installed: null/absent used to prevent the
        // recovery path from ever reaching lookupOriginal.
        executeCommitted: async () => { nativeCalls++ }, lookupOriginal: async () => { nativeCalls++ } }
      const result = await runControllerPass(pool, session, request)
      assert.equal(callbacks, 1); assert.equal(nativeCalls, 0)
      if (outcome.status === 'UNCERTAIN') {
        assert.equal(result.status, 'STOPPED'); assert.equal(result.reason, 'UNCERTAIN_COMMIT'); assert.equal(session.stops, 1)
      } else {
        assert.equal(result.status, 'FINISHED'); assert.equal(session.stops, 0)
        assert.deepEqual(result.items.map(item => item.disposition),
          [outcome.status === 'HANDLED' ? outcome.disposition : 'LOOKUP_REQUIRED'])
      }
    }
    assert.equal(fixtureQueries, 1)
  } finally { await pool.end() }
})

await test('trusted recovery selector is optional, detached, strict own data and independent of cold activation', () => {
  const base = { datasetName: 'orca-1012-dev-v1', inventory: { apiOrigin: 'https://127.0.0.1:1',
    namespace: 'synthetic', dataset: 'orca-1012-dev-v1', caFile: '/synthetic/ca', tokenFile: '/synthetic/token',
    requestTimeoutMs: 1000, watchTimeoutSeconds: 1, listLimit: 1 }, policy: {
    lease: { revision: 'synthetic-input-recovery', durationMs: 5000 }, renewIntervalMs: 1000,
    standbyPollIntervalMs: 1000, passPollIntervalMs: 1000, maximumWork: 1, externalBudgetMs: 1000 } }
  assert.equal(Object.hasOwn(captureOrcadControllerConfig(base), 'inputRecoveryTarget'), false)
  const input = { sessionId: randomUUID(), runtimeUnitId: randomUUID(), operationId: randomUUID(), commandId: randomUUID() }
  const captured = captureOrcadControllerConfig({ ...base, inputRecoveryTarget: input })
  const originalSession = input.sessionId
  input.sessionId = randomUUID()
  assert.equal(captured.inputRecoveryTarget?.sessionId, originalSession)
  assert.ok(Object.isFrozen(captured.inputRecoveryTarget)); assert.equal(Object.hasOwn(captured, 'firstManagedInitial'), false)
  let getters = 0
  const accessor = Object.defineProperty({ ...input }, 'commandId', { get() { getters++; return randomUUID() } })
  assert.throws(() => captureOrcadInputRecoveryTarget(accessor)); assert.equal(getters, 0)
  assert.throws(() => captureOrcadInputRecoveryTarget({ ...input, principal: 'untrusted' }))
  assert.throws(() => captureOrcadInputRecoveryTarget({ ...input, operationId: '' }))
})
