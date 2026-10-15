import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { createKubernetesPodAuthenticator, KubernetesPodAuthError } from './kubernetes-pod-auth.ts'
import type { KubernetesPodAuthConfig } from './kubernetes-pod-auth.ts'
import { config, deferred, expected, harness, node, pod, podToken, reviewerToken,
  tokenReview } from './kubernetes-pod-auth-fixtures.mts'

const rejected = (code: string) => (error: unknown) => {
  assert.ok(error instanceof KubernetesPodAuthError)
  assert.equal(error.code, code)
  for (const token of [podToken, reviewerToken]) { assert.equal(String(error.stack).includes(token), false) }
  assert.equal('cause' in error, false)
  return true
}
const input = () => ({ podBearer: podToken, expected: expected() })

function holdEventLoopPastDeadline(): void {
  const until = performance.now() + 25
  let now = performance.now()
  while (now < until) {
    now = performance.now()
  }
}

test('POST TokenReview then exact Pod and Node GET once, fixed TLS origin and separate bearer credentials', async () => {
  for (const status of [200, 201]) {
    const h = harness([{ status, body: tokenReview() }, { body: pod() }, { body: node() }])
    const signal = new AbortController().signal
    await createKubernetesPodAuthenticator(config(), h.transport).authenticatePod(input(), signal)
    assert.equal(h.requests.length, 3)
    assert.deepEqual(h.requests.map(r => r.url.pathname), ['/apis/authentication.k8s.io/v1/tokenreviews',
      '/api/v1/namespaces/agents/pods/agent-pod', '/api/v1/nodes/agent-node'])
    for (const r of h.requests) {
      assert.equal(r.url.origin, 'https://kubernetes.invalid:6443')
      assert.equal(r.options.rejectUnauthorized, true); assert.equal(r.options.agent, false)
      assert.deepEqual(r.options.ca, Buffer.from('synthetic-ca'))
      assert.deepEqual(r.options.headers, { Accept: 'application/json', Authorization: `Bearer ${reviewerToken}`,
        Connection: 'close', ...(r.options.method === 'POST' ? { 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(r.request.body ?? '') } : {}) })
    }
    assert.equal(h.requests[0]?.options.method, 'POST')
    assert.deepEqual(JSON.parse(h.requests[0]?.request.body ?? '{}'), { apiVersion: 'authentication.k8s.io/v1',
      kind: 'TokenReview', spec: { token: podToken, audiences: ['orca-runtime'] } })
    assert.deepEqual(h.requests.slice(1).map(r => [r.options.method, r.request.body]), [['GET', undefined], ['GET', undefined]])
    assert.equal(getEventListeners(signal, 'abort').length, 0); h.assertCleanup()
  }
})

test('first-await capture isolates caller, CA, expected identity and supplier/transport method replacement', async () => {
  const credentials = new WeakMap<object, string>()
  const gate = deferred<string>(), h = harness(), c = { ...config(),
    readReviewerBearer(this: Readonly<KubernetesPodAuthConfig>) {
      assert.equal(this, c); assert.equal(credentials.get(this), reviewerToken)
      assert.equal(this.namespace, 'agents')
      this.ca.fill(0)
      return gate.promise
    } }
  credentials.set(c, reviewerToken)
  const auth = createKubernetesPodAuthenticator(c, h.transport), request = input()
  const promise = auth.authenticatePod(request, new AbortController().signal)
  Object.assign(c, { apiOrigin: 'https://attacker.invalid', audience: 'another', namespace: 'another',
    readReviewerBearer: () => Promise.reject(new Error(podToken)) })
  c.ca.fill(0)
  Object.assign(request, { podBearer: 'replacement-token' }); Object.assign(request.expected, { podUid: 'replacement-pod' })
  Object.assign(h.transport, { request: () => { throw new Error('replacement transport') } })
  gate.resolve(reviewerToken)
  const result = await promise
  assert.equal(result.pod.uid, 'pod-uid'); assert.equal(result.audience, 'orca-runtime')
  assert.equal(h.requests[0]?.url.origin, 'https://kubernetes.invalid:6443')
  assert.deepEqual(h.requests[0]?.options.ca, Buffer.from('synthetic-ca'))
  assert.equal(JSON.parse(h.requests[0]?.request.body ?? '{}').spec.token, podToken)
  h.assertCleanup()
})

test('denied review, forbidden HTTP, redirects, Pod/Node 404 and malformed JSON never fall back or retry', async () => {
  const denied = tokenReview(); denied.status.authenticated = false
  const cases = [
    { steps: [{ body: denied }], code: 'AUTHENTICATION_DENIED', calls: 1 },
    { steps: [{ status: 403, body: { token: podToken } }], code: 'HTTP_FORBIDDEN', calls: 1 },
    { steps: [{ status: 302, body: { location: `https://${podToken}.invalid` } }], code: 'HTTP_FAILED', calls: 1 },
    { steps: [{ body: tokenReview() }, { status: 404 }], code: 'POD_NOT_FOUND', calls: 2 },
    { steps: [{ body: tokenReview() }, { body: pod() }, { status: 404 }], code: 'NODE_NOT_FOUND', calls: 3 },
    { steps: [{ raw: `{${podToken}` }], code: 'RESPONSE_INVALID', calls: 1 },
    { steps: [{ errorCode: 'ERR_TLS_CERT_ALTNAME_INVALID' }], code: 'TLS_FAILED', calls: 1 },
    { steps: [{ errorCode: 'ECONNRESET' }], code: 'NETWORK_FAILED', calls: 1 }
  ]
  for (const c of cases) {
    const h = harness(c.steps)
    await assert.rejects(createKubernetesPodAuthenticator(config(), h.transport)
      .authenticatePod(input(), new AbortController().signal), rejected(c.code))
    assert.equal(h.requests.length, c.calls); h.assertCleanup()
  }
})

