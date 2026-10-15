import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { createComputeDeletionAuditClient } from './compute-deletion-audit.ts'
import { deletionEntries, fixtureInput, privateSentinel } from './compute-deletion-audit-fixtures.mts'
import { auditWire, closedStreams } from './compute-deletion-audit-transport-fixtures.mts'

function tokenProvider() {
  return {
    receiver: 'trusted-operator',
    async getAccessToken(_signal: AbortSignal): Promise<string> {
      assert.equal(this.receiver, 'trusted-operator')
      return 'fixture-token'
    }
  }
}

function holdEventLoopPastDeadline(): void {
  const until = performance.now() + 25
  let now = performance.now()
  while (now < until) {
    now = performance.now()
  }
}

test('production URL/method/TLS are fixed; config, input and suppliers are snapshotted before await', async () => {
  const wire = auditWire({ json: { entries: deletionEntries(), ignoredSecret: privateSentinel } })
  let release: (token: string) => void = () => assert.fail('token supplier not entered')
  const pending = new Promise<string>(resolve => { release = resolve })
  const provider = { receiver: true, getAccessToken: async function (_signal: AbortSignal) {
    assert.equal(this.receiver, true)
    return pending
  } }
  const config = { tokenProvider: provider, timeoutMs: 500, https: wire.holder }
  const client = createComputeDeletionAuditClient(config)
  const mutable = { ...fixtureInput, scope: { ...fixtureInput.scope } }
  const operation = client.observe(mutable)
  config.timeoutMs = 1
  config.tokenProvider = { receiver: false, getAccessToken: async () => 'mutated-token' }
  mutable.scope.projectId = 'different-project'
  mutable.scope.numericInstanceId = '123'
  wire.holder.request = () => { throw new Error('mutated transport') }
  release('fixture-token')
  const result = await operation
  assert.equal(result.ok && result.observation.status, 'DELETE_OPERATION_COMPLETED')
  assert.equal(wire.requests.length, 1)
  const options = wire.options[0]
  assert.equal(options.hostname, 'logging.googleapis.com')
  assert.equal(options.port, 443)
  assert.equal(options.path, '/v2/entries:list')
  assert.equal(options.method, 'POST')
  assert.equal(options.rejectUnauthorized, true)
  assert.equal(options.agent, false)
  const body = JSON.parse(wire.requests[0].body)
  assert.deepEqual(body.resourceNames, ['projects/audit-fixture-project'])
  assert.equal(body.filter.includes('1143681254863137001'), true)
  assert.equal(JSON.stringify(result).includes(privateSentinel), false)
  await closedStreams()
  assert.equal(wire.requests[0].destroyed, true)
  assert.equal(wire.responses[0].destroyed, true)
  assert.equal(wire.requests[0].listenerCount('error'), 0)
  assert.equal(wire.responses[0].listenerCount('data'), 0)
})

test('token rejection and invalid token become stable AUTH_FAILED without raw errors', async () => {
  for (const supplier of [
    async () => { throw new Error(privateSentinel) },
    async () => `invalid\r\n${privateSentinel}`
  ]) {
    const wire = auditWire()
    const client = createComputeDeletionAuditClient({
      tokenProvider: { getAccessToken: supplier }, https: wire.holder
    })
    assert.deepEqual(await client.observe(fixtureInput), { ok: false, error: { code: 'AUTH_FAILED' } })
    assert.equal(wire.requests.length, 0)
  }
})

test('caller abort covers pending token and pre-abort without ever making a request', async () => {
  const wire = auditWire()
  let tokenSignal: AbortSignal | undefined
  const client = createComputeDeletionAuditClient({ tokenProvider: {
    getAccessToken(signal) {
      tokenSignal = signal
      return new Promise<string>(() => {})
    }
  }, https: wire.holder })
  const controller = new AbortController()
  const result = client.observe(fixtureInput, controller.signal)
  await Promise.resolve()
  controller.abort(privateSentinel)
  assert.deepEqual(await result, { ok: false, error: { code: 'ABORTED' } })
  assert.equal(tokenSignal?.aborted, true)
  assert.equal(wire.requests.length, 0)
  assert.deepEqual(await client.observe(fixtureInput, controller.signal), {
    ok: false, error: { code: 'ABORTED' }
  })
})

