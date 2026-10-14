import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { createServer } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { LOCAL_HTTPS_TEST_CERTIFICATE, LOCAL_HTTPS_TEST_PRIVATE_KEY } from '../../browser/browser-local-https-test-certificate.ts'
import { createKubernetesInventoryTransport, KubernetesInventoryError, type KubernetesInventoryConfig } from './kubernetes-inventory.ts'
import { recoverListWatch } from './watch.ts'

// Synthetic loopback control only. These three cases do not qualify cluster
// access, RBAC, HA, writer termination, a real token issuer, or provider execution.
const namespace = 'fixture-inventory', dataset = 'fixture-dataset'
const unitId = '10000000-0000-4000-8000-000000000001'
const operationId = '20000000-0000-4000-8000-000000000001'
const firstUid = '30000000-0000-4000-8000-000000000001'
const replacementUid = '30000000-0000-4000-8000-000000000002'
const podPath = `/api/v1/namespaces/${namespace}/pods`
const selector = `orca.dev/role=runtime-agent,orca.dev/dataset=${dataset}`

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
function pod(uid = firstUid, resourceVersion = 'item-rv', name = 'fixture-pod') {
  return { apiVersion: 'v1', kind: 'Pod', metadata: { namespace, name, uid, resourceVersion,
    labels: { 'orca.dev/role': 'runtime-agent', 'orca.dev/dataset': dataset, 'orca.dev/runtime-unit': unitId },
    annotations: { 'orca.dev/operation-id': operationId, 'orca.dev/execution-epoch': '9223372036854775807',
      'orca.dev/spec-hash': 'a'.repeat(64) } } }
}
function page(items: unknown[], resourceVersion = 'collection-rv', continuation = '') {
  return { apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion, continue: continuation }, items }
}
function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}
function line(type: string, object: unknown): string { return `${JSON.stringify({ type, object })}\n` }
function rejected(code: string) {
  return (error: unknown) => error instanceof KubernetesInventoryError && error.code === code
}
async function drained(sockets: Set<Socket>): Promise<void> {
  const until = Date.now() + 2000
  while (sockets.size && Date.now() < until) { await delay(5) }
  assert.equal(sockets.size, 0, '소유 loopback socket이 닫혀야 한다.')
}
async function harness(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const sockets = new Set<Socket>(), errors: unknown[] = []
  const server = createServer({ key: LOCAL_HTTPS_TEST_PRIVATE_KEY, cert: LOCAL_HTTPS_TEST_CERTIFICATE }, (request, response) => {
    // Late writes after an intentionally cancelled socket are fixture activity.
    response.on('error', () => {})
    try { handler(request, response) } catch (error) { errors.push(error); json(response, {}, 500) }
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const config = {
    apiOrigin: `https://127.0.0.1:${address.port}`, ca: Buffer.from(LOCAL_HTTPS_TEST_CERTIFICATE),
    namespace, dataset, requestTimeoutMs: 1000, watchTimeoutSeconds: 1, listLimit: 1,
    readBearerToken: () => 'fixture-synthetic-token'
  }
  return { config, sockets, errors, async close() {
    for (const socket of sockets) { socket.destroy() }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    assert.deepEqual(errors, [])
  } }
}

test('1. HTTPS pagination/RV/selector/GET, 토큰 회전과 caller mutation 격리', async () => {
  const seen: { url: URL; authorization: string | undefined }[] = []
  let currentToken = 'fixture-synthetic-first', mode = 'normal', pages = 0, reads = 0
  const gate = deferred<void>()
  const h = await harness((request, response) => {
    const url = new URL(request.url ?? '', 'https://fixture.invalid')
    seen.push({ url, authorization: request.headers.authorization })
    if (url.pathname !== podPath) {
      json(response, pod(), url.pathname.endsWith('/absent') ? 404 : 200)
      return
    }
    pages++
    currentToken = 'fixture-synthetic-rotated'
    if (mode === 'gone' && pages === 2) { json(response, {}, 410); return }
    const rv = mode === 'changed' && pages === 2 ? 'another-collection-rv' : 'collection-rv'
    json(response, page([pod(pages === 1 ? firstUid : replacementUid, `item-${pages}`,
      pages === 1 ? 'fixture-pod' : 'fixture-second')], rv, pages === 1 || mode === 'repeat' ? 'opaque+/continuation' : ''))
  })
  try {
    const input = { ...h.config, async readBearerToken(this: Readonly<KubernetesInventoryConfig>) {
      reads++
      assert.equal(this.namespace, namespace)
      if (reads === 1) { await gate.promise }
      assert.equal(this.dataset, dataset)
      return currentToken
    } }
    const transport = createKubernetesInventoryTransport(input)
    const pending = transport.list(new AbortController().signal)
    input.namespace = 'mutated-namespace'
    input.dataset = 'mutated-dataset'
    input.apiOrigin = 'https://changed.invalid'
    input.ca.fill(0)
    input.readBearerToken = async () => 'fixture-replaced-function'
    gate.resolve()
    const result = await pending
    assert.equal(result.resourceVersion, 'collection-rv')
    assert.deepEqual(result.objects.map(object => object.resourceVersion), ['item-1', 'item-2'])
    assert.equal(seen.length, 2)
    assert.deepEqual(seen.map(entry => entry.authorization), ['Bearer fixture-synthetic-first', 'Bearer fixture-synthetic-rotated'])
    assert.equal(seen[1].url.searchParams.get('continue'), 'opaque+/continuation')
    for (const entry of seen) {
      assert.equal(entry.url.pathname, podPath)
      assert.equal(entry.url.searchParams.get('labelSelector'), selector)
      assert.equal(entry.url.searchParams.get('limit'), '1')
      assert.equal(entry.url.searchParams.has('resourceVersion'), false)
      assert.equal(entry.url.searchParams.has('token'), false)
    }
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.objects) && Object.isFrozen(result.objects[0]))
    assert.equal(Reflect.set(result.objects[0], 'uid', 'altered'), false)
    const get = await transport.get(namespace, 'fixture-pod', new AbortController().signal)
    assert.equal(get?.uid, firstUid)
    assert.equal(await transport.get(namespace, 'absent', new AbortController().signal), null)
    const before = seen.length
    await assert.rejects(transport.get('other', 'fixture-pod', new AbortController().signal), rejected('IDENTITY_INVALID'))
    assert.equal(seen.length, before)
    for (const failure of ['changed', 'repeat', 'gone']) {
      mode = failure; pages = 0
      await assert.rejects(transport.list(new AbortController().signal), rejected(
        failure === 'changed' ? 'LIST_VERSION_CHANGED' : failure === 'repeat' ? 'CONTINUE_REPEATED' : 'HTTP_FAILED'))
      assert.equal(pages, 2, '실패 뒤 pagination/retry를 추가하지 않는다.')
    }
    await drained(h.sockets)
  } finally { await h.close() }
})

