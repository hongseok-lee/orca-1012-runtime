import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { deferred, harness, reviewerToken } from '../runtime/kubernetes-pod-auth-fixtures.mts'
import { createManagedLeafCredentialReader, ManagedLeafCredentialError } from './managed-leaf-credential.ts'
import type { ManagedLeafCredentialConfig } from './managed-leaf-credential.ts'

const uid = 'synthetic-collector-uid', subject = 'system:serviceaccount:orca-dev:orca-storage-collector'
function token(claims: unknown = { sub: subject, 'kubernetes.io': { serviceaccount: { uid } } }): string {
  // Synthetic unsigned fixture bytes only; no real credential or independent signature verification.
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.${Buffer.from('synthetic-signature').toString('base64url')}`
}
function response() {
  return { apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest',
    metadata: { namespace: 'orca-dev', name: 'orca-storage-collector', uid },
    status: { token: token(), expirationTimestamp: new Date(Date.now() + 600_000).toISOString() } }
}
const config = (): ManagedLeafCredentialConfig => ({ apiOrigin: 'https://kubernetes.invalid:6443', ca: Buffer.from('synthetic-ca'),
  namespace: 'orca-dev', serviceAccountName: 'orca-storage-collector', serviceAccountUid: uid,
  timeoutMs: 1000, readIssuerBearer: () => reviewerToken })
function rejected(code: string, sensitive: readonly string[] = [reviewerToken, token()]) {
  return (error: unknown) => {
    assert.ok(error instanceof ManagedLeafCredentialError); assert.equal(error.code, code)
    assert.equal('cause' in error, false)
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
    for (const value of sensitive) { assert.equal(String(error.stack).includes(value), false) }
    return true
  }
}
function holdPastDeadline(): void {
  const end = performance.now() + 25
  while (performance.now() < end) { /* Controlled synchronous supplier delay; no random sleep. */ }
}

test('fixed collector credential reader uses one unbound TokenRequest and exposes only its internal token result', async t => {
  await t.test('fixed TLS URL/body and original issuer receiver, without cache or a bound Pod', async () => {
    const issued = response(), h = harness([{ status: 201, body: issued }, { status: 200, body: issued }])
    let reads = 0
    const c = { ...config(), readIssuerBearer(this: ManagedLeafCredentialConfig) { assert.equal(this, c); reads++; return reviewerToken } }
    const reader = createManagedLeafCredentialReader(c, h.transport)
    assert.equal(Object.isFrozen(reader), true); assert.deepEqual(Object.keys(reader), ['readReviewerBearer'])
    for (let i = 0; i < 2; i++) {
      const external = new AbortController(), result = await reader.readReviewerBearer(external.signal)
      assert.ok(result === issued.status.token); assert.equal(getEventListeners(external.signal, 'abort').length, 0)
    }
    assert.equal(reads, 2); assert.equal(h.requests.length, 2)
    for (const request of h.requests) {
      assert.equal(request.url.href, 'https://kubernetes.invalid:6443/api/v1/namespaces/orca-dev/serviceaccounts/orca-storage-collector/token')
      assert.equal(request.options.method, 'POST'); assert.equal(request.options.rejectUnauthorized, true); assert.equal(request.options.agent, false)
      assert.deepEqual(request.options.ca, Buffer.from('synthetic-ca'))
      const body = JSON.parse(request.request.body ?? '{}')
      assert.deepEqual(body, { apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest',
        metadata: { name: 'orca-storage-collector', namespace: 'orca-dev', uid }, spec: { audiences: [], expirationSeconds: 600 } })
      assert.equal('boundObjectRef' in body.spec, false)
    }
    h.assertCleanup()
  })
  await t.test('config, CA, issuer method/receiver and HTTPS method are captured before supplier await', async () => {
    const gate = deferred<string>(), issued = response(), h = harness([{ status: 201, body: issued }])
    const original = h.transport.request.bind(h.transport)
    const https = { request(...args: Parameters<typeof original>) { assert.equal(this, https); return original(...args) } }
    const c = { ...config(), readIssuerBearer(this: ManagedLeafCredentialConfig) { assert.equal(this, c); return gate.promise } }
    const reader = createManagedLeafCredentialReader(c, https), external = new AbortController()
    const result = reader.readReviewerBearer(external.signal)
    Object.assign(c, { namespace: 'another', serviceAccountName: 'another', serviceAccountUid: 'another', apiOrigin: 'https://another.invalid',
      readIssuerBearer() { throw new Error(reviewerToken) } }); c.ca.fill(0)
    Object.assign(https, { request() { throw new Error(reviewerToken) } }); gate.resolve(reviewerToken)
    assert.ok(await result === issued.status.token)
    assert.deepEqual(h.requests[0]?.options.ca, Buffer.from('synthetic-ca'))
    assert.deepEqual(JSON.parse(h.requests[0]?.request.body ?? '{}').metadata, { name: 'orca-storage-collector', namespace: 'orca-dev', uid })
    assert.equal(h.requests.length, 1); h.assertCleanup()
  })
  await t.test('metadata UID and JWT subject/UID mismatch fail closed without disclosing credentials', async () => {
    const cases: { change(value: ReturnType<typeof response>): void; code: string }[] = [
      { change: v => { v.metadata.uid = 'different-uid' }, code: 'SERVICE_ACCOUNT_MISMATCH' },
      { change: v => { v.metadata.name = 'different-name' }, code: 'SERVICE_ACCOUNT_MISMATCH' },
      { change: v => { v.metadata.namespace = 'different-namespace' }, code: 'SERVICE_ACCOUNT_MISMATCH' },
      { change: v => { v.status.token = token({ sub: 'system:serviceaccount:orca-dev:another', 'kubernetes.io': { serviceaccount: { uid } } }) }, code: 'SERVICE_ACCOUNT_MISMATCH' },
      { change: v => { v.status.token = token({ sub: subject, 'kubernetes.io': { serviceaccount: { uid: 'different-uid' } } }) }, code: 'SERVICE_ACCOUNT_MISMATCH' },
      { change: v => { v.status.token = token({ sub: subject }) }, code: 'RESPONSE_INVALID' },
      { change: v => { v.status.token = '' }, code: 'RESPONSE_INVALID' },
      { change: v => { v.status.token = 'synthetic.not-json.signature' }, code: 'RESPONSE_INVALID' },
      { change: v => { v.kind = 'TokenReview' }, code: 'RESPONSE_INVALID' },
      { change: v => { v.apiVersion = 'v1' }, code: 'RESPONSE_INVALID' },
      { change: v => { v.status.expirationTimestamp = 'not-a-timestamp' }, code: 'RESPONSE_INVALID' },
      { change: v => { v.status.expirationTimestamp = '2026-02-30T12:00:00Z' }, code: 'RESPONSE_INVALID' },
      { change: v => { v.status.expirationTimestamp = new Date(Date.now() - 1000).toISOString() }, code: 'TOKEN_EXPIRED' },
      { change: v => { v.status.expirationTimestamp = new Date(Date.now() + 100).toISOString() }, code: 'TOKEN_EXPIRED' },
    ]
    for (const item of cases) {
      const issued = response(); item.change(issued)
      const h = harness([{ status: 201, body: issued }]), external = new AbortController()
      await assert.rejects(createManagedLeafCredentialReader(config(), h.transport).readReviewerBearer(external.signal),
        rejected(item.code, [reviewerToken, issued.status.token || 'synthetic-empty-token']))
      assert.equal(h.requests.length, 1); assert.equal(getEventListeners(external.signal, 'abort').length, 0); h.assertCleanup()
    }
  })
  await t.test('supplier abort/timeout and late completion make no POST and release every parent listener', async () => {
    for (const timed of [false, true]) {
      const gate = deferred<string>(), h = harness([]), external = new AbortController()
      let supplySignal: AbortSignal | undefined
      const c = { ...config(), timeoutMs: timed ? 15 : 1000, readIssuerBearer(signal: AbortSignal) { supplySignal = signal; return gate.promise } }
      const result = createManagedLeafCredentialReader(c, h.transport).readReviewerBearer(external.signal)
      if (!timed) { external.abort(new Error(reviewerToken)) }
      await assert.rejects(result, rejected(timed ? 'TIMEOUT' : 'ABORTED'))
      assert.equal(supplySignal?.aborted, true); gate.resolve(reviewerToken); await Promise.resolve(); await Promise.resolve()
      assert.equal(h.requests.length, 0); assert.equal(getEventListeners(external.signal, 'abort').length, 0); h.assertCleanup()
    }
    let reads = 0
    const external = new AbortController(), h = harness([]); external.abort()
    await assert.rejects(createManagedLeafCredentialReader({ ...config(), readIssuerBearer() { reads++; return reviewerToken } }, h.transport)
      .readReviewerBearer(external.signal), rejected('ABORTED'))
    assert.equal(reads, 0); assert.equal(h.requests.length, 0)
  })
  await t.test('monotonic deadline includes synchronous supplier delay before the timer can run', async () => {
    const h = harness([])
    await assert.rejects(createManagedLeafCredentialReader({ ...config(), timeoutMs: 10,
      readIssuerBearer() { holdPastDeadline(); return reviewerToken } }, h.transport).readReviewerBearer(new AbortController().signal), rejected('TIMEOUT'))
    assert.equal(h.requests.length, 0); h.assertCleanup()
  })
  await t.test('HTTP401/403, redirect, failed response, TLS and disconnect never reissue a token', async () => {
    for (const item of [
      { step: { status: 401 }, code: 'HTTP_FORBIDDEN' }, { step: { status: 403 }, code: 'HTTP_FORBIDDEN' },
      { step: { status: 302 }, code: 'HTTP_FAILED' }, { step: { status: 500 }, code: 'HTTP_FAILED' },
      { step: { status: 201, raw: '{invalid' }, code: 'RESPONSE_INVALID' },
      { step: { errorCode: 'ERR_TLS_CERT_ALTNAME_INVALID' }, code: 'TLS_FAILED' },
      { step: { errorCode: 'ECONNRESET' }, code: 'NETWORK_FAILED' },
    ]) {
      const h = harness([item.step]), external = new AbortController()
      await assert.rejects(createManagedLeafCredentialReader(config(), h.transport).readReviewerBearer(external.signal), rejected(item.code))
      assert.equal(h.requests.length, 1); assert.equal(getEventListeners(external.signal, 'abort').length, 0); h.assertCleanup()
    }
  })
  await t.test('abort/timeout during POST destroys its response and never makes a second request', async () => {
    for (const timed of [false, true]) {
      const h = harness([{ status: 201, stallBody: true }]), external = new AbortController()
      const result = createManagedLeafCredentialReader({ ...config(), timeoutMs: timed ? 15 : 1000 }, h.transport).readReviewerBearer(external.signal)
      await h.reached[0]?.promise
      if (!timed) { external.abort(new Error(reviewerToken)) }
      await assert.rejects(result, rejected(timed ? 'TIMEOUT' : 'ABORTED'))
      assert.equal(h.requests.length, 1); assert.equal(getEventListeners(external.signal, 'abort').length, 0); h.assertCleanup()
    }
  })
  await t.test('invalid composition and issuer rejection fail without opening HTTPS or retaining causes', async () => {
    for (const apiOrigin of ['http://kubernetes.invalid', 'https://issuer:secret@kubernetes.invalid', 'https://kubernetes.invalid/path',
      'https://kubernetes.invalid?query=1', 'https://kubernetes.invalid#fragment']) {
      assert.throws(() => createManagedLeafCredentialReader({ ...config(), apiOrigin }), rejected('CONFIG_INVALID'))
    }
    for (const change of [{ serviceAccountUid: '' }, { namespace: 'bad/namespace' }, { serviceAccountName: 'bad/name' }, { timeoutMs: 0 }]) {
      assert.throws(() => createManagedLeafCredentialReader({ ...config(), ...change }), rejected('CONFIG_INVALID'))
    }
    for (const readIssuerBearer of [() => { throw new Error(reviewerToken) }, () => Promise.reject(new Error(reviewerToken)), () => '']) {
      const h = harness([])
      await assert.rejects(createManagedLeafCredentialReader({ ...config(), readIssuerBearer }, h.transport)
        .readReviewerBearer(new AbortController().signal), rejected('ISSUER_CREDENTIAL_FAILED'))
      assert.equal(h.requests.length, 0); h.assertCleanup()
    }
  })
})
