import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { test } from 'node:test'
import { inspect } from 'node:util'
import { performance } from 'node:perf_hooks'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { RequestOptions } from 'node:https'
import { createComputeInstanceIdentityClient } from './compute-instance-identity.ts'
import type { ComputeInstanceIdentityConfiguration } from './compute-instance-identity.ts'
import { COMPUTE_INSTANCE_RESPONSE_MAX_BYTES } from './compute-instance-identity-transport.ts'
import { fixtureInput, fixtureProject, instanceResource, privateSentinel } from './compute-instance-identity-fixtures.mts'
import {
  identityWire, deferredToken, closedIdentityStreams
} from './compute-instance-identity-transport-fixtures.mts'
import type { IdentityWireScenario } from './compute-instance-identity-transport-fixtures.mts'

function clientFor(wire: ReturnType<typeof identityWire>, timeoutMs = 500) {
  return createComputeInstanceIdentityClient({ projectId: fixtureProject, timeoutMs,
    readAccessToken: async () => 'fixture-token', https: wire.holder })
}

function assertClosed(wire: ReturnType<typeof identityWire>): void {
  for (const request of wire.requests) {
    assert.equal(request.destroyed, true)
    assert.equal(request.listenerCount('error'), 0)
    assert.equal(request.listenerCount('close'), 0)
    assert.equal(request.listenerCount('response'), 0)
  }
  for (const response of wire.responses) {
    assert.equal(response.destroyed, true)
    for (const event of ['data', 'end', 'error', 'aborted', 'close']) {
      assert.equal(response.listenerCount(event), 0)
    }
  }
}