test('2. HTTPS chunk/UTF8/bookmark/UID/410/단절과 기존 recoverListWatch 연결', async () => {
  let mode = 'chunks', lists = 0, watches = 0
  const h = await harness((request, response) => {
    const url = new URL(request.url ?? '', 'https://fixture.invalid')
    if (url.searchParams.get('watch') !== 'true') {
      lists++
      json(response, page([pod(lists === 1 ? firstUid : replacementUid)], `list-${lists}`))
      return
    }
    watches++
    assert.equal(url.searchParams.get('labelSelector'), selector)
    assert.equal(url.searchParams.get('allowWatchBookmarks'), 'true')
    assert.equal(url.searchParams.get('timeoutSeconds'), '1')
    assert.equal(url.searchParams.get('resourceVersion'), mode === 'recover' ? `list-${watches}` : 'opaque-start-rv')
    if (mode === 'http410' || (mode === 'recover' && watches === 1)) { json(response, {}, 410); return }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    if (mode === 'empty') { response.end(); return }
    const first = line('ADDED', pod(firstUid, 'event-1'))
    if (mode === 'status410') {
      response.end(first + line('ERROR', { apiVersion: 'v1', kind: 'Status', code: 410 }))
      return
    }
    if (mode === 'partial') { response.end(`${first}{"type":"MOD`); return }
    if (mode === 'disconnect') {
      response.write(first, () => { setTimeout(() => response.destroy(), 10) })
      return
    }
    const bytes = Buffer.from(first + line('MODIFIED', pod(firstUid, 'event-2')) +
      line('ADDED', pod(replacementUid, 'event-3')) + line('DELETED', pod(firstUid, 'event-4')) +
      line('BOOKMARK', { apiVersion: 'v1', kind: 'Pod', metadata: { resourceVersion: 'rv-책갈피' } }))
    // Explicit split inside UTF-8 and across JSON/line boundaries, not object mocks.
    const split = bytes.indexOf(Buffer.from('책')) + 1
    response.write(bytes.subarray(0, 3))
    setImmediate(() => {
      response.write(bytes.subarray(3, split))
      setImmediate(() => response.end(bytes.subarray(split)))
    })
  })
  try {
    const transport = createKubernetesInventoryTransport(h.config), signal = new AbortController().signal
    const watched = await transport.watch('opaque-start-rv', signal)
    assert.equal(watched.status, 'EVENTS')
    assert.equal(watched.resourceVersion, 'rv-책갈피')
    assert.equal(watched.events.length, 5)
    assert.ok(Object.isFrozen(watched.events) && watched.events.every(Object.isFrozen))
    for (const failure of ['http410', 'status410', 'partial', 'disconnect', 'empty']) {
      mode = failure
      const observed = await transport.watch('opaque-start-rv', signal)
      assert.equal(observed.status, failure.endsWith('410') ? 'EXPIRED_410' : failure === 'empty' ? 'EVENTS' : 'DISCONNECTED')
      assert.equal(observed.events.length, ['status410', 'partial', 'disconnect'].includes(failure) ? 1 : 0)
      assert.equal(observed.resourceVersion, observed.events.length ? 'event-1' : 'opaque-start-rv')
    }
    mode = 'recover'; lists = 0; watches = 0
    const recovered = await recoverListWatch({
      list: () => transport.list(signal), watch: rv => transport.watch(rv, signal),
      get: (ns, name) => transport.get(ns, name, signal)
    })
    assert.equal(recovered.status, 'OBSERVED')
    if (recovered.status !== 'OBSERVED') { assert.fail('기존 유한 복구가 관측 결과를 반환해야 한다.') }
    assert.equal(recovered.relisted, true)
    assert.equal(lists, 2); assert.equal(watches, 2)
    assert.deepEqual(recovered.objects.map(object => object.uid), [replacementUid])
    assert.equal(recovered.history.filter(event => event.type === 'DELETED').length, 1)
    await drained(h.sockets)
  } finally { await h.close() }
})

