import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import type { AgentSessionHistoryResult, AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { captureDurableCatalogReadConfig } from './config.ts'
import { createCatalogStructuredSubscriptions, type StructuredHistoryReadInput } from './structured-subscriptions.ts'
import { fixtureConfig, fixtureContext, fixtureRuntime, deferred } from './fixture-support.mts'
import { RuntimeSubscriptionRegistry } from '../../runtime/runtime-subscription-registry'

if (process.env.ORCA_STRUCTURED_SUBSCRIBE_SOURCE_APPROVED !== 'root-source-reviewed') {
  throw new Error('Root source review required; this fixture has not run')
}

await test('값 1개: 원 wire·직렬 drain·원 receiver·같은 cursor와 fence·cleanup·늦은 결과를 구분합니다', async () => {
  let head = 0, observedFence = 1, enabled = true, queries = 0, activeReads = 0, maximumReads = 0
  const calls: unknown[] = [], captured: StructuredHistoryReadInput[] = [], frames: AgentSessionSubscribeEvent[] = []
  const errors: unknown[] = []
  // Synthetic Pool value seam only: no connection, authority, real PG or producer is created.
  const target = { connect() { throw new Error('No PG in value fixture') }, async query() {
    assert.equal(this, target); queries++
    return { rows: [{ public_session_id: 'synthetic-session', session_id: 'synthetic-internal',
      journal_epoch: '0', next_event_seq: String(head + 1), session_fence: String(observedFence),
      workspace_revision: '1', deleted_at: null, catalog: 'synthetic-head' }] }
  } }
  const pool = target as unknown as Pool
  const config = captureDurableCatalogReadConfig({ ...fixtureConfig(pool), pollIntervalMs: 60000 })
  const owner = fixtureRuntime()
  const registry = new RuntimeSubscriptionRegistry()
  const runtime = new Proxy(owner.runtime, { get(object, key, receiver) {
    if (key === 'registerOwnedSubscriptionCleanup') { return registry.registerOwned.bind(registry) }
    if (key === 'registerSubscriptionCleanup') { return registry.register.bind(registry) }
    if (key === 'cleanupSubscription') { return registry.cleanup.bind(registry) }
    if (key === 'getClientSettings') { return () => ({ experimentalStructuredNativeChat: enabled }) }
    return Reflect.get(object, key, receiver)
  } })
  const context = fixtureContext(runtime, { requestId: 'frame-one',
    clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY], reportSubscriptionError(error) { assert.equal(this, context); errors.push(error) } })
  const initial = deferred<AgentSessionHistoryResult>()
  let waiting: ReturnType<typeof deferred<AgentSessionHistoryResult>> | null = initial
  const history = { capture(input: StructuredHistoryReadInput) {
    assert.equal(this, history); captured.push(input)
    return async (request: unknown): Promise<AgentSessionHistoryResult> => {
      calls.push(request); activeReads++; maximumReads = Math.max(maximumReads, activeReads)
      const gate = waiting; waiting = null
      try { return gate ? await gate.promise : page(head) } finally { activeReads-- }
    }
  } }
  function page(sequence: number, fence = observedFence): AgentSessionHistoryResult {
    const cursor = { epoch: '0', sequence }
    return { ok: true, page: { sessionId: 'synthetic-session', epoch: '0', fence, direction: 'tail',
      items: [], removedItemIds: [], submissions: [], window: { oldest: null, newest: null, nextCursor: cursor },
      liveCursor: cursor, hasOlder: false, hasNewer: false } }
  }
  const source = createCatalogStructuredSubscriptions(config, history)
  try {
    const mutable = { sessionId: 'synthetic-session' }
    const start = source.subscribe(mutable, context, frame => frames.push(frame))
    mutable.sessionId = 'replacement'; context.authenticatedCallerFingerprint = 'b'.repeat(64)
    context.requestId = 'replacement'; context.clientCapabilities = []; history.capture = () => { throw new Error('Replacement capture must not run') }
    initial.resolve(page(0)); await start
    assert.equal(frames[0].type, 'snapshot'); assert.equal(captured[0].sessionId, 'synthetic-session')
    assert.equal(captured[0].authenticatedCallerFingerprint, 'a'.repeat(64)); assert.ok(Object.isFrozen(captured[0].clientCapabilities))
    assert.throws(() => source.unsubscribe({ sessionId: 'synthetic-session', unknown: true }, context))
    // Unknown first poll baseline must reread; unchanged cursor/fence does not emit a second frame.
    await source.flush(); assert.equal(frames.length, 1); assert.equal(calls.length, 2)
    const stalled = deferred<AgentSessionHistoryResult>(); waiting = stalled; head = 1
    const one = source.flush(); await Promise.resolve()
    head = 2; const two = source.flush(); await Promise.resolve()
    assert.equal(maximumReads, 1)
    stalled.resolve(page(1)); await Promise.all([one, two])
    await source.flush()
    assert.equal(maximumReads, 1); assert.equal(frames.at(-1)?.type, 'batch')
    const atSameHead = frames.length
    await source.flush(); assert.equal(frames.length, atSameHead)
    const sameCursor = frames.at(-1)
    observedFence++
    await source.flush()
    const checkpoint = frames.at(-1)
    assert.equal(checkpoint?.type, 'batch')
    if (sameCursor?.type !== 'batch' || checkpoint?.type !== 'batch') { throw new Error('Expected fence checkpoint batch') }
    assert.deepEqual(checkpoint.batch.cursor, sameCursor.batch.cursor)
    assert.equal(checkpoint.fence, observedFence)
    const fresh = fixtureContext(runtime, { requestId: 'frame-two', clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
      reportSubscriptionError: error => errors.push(error) })
    const sibling: AgentSessionSubscribeEvent[] = []
    await source.subscribe({ sessionId: 'synthetic-session', cursor: { epoch: '0', sequence: head } }, fresh, frame => sibling.push(frame))
    assert.equal(sibling[0].type, 'batch', 'caught-up initial cursor gets a checkpoint')
    const beforeQueries = queries
    await source.flush(); assert.equal(queries, beforeQueries + 1, 'two Session listeners share one head query')
    // Both original policy/capability and original settings receiver were captured before await.
    context.authenticatedCallerFingerprint = 'a'.repeat(64); context.clientCapabilities = [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
    enabled = false
    source.unsubscribe({ sessionId: 'synthetic-session', subscriptionId: 'agentSession:synthetic-connection:synthetic-session:frame-one' }, context)
    assert.equal(frames.at(-1)?.type, 'end'); assert.notEqual(sibling.at(-1)?.type, 'end')
    const late = deferred<AgentSessionHistoryResult>(); waiting = late; head++
    const pending = source.flush(); await Promise.resolve()
    source.dispose(); source.dispose()
    const closedAt = sibling.length
    late.resolve(page(head)); await pending
    assert.equal(sibling.length, closedAt); assert.equal(sibling.at(-1)?.type, 'end')
    const noListeners = queries; await source.flush(); assert.equal(queries, noListeners)
    assert.equal(owner.cleanups.size, 0); assert.deepEqual(errors, []); assert.deepEqual(owner.unexpected, [])
  } finally { source.dispose() }
  // A throwing sink reports/cleans only its stream; the shared publisher stays usable.
  enabled = true; head = 0
  const separate = createCatalogStructuredSubscriptions(config, { capture: () => async () => page(head) })
  const good: AgentSessionSubscribeEvent[] = []
  const a = fixtureContext(runtime, { requestId: 'good', clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] })
  const b = fixtureContext(runtime, { requestId: 'bad', clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY], reportSubscriptionError: error => errors.push(error) })
  let throwing = false
  try {
    await separate.subscribe({ sessionId: 'synthetic-session' }, a, frame => good.push(frame))
    await separate.subscribe({ sessionId: 'synthetic-session' }, b, () => { if (throwing) { throw new Error('Synthetic sink failure') } })
    await separate.flush(); throwing = true; head++
    await separate.flush(); assert.equal(errors.length, 1); assert.equal(good.at(-1)?.type, 'batch')
  } finally { separate.dispose() }
})
