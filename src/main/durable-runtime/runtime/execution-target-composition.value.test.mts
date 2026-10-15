import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { getEventListeners } from 'node:events'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { inspect } from 'node:util'
import type { DurableTransaction } from '../db/connection.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import type { GatewayContext } from './gateway/types.ts'
import type { AuthenticatedPodObservation } from './kubernetes-pod-auth-types.ts'
import type { ComputeCreationIdentityResult } from './compute-creation-identity-types.ts'
import { createExecutionTargetComposition, ExecutionTargetCompositionError } from './execution-target-composition.ts'
import type { PreparedExecutionTarget } from './execution-target-composition.ts'
import { compositionCreation, compositionDeferred, compositionDoubles, compositionInput,
  compositionNode, compositionPod, compositionScope, compositionTransaction } from './execution-target-composition-fixtures.mts'

const failure = (code: string) => (error: unknown): boolean => {
  assert.ok(error instanceof ExecutionTargetCompositionError)
  assert.equal(error.code, code)
  assert.equal('cause' in error, false)
  assert.equal(inspect(error).includes('synthetic-pod-bearer'), false)
  return true
}
function context(input = compositionInput()): GatewayContext {
  // Explicit synthetic context, not a production authenticated controller issuer.
  return { runtimeUnitId: input.expected.runtimeUnitId, operationId: input.expected.operationId,
    controller: { scope: 'synthetic-controller', owner: 'synthetic-owner', term: '1' } } as GatewayContext
}
function overrun(): void {
  const until = performance.now() + 25
  let now = performance.now()
  while (now < until) {
    now = performance.now()
  }
}

test('prepare captures original observer receivers, scope and input once before await; handle is opaque', async () => {
  const gate = compositionDeferred<AuthenticatedPodObservation>()
  const f = compositionDoubles({ pod: () => gate.promise })
  const service = createExecutionTargetComposition(f.configuration), input = compositionInput()
  const original = compositionPod(input)
  const signal = new AbortController().signal
  const pending = service.prepare(input, signal)
  f.configuration.projectId = 'another-project'
  f.configuration.namespace = 'different-namespace'
  f.configuration.timeoutMs = 1
  f.pod.authenticatePod = async () => { throw new Error('replaced observer') }
  f.creation.observe = async () => { throw new Error('replaced creation observer') }
  input.expected.runtimeUnitId = '40000000-0000-4000-8000-000000000001'
  input.expected.specHash = 'c'.repeat(64)
  input.podBearer = 'changed-bearer'
  input.creationStartTime = 'invalid'
  gate.resolve(original)
  const prepared = await pending
  assert.equal(Object.isFrozen(prepared), true)
  assert.deepEqual(Object.keys(prepared), ['kind'])
  assert.deepEqual(f.calls.map(x => x.kind), ['pod', 'creation'])
  const creation = f.calls[1].input
  assert.ok('scope' in creation)
  assert.deepEqual(creation.scope, { projectId: compositionScope.projectId,
    projectNumber: compositionScope.projectNumber, ...compositionNode })
  assert.equal(creation.startTime, '2026-10-15T00:00:00.000Z')
  for (const value of [JSON.stringify(prepared), inspect(prepared), JSON.stringify(creation)]) {
    assert.equal(value.includes('synthetic-pod-bearer'), false)
  }
  assert.equal(getEventListeners(signal, 'abort').length, 0)
})

test('Pod scope, SA, exact execution and Node identity mismatch never reach creation', async () => {
  const changes = [
    { kind: 'wrong' }, { namespace: 'wrong' }, { dataset: 'wrong' }, { audience: 'wrong' },
    { clusterIdentityRef: 'wrong' }, { serviceAccount: { name: 'wrong', uid: 'sa-uid' } },
    { pod: { ...compositionPod(compositionInput()).pod, executionEpoch: '2' } },
    { pod: { ...compositionPod(compositionInput()).pod, uid: 'other-pod' } },
    { node: { ...compositionPod(compositionInput()).node, uid: 'other-node' } },
    { evidenceDigest: 'A'.repeat(64) }
  ]
  for (const change of changes) {
    const f = compositionDoubles({ pod: async input => ({ ...compositionPod(input), ...change }) as AuthenticatedPodObservation })
    await assert.rejects(createExecutionTargetComposition(f.configuration).prepare(compositionInput(), new AbortController().signal),
      failure('POD_OBSERVATION_INVALID'))
    assert.deepEqual(f.calls.map(x => x.kind), ['pod'])
  }
  for (const node of [
    { providerId: undefined }, { instanceId: undefined }, { instanceId: '0' }, { instanceId: '01' },
    { instanceId: '18446744073709551616' }, { instanceId: '1\n' }, { observationSource: 'COMPUTE_CONTROL_PLANE' },
    ...['gce://other-project/asia-northeast3-a/vm', 'gce://fixture-project/asia-northeast3-a/vm/extra',
      'gce://fixture-project/asia-northeast3-a/vm?query', 'gce://fixture-project/asia-northeast3-a/vm#fragment',
      'gce://fixture-project/asia-northeast3-a/vm%2fname', 'gce://fixture-project/asia-northeast3-a/vm\n']
      .map(providerId => ({ providerId }))
  ]) {
    const f = compositionDoubles({ pod: async input => {
      const value = compositionPod(input)
      return { ...value, node: { ...value.node, ...node } } as AuthenticatedPodObservation
    } })
    await assert.rejects(createExecutionTargetComposition(f.configuration).prepare(compositionInput(), new AbortController().signal),
      failure('NODE_IDENTITY_INVALID'))
    assert.equal(f.calls.length, 1)
  }
})