test('config/input and supplier/request references are captured before first await; receivers survive', async () => {
  const wire = identityWire({ json: instanceResource() })
  const token = deferredToken()
  class TrustedConfiguration {
    #receiver = 'trusted-private-receiver'
    projectId = fixtureProject
    timeoutMs = 500
    https = wire.holder
    readAccessToken(_signal: AbortSignal): Promise<string> {
      assert.equal(this.#receiver, 'trusted-private-receiver')
      return token.pending
    }
  }
  const config = new TrustedConfiguration()
  const client = createComputeInstanceIdentityClient(config)
  const mutable = { ...fixtureInput }
  const operation = client.observe(mutable)
  config.projectId = 'another-project'
  config.timeoutMs = 1
  config.readAccessToken = async () => { throw new Error('mutated supplier') }
  wire.holder.request = () => { throw new Error('mutated request') }
  config.https = identityWire().holder
  mutable.zone = 'us-central1-a'
  mutable.instanceName = 'replacement'
  mutable.expectedNumericInstanceId = '1'
  token.release('fixture-token')
  const result = await operation
  assert.equal(result.ok && result.observation.numericInstanceId, fixtureInput.expectedNumericInstanceId)
  assert.equal(wire.requests.length, 1)
  const options = wire.options[0]
  assert.equal(options.hostname, 'compute.googleapis.com')
  assert.equal(options.port, 443)
  assert.equal(options.protocol, 'https:')
  assert.equal(options.method, 'GET')
  assert.equal(options.rejectUnauthorized, true)
  assert.equal(options.agent, false)
  assert.equal(options.path, `/compute/v1/projects/${fixtureProject}/zones/${fixtureInput.zone}/instances/${fixtureInput.instanceName}`)
  assert.equal(wire.requests[0].body, '')
  assert.equal(Object.isFrozen(client), true)
  await closedIdentityStreams()
  assertClosed(wire)
})

test('invalid config/input fails before credentials; request extra keys cannot choose transport or authority', async () => {
  let credentials = 0
  const wire = identityWire({ json: instanceResource() })
  const base = { projectId: fixtureProject, timeoutMs: 500, https: wire.holder,
    readAccessToken: async () => {
      credentials++
      return 'fixture-token'
    } }
  for (const projectId of ['short', 'domain:project', '../project', 'project%2fmore', 'a'.repeat(31), `${fixtureProject}\n`]) {
    assert.deepEqual(await createComputeInstanceIdentityClient({ ...base, projectId }).observe(fixtureInput), {
      ok: false, error: { code: 'INVALID_CONFIGURATION' }
    })
  }
  for (const timeoutMs of [0, -1, Number.NaN, Infinity, 2_147_483_648]) {
    assert.deepEqual(await createComputeInstanceIdentityClient({ ...base, timeoutMs }).observe(fixtureInput), {
      ok: false, error: { code: 'INVALID_CONFIGURATION' }
    })
  }
  const client = createComputeInstanceIdentityClient(base)
  assert.deepEqual(await client.observe({ ...fixtureInput, expectedNumericInstanceId: '01' }), {
    ok: false, error: { code: 'INVALID_INPUT' }
  })
  assert.equal(credentials, 0)
  const extra = { ...fixtureInput, endpoint: 'http://attacker.invalid', headers: { Authorization: privateSentinel },
    https: identityWire().holder, readAccessToken: async () => privateSentinel }
  assert.equal((await client.observe(extra)).ok, true)
  assert.equal(credentials, 1)
  assert.equal(wire.options[0].hostname, 'compute.googleapis.com')
  await closedIdentityStreams()
  assertClosed(wire)
})

test('pre-aborted call never enters credentials or request and redacts abort reason', async () => {
  let credentials = 0
  const wire = identityWire()
  const controller = new AbortController()
  controller.abort(new Error(privateSentinel))
  const client = createComputeInstanceIdentityClient({ projectId: fixtureProject, timeoutMs: 500,
    readAccessToken: async () => {
      credentials++
      return 'fixture-token'
    }, https: wire.holder })
  const result = await client.observe(fixtureInput, controller.signal)
  assert.deepEqual(result, { ok: false, error: { code: 'ABORTED' } })
  assert.equal(credentials, 0)
  assert.equal(wire.requests.length, 0)
  assert.equal(inspect(result).includes(privateSentinel), false)
})

test('credential abort and deadline prevent late-token network entry and remove caller listener', async () => {
  for (const mode of ['abort', 'timeout'] as const) {
    const wire = identityWire()
    const token = deferredToken()
    const controller = new AbortController()
    let supplierSignal: AbortSignal | undefined
    const client = createComputeInstanceIdentityClient({ projectId: fixtureProject, timeoutMs: 10,
      readAccessToken(signal) {
        supplierSignal = signal
        return token.pending
      }, https: wire.holder })
    const pending = client.observe(fixtureInput, controller.signal)
    await Promise.resolve()
    if (mode === 'abort') {
      controller.abort(privateSentinel)
    }
    assert.deepEqual(await pending, { ok: false, error: { code: mode === 'abort' ? 'ABORTED' : 'TIMEOUT' } })
    assert.equal(supplierSignal?.aborted, true)
    token.release('late-fixture-token')
    await closedIdentityStreams()
    assert.equal(wire.requests.length, 0)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  }
})

test('HTTP deadline and abort destroy only owned request/response resources', async () => {
  for (const scenario of [{ neverRespond: true }, { neverEnd: true, body: '{' }]) {
    const wire = identityWire(scenario)
    assert.deepEqual(await clientFor(wire, 10).observe(fixtureInput), {
      ok: false, error: { code: 'TIMEOUT' }
    })
    await closedIdentityStreams()
    assertClosed(wire)
  }
  const wire = identityWire({ neverEnd: true, body: '{' })
  const otherWire = identityWire({ json: instanceResource() })
  const controller = new AbortController()
  const pending = clientFor(wire).observe(fixtureInput, controller.signal)
  await closedIdentityStreams()
  controller.abort(privateSentinel)
  assert.deepEqual(await pending, { ok: false, error: { code: 'ABORTED' } })
  assert.equal((await clientFor(otherWire).observe(fixtureInput)).ok, true)
  await closedIdentityStreams()
  assertClosed(wire)
  assertClosed(otherWire)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('token and synchronous transport failures expose stable codes without original cause', async () => {
  for (const supplier of [async () => { throw new Error(privateSentinel) },
    async () => '', async () => `token\r\n${privateSentinel}`, async () => `token ${privateSentinel}`]) {
    const wire = identityWire()
    const result = await createComputeInstanceIdentityClient({ projectId: fixtureProject, timeoutMs: 500,
      readAccessToken: supplier, https: wire.holder }).observe(fixtureInput)
    assert.deepEqual(result, { ok: false, error: { code: 'AUTH_FAILED' } })
    assert.equal(JSON.stringify(result).includes(privateSentinel), false)
    assert.equal(inspect(result).includes(privateSentinel), false)
    assert.equal(wire.requests.length, 0)
  }
  const wire = identityWire()
  wire.holder.request = () => { throw new Error(privateSentinel) }
  assert.deepEqual(await clientFor(wire).observe(fixtureInput), { ok: false, error: { code: 'NETWORK_ERROR' } })
})

test('HTTP status/auth/not-found/redirect remain separate; raw body is discarded without retry', async () => {
  for (const [status, code] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'],
    [301, 'REDIRECT_REJECTED'], [307, 'REDIRECT_REJECTED'], [500, 'HTTP_ERROR']] as const) {
    const wire = identityWire({ status, body: privateSentinel })
    const result = await clientFor(wire).observe(fixtureInput)
    assert.deepEqual(result, { ok: false, error: { code } })
    assert.equal(JSON.stringify(result).includes(privateSentinel), false)
    await closedIdentityStreams()
    assert.equal(wire.requests.length, 1)
    assertClosed(wire)
  }
})

test('native TLS certificate codes and network codes are distinct and redacted', async () => {
  for (const [errorCode, code] of [['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS_ERROR'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'TLS_ERROR'], ['ECONNRESET', 'NETWORK_ERROR']] as const) {
    const wire = identityWire({ errorCode })
    assert.deepEqual(await clientFor(wire).observe(fixtureInput), { ok: false, error: { code } })
    await closedIdentityStreams()
    assertClosed(wire)
  }
})

test('malformed JSON/UTF8, missing identity, mismatches, truncation and body bound are distinguished', async () => {
  const scenarios: [IdentityWireScenario, string][] = [
    [{ body: privateSentinel }, 'INVALID_JSON'], [{ body: Buffer.from([0xff]) }, 'INVALID_JSON'],
    [{ json: {} }, 'INVALID_RESPONSE'], [{ json: instanceResource({ name: 'different' }) }, 'IDENTITY_MISMATCH'],
    [{ json: instanceResource({ id: '1' }) }, 'INSTANCE_REPLACED'],
    [{ json: instanceResource(), truncated: true }, 'RESPONSE_TRUNCATED'],
    [{ responseFault: 'aborted' }, 'RESPONSE_TRUNCATED'], [{ responseFault: 'error' }, 'RESPONSE_TRUNCATED'],
    [{ responseFault: 'close' }, 'RESPONSE_TRUNCATED'],
    [{ body: 'x'.repeat(COMPUTE_INSTANCE_RESPONSE_MAX_BYTES + 1) }, 'RESPONSE_TOO_LARGE']
  ]
  for (const [scenario, code] of scenarios) {
    const wire = identityWire(scenario)
    assert.deepEqual(await clientFor(wire).observe(fixtureInput), { ok: false, error: { code } })
    await closedIdentityStreams()
    assert.equal(wire.requests.length, 1)
    assertClosed(wire)
  }
})

test('invalid function receiver/config access returns configuration failure without thrown secrets', async () => {
  const config = { get projectId(): string { throw new Error(privateSentinel) } } as ComputeInstanceIdentityConfiguration
  const client = createComputeInstanceIdentityClient(config)
  assert.deepEqual(await client.observe(fixtureInput), { ok: false, error: { code: 'INVALID_CONFIGURATION' } })
})

test('monotonic deadline rejects synchronous supplier and end-listener overrun before timer dispatch', async t => {
  const timeoutMs = 5
  const wait = new Int32Array(new SharedArrayBuffer(4))
  for (const boundary of ['supplier', 'response-end'] as const) {
    const wire = identityWire({ json: instanceResource() })
    let timerDispatched = false
    let elapsed = 0
    const marker = setTimeout(() => { timerDispatched = true }, 0)
    const blockPastDeadline = (): void => {
      const start = performance.now()
      Atomics.wait(wait, 0, 0, 25)
      elapsed = performance.now() - start
    }
    if (boundary === 'response-end') {
      const request = wire.holder.request.bind(wire.holder)
      wire.holder.request = function (options: RequestOptions,
        callback: (message: IncomingMessage) => void): ClientRequest {
        return request(options, message => {
          message.prependOnceListener('end', blockPastDeadline)
          callback(message)
        })
      } as typeof request
    }
    const client = createComputeInstanceIdentityClient({ projectId: fixtureProject, timeoutMs,
      readAccessToken() {
        if (boundary === 'supplier') {
          blockPastDeadline()
        }
        return Promise.resolve('fixture-token')
      }, https: wire.holder })
    try {
      const result = await client.observe(fixtureInput)
      t.diagnostic(JSON.stringify({ boundary, elapsedMs: elapsed, timeoutMs, timerDispatched,
        requests: wire.requests.length }))
      assert.deepEqual(result, { ok: false, error: { code: 'TIMEOUT' } })
      assert.equal(elapsed >= timeoutMs, true)
      assert.equal(timerDispatched, false)
      assert.equal(wire.requests.length, boundary === 'supplier' ? 0 : 1)
    } finally {
      clearTimeout(marker)
    }
    await closedIdentityStreams()
    assertClosed(wire)
  }
})