test('finite timeout includes a token that never resolves and destroys an owned waiting request', async () => {
  const tokenWire = auditWire()
  const client = createComputeDeletionAuditClient({ timeoutMs: 10,
    tokenProvider: { getAccessToken: () => new Promise<string>(() => {}) }, https: tokenWire.holder })
  assert.deepEqual(await client.observe(fixtureInput), { ok: false, error: { code: 'TIMEOUT' } })
  assert.equal(tokenWire.requests.length, 0)
  const wire = auditWire({ neverRespond: true })
  const waiting = createComputeDeletionAuditClient({ timeoutMs: 10,
    tokenProvider: tokenProvider(), https: wire.holder })
  assert.deepEqual(await waiting.observe(fixtureInput), { ok: false, error: { code: 'TIMEOUT' } })
  await closedStreams()
  assert.equal(wire.requests.length, 1)
  assert.equal(wire.requests[0].destroyed, true)
  assert.equal(wire.requests[0].listenerCount('error'), 0)
})

test('monotonic credential deadline blocks a synchronous late token before the timer runs; caller abort wins', async () => {
  for (const abortCaller of [false, true]) {
    const wire = auditWire()
    const caller = new AbortController()
    let supplierSignal: AbortSignal | undefined
    const client = createComputeDeletionAuditClient({ timeoutMs: 10, tokenProvider: {
      async getAccessToken(signal) {
        supplierSignal = signal
        holdEventLoopPastDeadline()
        assert.equal(signal.aborted, false)
        if (abortCaller) {
          caller.abort(privateSentinel)
        }
        return 'fixture-token'
      }
    }, https: wire.holder })
    assert.deepEqual(await client.observe(fixtureInput, caller.signal), {
      ok: false, error: { code: abortCaller ? 'ABORTED' : 'TIMEOUT' }
    })
    assert.equal(supplierSignal?.aborted, true)
    assert.equal(wire.requests.length, 0)
    assert.equal(wire.responses.length, 0)
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
  }
})

test('HTTP auth/redirect errors do not parse or expose the raw response and never retry', async () => {
  for (const [status, code] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'],
    [302, 'REDIRECT_REJECTED'], [500, 'HTTP_ERROR']] as const) {
    const wire = auditWire({ status, body: privateSentinel })
    const client = createComputeDeletionAuditClient({ tokenProvider: tokenProvider(), https: wire.holder })
    assert.deepEqual(await client.observe(fixtureInput), { ok: false, error: { code } })
    await closedStreams()
    assert.equal(wire.requests.length, 1)
    assert.equal(wire.responses[0].destroyed, true)
  }
})

test('TLS certificate failure and socket failure are distinguishable stable codes', async () => {
  for (const [errorCode, code] of [['DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS_ERROR'],
    ['ECONNRESET', 'NETWORK_ERROR']] as const) {
    const wire = auditWire({ errorCode })
    const client = createComputeDeletionAuditClient({ tokenProvider: tokenProvider(), https: wire.holder })
    assert.deepEqual(await client.observe(fixtureInput), { ok: false, error: { code } })
    await closedStreams()
    assert.equal(wire.requests.length, 1)
    assert.equal(wire.requests[0].listenerCount('error'), 0)
  }
})

test('truncated, oversized and invalid JSON differ from an empty successful result', async () => {
  for (const [scenario, reason] of [
    [{ json: { entries: deletionEntries() }, truncated: true }, 'RESPONSE_TRUNCATED'],
    [{ body: privateSentinel.repeat(100) }, 'RESPONSE_BYTE_LIMIT']
  ] as const) {
    const wire = auditWire(scenario)
    const client = createComputeDeletionAuditClient({ tokenProvider: tokenProvider(),
      maxResponseBytes: 'truncated' in scenario && scenario.truncated ? 100_000 : 10, https: wire.holder })
    assert.deepEqual(await client.observe(fixtureInput), {
      ok: true, observation: { status: 'INCOMPLETE', reason }
    })
    await closedStreams()
    assert.equal(wire.requests.length, 1)
  }
  const wire = auditWire({ body: privateSentinel })
  assert.deepEqual(await createComputeDeletionAuditClient({
    tokenProvider: tokenProvider(), https: wire.holder
  }).observe(fixtureInput), { ok: false, error: { code: 'INVALID_JSON' } })
})

test('next page is unconditionally incomplete; no follow-up request is issued', async () => {
  const wire = auditWire({ json: { entries: deletionEntries(), nextPageToken: privateSentinel } })
  const client = createComputeDeletionAuditClient({ tokenProvider: tokenProvider(), https: wire.holder })
  assert.deepEqual(await client.observe(fixtureInput), {
    ok: true, observation: { status: 'INCOMPLETE', reason: 'NEXT_PAGE_PRESENT' }
  })
  assert.equal(wire.requests.length, 1)
})