test('creation must independently confirm every exact scope field, source and canonical digest', async () => {
  for (const field of ['projectId', 'projectNumber', 'zone', 'instanceName', 'numericInstanceId'] as const) {
    const f = compositionDoubles({ creation: async input => {
      const value = compositionCreation(input)
      assert.ok(value.ok && value.observation.status === 'CREATE_OPERATION_COMPLETED')
      return { ok: true, observation: { ...value.observation, identity: { ...input.scope, [field]: 'different' } } }
    } })
    await assert.rejects(createExecutionTargetComposition(f.configuration).prepare(compositionInput(), new AbortController().signal),
      failure('CREATION_NOT_CONFIRMED'))
    assert.equal(f.calls.length, 2)
  }
  for (const observation of [{ status: 'NOT_OBSERVED', reason: 'NO_ENTRIES' },
    { status: 'INCOMPLETE', reason: 'NEXT_PAGE_PRESENT' }, { status: 'UNCONFIRMED', reason: 'IDENTITY_MISMATCH' },
    { status: 'CREATE_OPERATION_COMPLETED', source: 'WRONG_SOURCE' },
    { status: 'CREATE_OPERATION_COMPLETED', source: 'CLOUD_AUDIT_LOGS', identity: {}, evidenceDigest: 'bad' }]) {
    const f = compositionDoubles({ creation: async () => ({ ok: true, observation }) as ComputeCreationIdentityResult })
    await assert.rejects(createExecutionTargetComposition(f.configuration).prepare(compositionInput(), new AbortController().signal),
      failure('CREATION_NOT_CONFIRMED'))
  }
})

test('uncooperative Pod or creation wait ends on abort/deadline and late results issue no handle', async () => {
  for (const phase of ['pod', 'creation'] as const) {
    for (const mode of ['abort', 'timeout'] as const) {
      const podGate = compositionDeferred<AuthenticatedPodObservation>()
      const creationGate = compositionDeferred<ComputeCreationIdentityResult>()
      const entered = compositionDeferred<void>(), caller = new AbortController()
      const control = phase === 'pod'
        ? { pod: () => { entered.resolve(); return podGate.promise } }
        : { creation: () => { entered.resolve(); return creationGate.promise } }
      const f = compositionDoubles(control)
      f.configuration.timeoutMs = 10
      const pending = createExecutionTargetComposition(f.configuration).prepare(compositionInput(), caller.signal)
      await entered.promise
      if (mode === 'abort') {
        caller.abort(new Error('synthetic-pod-bearer'))
      }
      await assert.rejects(pending, failure(mode === 'abort' ? 'ABORTED' : 'TIMEOUT'))
      assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
      assert.equal(f.calls.every(x => x.signal?.aborted), true)
      const before = f.calls.length
      podGate.resolve(compositionPod(compositionInput()))
      creationGate.resolve(compositionCreation({ scope: { projectId: compositionScope.projectId,
        projectNumber: compositionScope.projectNumber, ...compositionNode },
      startTime: '2026-10-15T00:00:00.000Z', endTime: '2026-10-15T00:01:00.000Z' }))
      await Promise.resolve()
      assert.equal(f.calls.length, before)
    }
  }
  const f = compositionDoubles(), caller = new AbortController()
  caller.abort(new Error('synthetic-pod-bearer'))
  await assert.rejects(createExecutionTargetComposition(f.configuration).prepare(compositionInput(), caller.signal), failure('ABORTED'))
  assert.equal(f.calls.length, 0)
})

test('synchronous late observers are rejected before next observer or prepared handle', async () => {
  for (const phase of ['pod', 'creation'] as const) {
    const f = compositionDoubles({
      pod: async input => { if (phase === 'pod') { overrun() } return compositionPod(input) },
      creation: async input => { if (phase === 'creation') { overrun() } return compositionCreation(input) }
    })
    f.configuration.timeoutMs = 10
    await assert.rejects(createExecutionTargetComposition(f.configuration).prepare(compositionInput(), new AbortController().signal),
      failure('TIMEOUT'))
    assert.equal(f.calls.length, phase === 'pod' ? 1 : 2)
  }
})

