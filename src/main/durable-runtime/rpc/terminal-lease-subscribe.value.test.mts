import assert from 'node:assert/strict'
import test from 'node:test'
import { RuntimeSubscriptionRegistry } from '../../runtime/runtime-subscription-registry.ts'
import { createCatalogTerminalLeaseSubscribe } from './terminal-lease-subscribe.ts'

function harness(durable: boolean) {
  const registry = new RuntimeSubscriptionRegistry(), frames: unknown[] = [], legacyCalls: unknown[] = []
  const config = { assertCurrentHost() {}, pool: { query: async () => ({ rowCount: durable ? 1 : 0, rows: [] }) } }
  const subscribe = createCatalogTerminalLeaseSubscribe(config as never)
  const controller = new AbortController()
  const context = { connectionId: 'conn', signal: controller.signal,
    runtime: { registerOwnedSubscriptionCleanup: registry.registerOwned.bind(registry) } }
  const run = subscribe({ terminal: 'term_durable', client: { id: 'phone', type: 'mobile' } }, context as never,
    frame => { frames.push(frame) }, async (params: unknown) => { legacyCalls.push(params) })
  return { registry, frames, legacyCalls, controller, run }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('a durable handle grants the input lease until terminal.unsubscribe retires it', async () => {
  const h = harness(true)
  await tick()
  assert.deepEqual(h.frames, [{ type: 'subscribed', streamId: null, lines: [], truncated: false }])
  assert.equal(h.registry.cleanupIfOwnedByConnection('term_durable:phone', 'other-conn'), false)
  assert.equal(h.registry.cleanupIfOwnedByConnection('term_durable:phone', 'conn'), true)
  await h.run
  assert.deepEqual(h.frames.at(-1), { type: 'end' })
  assert.equal(h.legacyCalls.length, 0)
})

test('the lease ends with the connection', async () => {
  const h = harness(true)
  await tick()
  h.controller.abort()
  await h.run
  assert.deepEqual(h.frames.map(f => (f as { type: string }).type), ['subscribed', 'end'])
})

test('a handle that is not a durable terminal keeps the original owner', async () => {
  const h = harness(false)
  await h.run
  assert.equal(h.legacyCalls.length, 1)
  assert.deepEqual(h.frames, [])
})