test('supplier abort/timeout ignore late credentials, and pre-abort never calls supplier or transport', async () => {
  for (const mode of ['abort', 'timeout']) {
    const gate = deferred<string>(), h = harness(), external = new AbortController()
    let suppliedSignal: AbortSignal | undefined
    const c = { ...config(), timeoutMs: 15, readReviewerBearer(signal: AbortSignal) { suppliedSignal = signal; return gate.promise } }
    const promise = createKubernetesPodAuthenticator(c, h.transport).authenticatePod(input(), external.signal)
    if (mode === 'abort') { external.abort(new Error(podToken)) }
    await assert.rejects(promise, rejected(mode === 'abort' ? 'ABORTED' : 'TIMEOUT'))
    assert.equal(suppliedSignal?.aborted, true)
    gate.resolve(reviewerToken); await Promise.resolve(); await Promise.resolve()
    assert.equal(h.requests.length, 0); assert.equal(getEventListeners(external.signal, 'abort').length, 0)
  }
  let calls = 0
  const c = { ...config(), readReviewerBearer() { calls++; return reviewerToken } }, h = harness(), external = new AbortController()
  external.abort()
  await assert.rejects(createKubernetesPodAuthenticator(c, h.transport).authenticatePod(input(), external.signal), rejected('ABORTED'))
  assert.equal(calls, 0); assert.equal(h.requests.length, 0)
})

test('monotonic credential deadline blocks synchronous late reviewer before the timer runs; caller abort wins', async () => {
  for (const abortCaller of [false, true]) {
    const h = harness(), caller = new AbortController()
    let supplierSignal: AbortSignal | undefined
    const c = { ...config(), timeoutMs: 10, readReviewerBearer(signal: AbortSignal) {
      supplierSignal = signal
      holdEventLoopPastDeadline()
      assert.equal(signal.aborted, false)
      if (abortCaller) {
        caller.abort(new Error(podToken))
      }
      return reviewerToken
    } }
    await assert.rejects(createKubernetesPodAuthenticator(c, h.transport).authenticatePod(input(), caller.signal),
      rejected(abortCaller ? 'ABORTED' : 'TIMEOUT'))
    assert.equal(supplierSignal?.aborted, true)
    assert.equal(h.requests.length, 0)
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
    h.assertCleanup()
  }
})

test('monotonic deadline after each API response blocks the next request and final observation before timer runs', async () => {
  for (const stage of [0, 1, 2]) {
    const steps = [{ body: tokenReview() }, { body: pod() }, { body: node() }]
      .map((step, index) => index === stage ? { ...step, before: holdEventLoopPastDeadline } : step)
    const h = harness(steps), caller = new AbortController()
    await assert.rejects(createKubernetesPodAuthenticator({ ...config(), timeoutMs: 10 }, h.transport)
      .authenticatePod(input(), caller.signal), rejected('TIMEOUT'))
    assert.equal(h.requests.length, stage + 1)
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
    h.assertCleanup()
  }
})

test('abort during each of three requests releases owned request/response and parent listeners', async () => {
  for (const stage of [0, 1, 2]) {
    for (const stallBody of [false, true]) {
      const steps = [{ body: tokenReview() }, { body: pod() }, { body: node() }].slice(0, stage)
      const h = harness([...steps, { stall: !stallBody, stallBody }]), external = new AbortController()
      const promise = createKubernetesPodAuthenticator(config(), h.transport).authenticatePod(input(), external.signal)
      await h.reached[stage]?.promise
      external.abort(new Error(podToken))
      await assert.rejects(promise, rejected('ABORTED'))
      assert.equal(h.requests.length, stage + 1)
      assert.equal(getEventListeners(external.signal, 'abort').length, 0); h.assertCleanup()
    }
  }
})

test('one total timeout covers all three API waits and destroys the pending response', async () => {
  for (const stage of [0, 1, 2]) {
    const steps = [{ body: tokenReview() }, { body: pod() }, { body: node() }].slice(0, stage)
    const h = harness([...steps, { stallBody: true }]), external = new AbortController()
    const promise = createKubernetesPodAuthenticator({ ...config(), timeoutMs: 20 }, h.transport).authenticatePod(input(), external.signal)
    await h.reached[stage]?.promise
    await assert.rejects(promise, rejected('TIMEOUT'))
    assert.equal(h.requests.length, stage + 1); h.assertCleanup()
    assert.equal(getEventListeners(external.signal, 'abort').length, 0)
  }
})

test('supplier rejection and synchronous throws expose only stable credential error', async () => {
  for (const readReviewerBearer of [() => { throw new Error(podToken) }, () => Promise.reject(new Error(reviewerToken)), () => 'bad\nheader']) {
    const h = harness()
    await assert.rejects(createKubernetesPodAuthenticator({ ...config(), readReviewerBearer }, h.transport)
      .authenticatePod(input(), new AbortController().signal), rejected('REVIEWER_CREDENTIAL_FAILED'))
    assert.equal(h.requests.length, 0)
  }
})