test('forged or foreign handles and wrong Unit/operation are refused before borrowed SQL', async () => {
  const f = compositionDoubles(), service = createExecutionTargetComposition(f.configuration)
  const real = await service.prepare(compositionInput(), new AbortController().signal)
  const other = createExecutionTargetComposition(f.configuration)
  const foreign = await other.prepare(compositionInput(), new AbortController().signal)
  const borrowed = {} as DurableTransaction
  for (const handle of [Object.freeze({ ...real }), foreign, {}] as PreparedExecutionTarget[]) {
    await assert.rejects(service.record(borrowed, context(), handle), failure('PREPARED_INVALID'))
  }
  for (const key of ['runtimeUnitId', 'operationId'] as const) {
    const wrong = { ...context(), [key]: '40000000-0000-4000-8000-000000000001' }
    await assert.rejects(service.record(borrowed, wrong, real), failure('CONTEXT_SCOPE'))
  }
})

test('same handle records one frozen observation; context capture and original conflict propagate', async () => {
  const f = compositionDoubles(), input = compositionInput()
  const service = createExecutionTargetComposition(f.configuration), handle = await service.prepare(input, new AbortController().signal)
  const authority = context(input), originalAuthority = context(input)
  const driver = compositionTransaction(originalAuthority, () => {
    Object.assign(authority, { runtimeUnitId: '40000000-0000-4000-8000-000000000001' })
    Object.assign(authority.controller, { scope: 'mutated-controller', term: '2' })
  })
  input.podBearer = 'changed-after-prepare'
  const first = await service.record(driver.tx, authority, handle)
  assert.equal(first.status, 'TRANSACTION_LOCAL')
  assert.equal(Object.isFrozen(first), true)
  assert.equal(Object.isFrozen(first.record), true)
  assert.equal(first.record.instanceName, compositionNode.instanceName)
  assert.notEqual(first.record.nodeName, first.record.instanceName)
  assert.equal(first.record.numericInstanceId, compositionNode.numericInstanceId)
  assert.equal(first.record.computeIdentityRef, `gce-identity:sha256:${createHash('sha256').update(JSON.stringify([
    compositionScope.projectNumber, compositionNode.zone, compositionNode.instanceName, compositionNode.numericInstanceId
  ])).digest('hex')}`)
  assert.match(first.record.observedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  assert.match(first.record.observationDigest, /^[0-9a-f]{64}$/)
  assert.equal(first.record.kubernetesEvidenceRef, `kubernetes-pod-auth:sha256:${'a'.repeat(64)}`)
  assert.equal(first.record.computeIdentityEvidenceRef, `compute-creation-audit:sha256:${'b'.repeat(64)}`)
  assert.equal(JSON.stringify(first).includes('synthetic-pod-bearer'), false)
  const replay = await service.record(driver.tx, originalAuthority, handle)
  assert.deepEqual(replay, first)
  assert.equal(f.calls.length, 2)
  const reads = { scope: 0, owner: 0, term: 0 }
  const onlyOnce = (key: keyof typeof reads): string => {
    if (++reads[key] > 1) {
      throw new Error('Context scalar accessor read twice')
    }
    return originalAuthority.controller[key]
  }
  const getterContext = { runtimeUnitId: originalAuthority.runtimeUnitId, operationId: originalAuthority.operationId,
    controller: { get scope() { return onlyOnce('scope') }, get owner() { return onlyOnce('owner') },
      get term() { return onlyOnce('term') } } } as GatewayContext
  const getterDriver = compositionTransaction(originalAuthority)
  const once = await service.record(getterDriver.tx, getterContext, handle)
  assert.equal(once.record.observedAt, first.record.observedAt)
  assert.deepEqual(reads, { scope: 1, owner: 1, term: 1 })
  const changed = compositionDoubles({ pod: async value => {
    const pod = compositionPod(value)
    return { ...pod, pod: { ...pod.pod, resourceVersion: 'new-observation-rv' } }
  } })
  const changedService = createExecutionTargetComposition(changed.configuration)
  const changedHandle = await changedService.prepare(compositionInput(), new AbortController().signal)
  await assert.rejects(changedService.record(driver.tx, originalAuthority, changedHandle), error =>
    error instanceof DurableDatabaseError && error.code === 'EXECUTION_TARGET_IDENTITY_CONFLICT')
})

test('input/config getter and observer failures expose stable errors without original cause', async () => {
  const f = compositionDoubles(), badConfig = { ...f.configuration,
    get projectId(): string { throw new Error('synthetic-pod-bearer') } }
  assert.throws(() => createExecutionTargetComposition(badConfig), failure('CONFIG_INVALID'))
  const service = createExecutionTargetComposition(f.configuration)
  const input = { ...compositionInput(), get expected(): never { throw new Error('synthetic-pod-bearer') } }
  await assert.rejects(service.prepare(input, new AbortController().signal), failure('INPUT_INVALID'))
  assert.equal(f.calls.length, 0)
  const errors = compositionDoubles({ pod: async () => { throw new Error('synthetic-pod-bearer') } })
  await assert.rejects(createExecutionTargetComposition(errors.configuration).prepare(compositionInput(), new AbortController().signal),
    failure('OBSERVER_FAILED'))
})
