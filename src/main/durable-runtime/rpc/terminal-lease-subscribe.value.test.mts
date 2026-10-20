import assert from 'node:assert/strict'
import test from 'node:test'
import { RuntimeSubscriptionRegistry } from '../../runtime/runtime-subscription-registry.ts'
import { holdCatalogTerminalInputLease } from './terminal-lease-subscribe.ts'

function harness() {
  const registry = new RuntimeSubscriptionRegistry(), frames: unknown[] = []
  const controller = new AbortController()
  const context = { connectionId: 'conn', signal: controller.signal,
    runtime: { registerOwnedSubscriptionCleanup: registry.registerOwned.bind(registry) } }
  const run = holdCatalogTerminalInputLease({ terminal: 'term_durable', client: { id: 'phone', type: 'mobile' } }, context as never,
    frame => { frames.push(frame) })
  return { registry, frames, controller, run }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('an authorized durable subscription holds its stream until terminal.unsubscribe retires it', async () => {
  const h = harness()
  await tick()
  assert.deepEqual(h.frames, [{ type: 'subscribed', streamId: null, lines: [], truncated: false }])
  assert.equal(h.registry.cleanupIfOwnedByConnection('term_durable:phone', 'other-conn'), false)
  assert.equal(h.registry.cleanupIfOwnedByConnection('term_durable:phone', 'conn'), true)
  await h.run
  assert.deepEqual(h.frames.at(-1), { type: 'end' })
})

test('the lease ends with the connection', async () => {
  const h = harness()
  await tick()
  h.controller.abort()
  await h.run
  assert.deepEqual(h.frames.map(f => (f as { type: string }).type), ['subscribed', 'end'])
})