test('3. HTTPS 403/500/identity/abort/timeout, 늦은 응답과 소유 socket 정리', async () => {
  let mode = '403', requests = 0
  let entered = deferred<void>()
  let lateResponse: ServerResponse | undefined
  const h = await harness((_request, response) => {
    requests++
    if (mode === '403' || mode === '500' || mode === 'redirect') {
      json(response, {}, mode === 'redirect' ? 302 : Number(mode)); return
    }
    if (mode === 'json') { response.end('{broken'); return }
    if (mode === 'identity') {
      const invalid = pod(); invalid.metadata.labels['orca.dev/runtime-unit'] = 'not-a-unit-uuid'
      json(response, page([invalid])); return
    }
    if (mode === 'scope') { const invalid = pod(); invalid.metadata.namespace = 'other'; json(response, invalid); return }
    if (mode === 'watch-error') { response.end(line('ERROR', { apiVersion: 'v1', kind: 'Status', code: 500 })); return }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.flushHeaders()
    lateResponse = response
    entered.resolve()
  })
  try {
    const transport = createKubernetesInventoryTransport(h.config), signal = new AbortController().signal
    for (const failure of ['403', '500', 'redirect']) {
      mode = failure
      await assert.rejects(transport.list(signal), rejected('HTTP_FAILED'))
      await assert.rejects(transport.get(namespace, 'fixture-pod', signal), rejected('HTTP_FAILED'))
      await assert.rejects(transport.watch('rv', signal), rejected('HTTP_FAILED'))
    }
    mode = 'json'; await assert.rejects(transport.list(signal), rejected('JSON_INVALID'))
    mode = 'identity'; await assert.rejects(transport.list(signal), rejected('IDENTITY_INVALID'))
    mode = 'scope'; await assert.rejects(transport.get(namespace, 'fixture-pod', signal), rejected('IDENTITY_INVALID'))
    mode = 'watch-error'; await assert.rejects(transport.watch('rv', signal), rejected('WATCH_FAILED'))
    for (const origin of ['http://127.0.0.1', 'https://user:pass@fixture.invalid', 'https://fixture.invalid/path',
      'https://fixture.invalid/?q=1', 'https://fixture.invalid/#hash']) {
      assert.throws(() => createKubernetesInventoryTransport({ ...h.config, apiOrigin: origin }), rejected('CONFIG_INVALID'))
    }
    let tokenReads = 0
    const tokenGate = deferred<string>()
    const gated = createKubernetesInventoryTransport({ ...h.config,
      readBearerToken: async () => { tokenReads++; return tokenGate.promise } })
    const before = requests, already = new AbortController()
    already.abort()
    await assert.rejects(gated.list(already.signal), rejected('ABORTED'))
    assert.equal(tokenReads, 0)
    const waiting = new AbortController(), waitJob = gated.list(waiting.signal)
    waiting.abort()
    await assert.rejects(waitJob, rejected('ABORTED'))
    tokenGate.resolve('fixture-synthetic-late-token')
    await delay(5)
    assert.equal(requests, before)
    assert.equal(getEventListeners(waiting.signal, 'abort').length, 0)
    mode = 'hang'; entered = deferred<void>()
    const during = new AbortController(), abortJob = transport.watch('rv', during.signal)
    await entered.promise
    during.abort()
    await assert.rejects(abortJob, rejected('ABORTED'))
    lateResponse?.end(line('ADDED', pod()))
    assert.equal(getEventListeners(during.signal, 'abort').length, 0)
    await drained(h.sockets)
    const timed = createKubernetesInventoryTransport({ ...h.config, requestTimeoutMs: 50 })
    const budgetSignal = new AbortController().signal
    await assert.rejects(timed.get(namespace, 'fixture-pod', budgetSignal), rejected('REQUEST_TIMEOUT'))
    assert.equal(getEventListeners(budgetSignal, 'abort').length, 0)
    await drained(h.sockets)
    const stalled = createKubernetesInventoryTransport({ ...h.config, requestTimeoutMs: 20,
      readBearerToken: () => new Promise<string>(() => {}) })
    const beforeStall = requests
    await assert.rejects(stalled.list(signal), rejected('REQUEST_TIMEOUT'))
    assert.equal(requests, beforeStall)
  } finally { await h.close() }
})
