import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getEventListeners } from 'node:events'
import { performance } from 'node:perf_hooks'
import { createComputeStopEvidence, ComputeStopEvidenceError } from './compute-stop-evidence.ts'
import { stopDeferred, stopFixture, stopFixtureInput, stopFixtureRow } from './compute-stop-evidence-fixtures.mts'
import { deletionEntries } from './compute-deletion-audit-fixtures.mts'
import { closedStreams } from './compute-deletion-audit-transport-fixtures.mts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'

const code = (expected: string) => (error: unknown): boolean =>
  error instanceof ComputeStopEvidenceError && error.code === expected
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

await test('compute stop evidence: value callback 1, synthetic Pool and HTTPS only', async t => {
  await t.test('stable frozen exact owner; clone, sibling, release and abort cannot retain pins', async () => {
    const fixture = stopFixture(), controller = new AbortController()
    const service = createComputeStopEvidence(fixture.configuration)
    const input = stopFixtureInput()
    const first = await service.prepare(input, controller.signal)
    const sibling = await service.prepare(input, new AbortController().signal)
    assert.equal(first.reference, sibling.reference)
    assert.equal(fixture.connections(), 2)
    assert.deepEqual(fixture.releases, [false, false])
    assert.equal(fixture.phases.indexOf('RELEASE') < fixture.phases.indexOf('AUDIT_TOKEN'), true)
    const key = input.key
    const target = first.executionTarget(key.attemptId, key.podUid, key.incarnation, key.executionEpoch)
    const stopped = first.permanentComputeStop(first.reference)
    assert.ok(target && stopped)
    assert.equal(stopped.proof.kind, 'COMPUTE_STOPPED')
    assert.equal(stopped.proof.observationSource, 'COMPUTE_CONTROL_PLANE')
    assert.equal(stopped.disposition, 'DELETED_NO_REENTRY')
    for (const value of [first, target, stopped, stopped.proof]) { assert.equal(Object.isFrozen(value), true) }
    assert.equal(first.executionTargetPinValid(target), true)
    assert.equal(first.computeStopPinValid(stopped), true)
    assert.equal(first.executionTargetPinValid({ ...target }), false)
    assert.equal(first.computeStopPinValid({ ...stopped }), false)
    assert.equal(sibling.executionTargetPinValid(target), false)
    assert.equal(sibling.computeStopPinValid(stopped), false)
    assert.equal(first.executionTarget(key.attemptId, 'another-pod', key.incarnation, key.executionEpoch), null)
    assert.equal(first.permanentComputeStop('fabricated'), null)
    assert.equal('directory' in first, false)
    assert.equal('mount' in first, false)
    assert.equal('pool' in first, false)
    controller.abort()
    assert.equal(first.executionTargetPinValid(target), false)
    assert.equal(first.permanentComputeStop(first.reference), null)
    sibling.release(); sibling.release()
    assert.equal(sibling.computeStopPinValid(stopped), false)
    const otherFixture = stopFixture()
    Object.assign(otherFixture.row!, { observation_digest: 'b'.repeat(64) })
    const changed = await createComputeStopEvidence(otherFixture.configuration).prepare(input, new AbortController().signal)
    assert.notEqual(changed.reference, first.reference)
    changed.release()
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    await closedStreams()
  })

  await t.test('missing target, invalid dataset/scope/identity and malformed input never reach Cloud', async () => {
    for (const change of [
      (f: ReturnType<typeof stopFixture>) => { f.configuration.datasetName = 'another-dataset' },
      (f: ReturnType<typeof stopFixture>) => { f.configuration.namespace = 'another-namespace' },
      (f: ReturnType<typeof stopFixture>) => { f.configuration.clusterIdentityRef = 'another-cluster' },
      (f: ReturnType<typeof stopFixture>) => { f.configuration.projectId = 'other-project' },
      (f: ReturnType<typeof stopFixture>) => { f.configuration.projectNumber = '999999999999' },
      (f: ReturnType<typeof stopFixture>) => { f.row!.numeric_instance_id = '18446744073709551616' },
      (f: ReturnType<typeof stopFixture>) => { f.row!.runtime_unit_id = logicalId('runtime-unit', '30000000-0000-4000-8000-000000000003') }
    ]) {
      const f = stopFixture()
      change(f)
      await assert.rejects(createComputeStopEvidence(f.configuration).prepare(stopFixtureInput(), new AbortController().signal))
      assert.equal(f.wire.requests.length, 0)
      assert.equal(f.phases.includes('AUDIT_TOKEN'), false)
      assert.equal(f.checkedOut(), 0)
    }
    for (const f of [stopFixture({ row: null }), stopFixture({ datasetRows: [] }),
      stopFixture({ datasetRows: [{ dataset_name: 'synthetic-stop-dataset' }, { dataset_name: 'synthetic-stop-dataset' }] })]) {
      await assert.rejects(createComputeStopEvidence(f.configuration).prepare(stopFixtureInput(), new AbortController().signal))
      assert.equal(f.wire.requests.length, 0)
      assert.equal(f.checkedOut(), 0)
    }
    const f = stopFixture(), input = stopFixtureInput()
    input.key.podUid = 'missing-pod' as typeof input.key.podUid
    await assert.rejects(createComputeStopEvidence(f.configuration).prepare(input, new AbortController().signal), code('TARGET_NOT_FOUND'))
    input.startTime = 'invalid'
    await assert.rejects(createComputeStopEvidence(f.configuration).prepare(input, new AbortController().signal), code('INVALID_INPUT'))
    assert.equal(f.connections(), 1)
  })

  await t.test('complete matching deletion and time boundary are required; unsuccessful observations issue no owner', async () => {
    const wrongOperation = deletionEntries(); wrongOperation[1].operation.id = 'other-operation'
    const unsuccessful = deletionEntries(); unsuccessful[1].protoPayload.status = { code: 7 }
    const wrongIdentity = deletionEntries(); wrongIdentity[0].protoPayload.response!.targetId = '999'
    const firstError = deletionEntries()
    Object.assign(firstError[0].protoPayload.response!, { error: { errors: [{ code: 'SYNTHETIC_DELETE_FAILED' }] } })
    const lastError = deletionEntries()
    lastError[1].protoPayload.response = { ...lastError[0].protoPayload.response! }
    Object.assign(lastError[1].protoPayload.response, { error: { errors: [{ code: 'SYNTHETIC_DELETE_FAILED' }] } })
    for (const scenario of [
      { json: { entries: [] } }, { json: { entries: deletionEntries(), nextPageToken: 'synthetic-next' } },
      { json: { entries: wrongOperation } }, { json: { entries: unsuccessful } },
      { json: { entries: firstError } }, { json: { entries: lastError } },
      { json: { entries: wrongIdentity } }, { status: 403 }, { errorCode: 'CERT_HAS_EXPIRED' }
    ]) {
      const f = stopFixture({ scenario })
      await assert.rejects(createComputeStopEvidence(f.configuration).prepare(stopFixtureInput(), new AbortController().signal), code('AUDIT_REJECTED'))
      assert.deepEqual(f.releases, [false])
      assert.equal(f.wire.requests.length, 1)
    }
    const row = stopFixtureRow()
    row.observed_at = new Date('2026-10-14T11:34:21.000Z')
    const f = stopFixture({ row })
    await assert.rejects(createComputeStopEvidence(f.configuration).prepare(stopFixtureInput(row), new AbortController().signal), code('AUDIT_REJECTED'))
    await closedStreams()
  })

  await t.test('single getters and original Pool/token/HTTPS receivers survive caller mutation', async () => {
    const barrier = stopDeferred<void>(), f = stopFixture({ beforeConnect: () => barrier.promise })
    let configReads = 0, keyReads = 0
    const configuration = { ...f.configuration, get pool() {
      assert.equal(++configReads, 1); return f.configuration.pool
    } }
    const source = stopFixtureInput(), originalKey = source.key
    const input = { ...source, get key() { assert.equal(++keyReads, 1); return originalKey } }
    const service = createComputeStopEvidence(configuration)
    const pending = service.prepare(input, new AbortController().signal)
    source.key.podUid = 'mutated-pod' as typeof source.key.podUid
    f.pool.connect = async () => { throw new Error('mutated connect') }
    f.tokenProvider.getAccessToken = async () => { throw new Error('mutated token') }
    f.wire.holder.request = () => { throw new Error('mutated HTTPS') }
    barrier.resolve()
    const owner = await pending
    assert.equal(configReads, 1); assert.equal(keyReads, 1)
    assert.equal(f.wire.requests.length, 1)
    assert.equal(f.wire.requests[0].body.includes('mutated'), false)
    owner.release()
  })

  await t.test('late Pool and each SQL await are destroyed after abort; Cloud stays zero', async () => {
    const gate = stopDeferred<void>(), f = stopFixture({ beforeConnect: () => gate.promise })
    const controller = new AbortController()
    const pending = createComputeStopEvidence(f.configuration).prepare(stopFixtureInput(), controller.signal)
    controller.abort()
    await assert.rejects(pending, code('ABORTED'))
    gate.resolve(); await flush()
    assert.deepEqual(f.releases, [true]); assert.equal(f.queries.length, 0)
    for (const phase of ['BEGIN', 'dataset_metadata', 'execution_target_records', 'COMMIT']) {
      const entered = stopDeferred<void>(), held = stopDeferred<void>()
      const fixture = stopFixture({ beforeQuery: sql => {
        if (sql.includes(phase)) { entered.resolve(); return held.promise }
        return Promise.resolve()
      } })
      const caller = new AbortController()
      const operation = createComputeStopEvidence(fixture.configuration).prepare(stopFixtureInput(), caller.signal)
      await entered.promise
      caller.abort()
      await assert.rejects(operation, code('ABORTED'))
      const queryCount = fixture.queries.length
      held.resolve(); await flush()
      assert.equal(fixture.queries.length, queryCount)
      assert.deepEqual(fixture.releases, [true])
      assert.equal(fixture.phases.includes('AUDIT_TOKEN'), false)
      assert.equal(fixture.wire.requests.length, 0)
    }
    const broken = stopFixture({ beforeQuery: async sql => {
      if (sql.includes('execution_target_records') || sql === 'ROLLBACK') { throw new Error('synthetic SQL failure') }
    } })
    await assert.rejects(createComputeStopEvidence(broken.configuration).prepare(stopFixtureInput(), new AbortController().signal), code('DB_READ_FAILED'))
    assert.deepEqual(broken.releases, [true]); assert.equal(broken.wire.requests.length, 0)
  })

  await t.test('one deadline covers connect, synchronous SQL overrun and pending Audit/token; caller abort wins', async () => {
    const gate = stopDeferred<void>(), f = stopFixture({ beforeConnect: () => gate.promise })
    f.configuration.timeoutMs = 5
    await assert.rejects(createComputeStopEvidence(f.configuration).prepare(stopFixtureInput(), new AbortController().signal), code('TIMEOUT'))
    gate.resolve(); await flush()
    assert.deepEqual(f.releases, [true]); assert.equal(f.wire.requests.length, 0)
    const overrun = stopFixture({ beforeQuery: async sql => {
      if (sql.includes('dataset_metadata')) {
        const until = performance.now() + 25
        while (performance.now() < until) { /* Bounded synchronous deadline fixture; no random sleep. */ }
      }
    } })
    overrun.configuration.timeoutMs = 5
    await assert.rejects(createComputeStopEvidence(overrun.configuration).prepare(stopFixtureInput(), new AbortController().signal), code('TIMEOUT'))
    assert.deepEqual(overrun.releases, [true]); assert.equal(overrun.wire.requests.length, 0)
    const entered = stopDeferred<void>(), token = stopDeferred<string>()
    const waiting = stopFixture({ token: () => { entered.resolve(); return token.promise } })
    const caller = new AbortController()
    const pending = createComputeStopEvidence(waiting.configuration).prepare(stopFixtureInput(), caller.signal)
    await entered.promise
    caller.abort(); await assert.rejects(pending, code('ABORTED'))
    token.resolve('late-synthetic-token'); await flush()
    assert.deepEqual(waiting.releases, [false]); assert.equal(waiting.wire.requests.length, 0)
    const wireWaiting = stopFixture({ scenario: { neverRespond: true } })
    wireWaiting.configuration.timeoutMs = 10
    await assert.rejects(createComputeStopEvidence(wireWaiting.configuration).prepare(stopFixtureInput(), new AbortController().signal), code('TIMEOUT'))
    await closedStreams()
    assert.deepEqual(wireWaiting.releases, [false])
    assert.equal(wireWaiting.wire.requests.length, 1)
    assert.equal(wireWaiting.wire.requests[0].destroyed, true)
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
    const preAborted = new AbortController(); preAborted.abort()
    const untouched = stopFixture()
    await assert.rejects(createComputeStopEvidence(untouched.configuration).prepare(stopFixtureInput(), preAborted.signal), code('ABORTED'))
    assert.equal(untouched.connections(), 0)
  })

  await t.test('PG budget consumption and synchronous token overrun cannot enter HTTPS before the timer fires', async () => {
    const spin = (milliseconds: number): void => {
      const end = performance.now() + milliseconds
      while (performance.now() < end) { /* Bounded synchronous overrun, not a scheduling sleep. */ }
    }
    let tokenEntered = false
    const fixture = stopFixture({ beforeQuery: async sql => {
      if (sql === 'COMMIT') { spin(45) }
    }, token: async () => {
      tokenEntered = true
      spin(50)
      return 'synthetic-stop-token'
    } })
    fixture.configuration.timeoutMs = 80
    await assert.rejects(createComputeStopEvidence(fixture.configuration).prepare(stopFixtureInput(), new AbortController().signal), code('TIMEOUT'))
    assert.equal(tokenEntered, true)
    assert.deepEqual(fixture.releases, [false])
    assert.equal(fixture.wire.requests.length, 0)
    assert.equal(fixture.checkedOut(), 0)
  })
})
