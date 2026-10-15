import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { randomUUID } from 'node:crypto'
import { opsUiClientSource } from './client.ts'
import { renderOpsUiShell } from './shell.ts'

/** Minimal DOM for the actual serialized UI client; HTTP and stream are explicit doubles. */
class Element {
  hidden = false
  disabled = false
  open = false
  value = ''
  textContent = ''
  className = ''
  title = ''
  dataset: Record<string, string> = {}
  readonly children: unknown[] = []
  readonly listeners = new Map<string, ((event: { preventDefault(): void }) => void)[]>()
  addEventListener(name: string, callback: (event: { preventDefault(): void }) => void): void {
    const list = this.listeners.get(name) ?? []; list.push(callback); this.listeners.set(name, list)
  }
  fire(name: string): void { for (const callback of this.listeners.get(name) ?? []) { callback({ preventDefault() {} }) } }
  append(...elements: unknown[]): void { this.children.push(...elements) }
  prepend(...elements: unknown[]): void { this.children.unshift(...elements) }
  replaceChildren(...elements: unknown[]): void { this.children.splice(0, this.children.length, ...elements) }
  close(): void { this.open = false }
  showModal(): void { this.open = true }
}
function fixture(automaticStatus = 200) {
  const elements = new Map(Array.from(renderOpsUiShell().matchAll(/id="([^"]+)"/g), match => [match[1], new Element()]))
  const window = new Element(), calls: { path: string; options: RequestInit }[] = []
  let aborted = 0
  const fetch = async (path: string, options: RequestInit): Promise<Response> => {
    calls.push({ path, options })
    const authorization = new Headers(options.headers).get('Authorization')
    const status = authorization === 'Bearer synthetic-manual-key' ? 200 : automaticStatus
    if (status !== 200) { return Response.json({ error: { code: status === 401 ? 'AUTH_REQUIRED' : 'DATABASE_UNAVAILABLE' } }, { status }) }
    if (path.startsWith('/ops/v1/events/stream')) {
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        options.signal?.addEventListener('abort', () => { aborted++; controller.error(new DOMException('Aborted', 'AbortError')) }, { once: true })
      } })
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (path.startsWith('/ops/v1/runtime-units')) { return Response.json({ units: [], observedAt: null }) }
    if (path.startsWith('/ops/v1/notifications')) { return Response.json({ notifications: [], nextAfterId: null }) }
    return Response.json({ status: 'PAGE', events: [], nextCursor: { streamId: 'synthetic-stream', epoch: '1', offset: '0' } })
  }
  runInNewContext(opsUiClientSource, { document: { getElementById: (id: string) => elements.get(id) ?? null,
    querySelectorAll: () => [], createElement: () => new Element() }, window, fetch,
  AbortController, AbortSignal, DOMException, TextEncoder, TextDecoder, Headers, crypto: { randomUUID },
  btoa: (value: string) => Buffer.from(value, 'binary').toString('base64') })
  const get = (id: string): Element => { const element = elements.get(id); assert.ok(element); return element }
  return { calls, get, window, aborted: () => aborted }
}
const settle = () => new Promise<void>(resolve => { setImmediate(resolve) })

test('serialized Ops UI composes automatic and manual authentication without persisting credentials', { timeout: 10000 }, async t => {
  await t.test('initial automatic batch and SSE omit Authorization; disconnect stops subsequent automatic loads', async () => {
    const f = fixture(); await settle()
    assert.equal(f.calls.length, 4)
    assert.ok(f.calls.some(call => call.path.startsWith('/ops/v1/events/stream')))
    for (const call of f.calls) {
      assert.equal(new Headers(call.options.headers).has('Authorization'), false)
      assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.cache, 'no-store')
      assert.equal(call.options.redirect, 'error'); assert.equal(call.options.referrerPolicy, 'no-referrer')
    }
    assert.equal(f.get('connection').textContent, '연결됨')
    assert.equal(f.get('auth-panel').hidden, true)
    f.get('disconnect').fire('click'); await settle()
    const count = f.calls.length
    f.get('reload').fire('click'); f.get('status-reload').fire('click'); await settle()
    assert.equal(f.calls.length, count); assert.equal(f.get('auth-panel').hidden, false)
    assert.equal(f.get('unit-count').textContent, '미관측'); assert.equal(f.aborted(), 1)
  })
  await t.test('401 shows the manual form once; a manual key is cleared from the input and used for API plus SSE', async () => {
    const f = fixture(401); await settle()
    assert.equal(f.calls.length, 3); assert.equal(f.get('auth-panel').hidden, false)
    await settle(); assert.equal(f.calls.length, 3)
    f.get('reload').fire('click'); await settle(); assert.equal(f.calls.length, 3)
    f.get('access-key').value = 'synthetic-manual-key'; f.get('auth-form').fire('submit')
    assert.equal(f.get('access-key').value, '')
    await settle()
    const manual = f.calls.slice(3); assert.equal(manual.length, 4)
    assert.ok(manual.every(call => new Headers(call.options.headers).get('Authorization') === 'Bearer synthetic-manual-key'))
    f.window.fire('pagehide'); await settle()
    const count = f.calls.length; f.get('reload').fire('click'); await settle()
    assert.equal(f.calls.length, count); assert.equal(f.aborted(), 1)
    assert.equal(f.get('unit-count').textContent, '미관측')
  })
  await t.test('non-401 automatic failures remain errors rather than empty success or retry loops', async () => {
    const f = fixture(503); await settle()
    assert.equal(f.calls.length, 3); assert.equal(f.get('status-panel').dataset.kind, 'error')
    assert.equal(f.get('status-title').textContent, '조회에 실패했습니다')
    assert.equal(f.get('auth-panel').hidden, true)
    await settle(); assert.equal(f.calls.length, 3)
    f.get('disconnect').fire('click')
  })
})
