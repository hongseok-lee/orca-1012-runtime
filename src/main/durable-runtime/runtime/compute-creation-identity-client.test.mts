import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { createComputeCreationIdentityClient } from './compute-creation-identity.ts'
import { creationEntries, creationInput, creationSentinel } from './compute-creation-identity-fixtures.mts'
import { auditWire, closedStreams } from './compute-deletion-audit-transport-fixtures.mts'

test('creation uses one fixed POST/filter and captures input accessors, token and HTTPS receivers before await', async () => {
  const wire = auditWire({ json: { entries: creationEntries() } })
  let release: (value: string) => void = () => assert.fail('token not prepared')
  const pending = new Promise<string>(resolve => { release = resolve })
  const provider = { receiver: true, getAccessToken: async function (_signal: AbortSignal) {
    assert.equal(this.receiver, true)
    return pending
  } }
  const config = { tokenProvider: provider, https: wire.holder, timeoutMs: 500 }
  const client = createComputeCreationIdentityClient(config)
  const scope = { ...creationInput.scope }, counts = new Map<string, number>()
  const count = (name: string): void => { counts.set(name, (counts.get(name) ?? 0) + 1) }
  const capturedScope = {
    get projectId() { count('projectId'); return scope.projectId },
    get projectNumber() { count('projectNumber'); return scope.projectNumber },
    get zone() { count('zone'); return scope.zone },
    get instanceName() { count('instanceName'); return scope.instanceName },
    get numericInstanceId() { count('numericInstanceId'); return scope.numericInstanceId }
  }
  const input = {
    get scope() { count('scope'); return capturedScope },
    get startTime() { count('startTime'); return creationInput.startTime },
    get endTime() { count('endTime'); return creationInput.endTime }
  }
  const resultPromise = client.observe(input)
  scope.numericInstanceId = '123'; scope.projectId = 'mutated-project'
  config.timeoutMs = 1
  config.tokenProvider = { receiver: false, getAccessToken: async () => 'mutated-token' }
  wire.holder.request = () => { throw new Error('mutated request receiver') }
  release('synthetic-creation-token')
  const result = await resultPromise
  assert.equal(result.ok && result.observation.status, 'CREATE_OPERATION_COMPLETED')
  assert.deepEqual(Array.from(counts.values()), Array.from({ length: 8 }, () => 1))
  assert.equal(wire.requests.length, 1)
  assert.equal(wire.options[0].hostname, 'logging.googleapis.com')
  assert.equal(wire.options[0].path, '/v2/entries:list')
  assert.equal(wire.options[0].method, 'POST')
  assert.equal(wire.options[0].rejectUnauthorized, true)
  const body = JSON.parse(wire.requests[0].body)
  assert.deepEqual(body.resourceNames, ['projects/creation-fixture-project'])
  assert.equal(body.pageSize, 100); assert.equal(body.orderBy, 'timestamp asc')
  assert.equal(body.pageToken, undefined)
  assert.equal(body.filter.includes('v1.compute.instances.insert'), true)
  assert.equal(body.filter.includes('18446744073709551615'), true)
  assert.equal(body.filter.includes('mutated-project'), false)
  assert.equal(JSON.stringify(result).includes(creationSentinel), false)
  await closedStreams()
  assert.ok(wire.requests[0].destroyed && wire.responses[0].destroyed)
})

test('creation caller abort wins before work and during pending token without requests or raw reason', async () => {
  const wire = auditWire(), controller = new AbortController()
  let tokenSignal: AbortSignal | undefined
  const client = createComputeCreationIdentityClient({ https: wire.holder,
    tokenProvider: { getAccessToken(signal) {
      tokenSignal = signal
      return new Promise<string>(() => {})
    } } })
  const pending = client.observe(creationInput, controller.signal)
  await Promise.resolve()
  controller.abort(creationSentinel)
  assert.deepEqual(await pending, { ok: false, error: { code: 'ABORTED' } })
  assert.equal(tokenSignal?.aborted, true)
  assert.deepEqual(await client.observe(creationInput, controller.signal), {
    ok: false, error: { code: 'ABORTED' }
  })
  assert.equal(wire.requests.length, 0)
})

test('creation rejects a late token before the first request after the shared deadline fix merges', async () => {
  const wire = auditWire({ json: { entries: creationEntries() } })
  const client = createComputeCreationIdentityClient({ https: wire.holder, timeoutMs: 10,
    tokenProvider: { async getAccessToken() {
      const until = performance.now() + 20
      // Deliberately overrun monotonic time while timer callbacks cannot run.
      while (performance.now() < until) { /* bounded synchronous supplier */ }
      return 'synthetic-late-token'
    } } })
  assert.deepEqual(await client.observe(creationInput), { ok: false, error: { code: 'TIMEOUT' } })
  assert.equal(wire.requests.length, 0)
})

test('creation rejects invalid captured input before suppliers and does not follow incomplete pages', async () => {
  const wire = auditWire({ json: { entries: creationEntries(), nextPageToken: creationSentinel } })
  let tokenCalls = 0
  const client = createComputeCreationIdentityClient({ https: wire.holder,
    tokenProvider: { async getAccessToken() { tokenCalls++; return 'synthetic-creation-token' } } })
  assert.deepEqual(await client.observe({ ...creationInput,
    scope: { ...creationInput.scope, numericInstanceId: '18446744073709551616' } }), {
    ok: false, error: { code: 'INVALID_INPUT' }
  })
  assert.equal(tokenCalls, 0); assert.equal(wire.requests.length, 0)
  assert.deepEqual(await client.observe(creationInput), {
    ok: true, observation: { status: 'INCOMPLETE', reason: 'NEXT_PAGE_PRESENT' }
  })
  assert.equal(tokenCalls, 1); assert.equal(wire.requests.length, 1)
  await closedStreams()
})
