import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { eraseRpcMethods, isStreamingMethod, type RpcAnyMethodDeclaration } from '../../runtime/rpc/core'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../../runtime/rpc/methods/structured-agent-session'
import { SubscribeParams, UnsubscribeParams } from '../../runtime/rpc/methods/structured-agent-session-schemas'
import { RuntimeSubscriptionRegistry } from '../../runtime/runtime-subscription-registry'
import { DurableCatalogReadAdapter } from './public.ts'
import { fixtureConfig, fixtureContext, fixtureRuntime } from './fixture-support.mts'

if (process.env.ORCA_STRUCTURED_SUBSCRIBE_WIRING_APPROVED !== 'root-source-reviewed') {
  throw new Error('Root wiring source review required; this fixture has not run')
}

await test('배선 값 1개: 원 declaration·schema·capture·인증·소유 종료를 확인합니다', async () => {
  let queryCaptures = 0, queries = 0, connects = 0, poolEnds = 0
  const query = async () => { queries++; throw new Error('Unexpected PG query in wiring value fixture') }
  const target = {
    async connect() { connects++; throw new Error('Unexpected PG connect in wiring value fixture') },
    get query() { queryCaptures++; return query },
    async end() { poolEnds++ }
  }
  const pool = target as unknown as Pool
  const settings = { ...fixtureConfig(pool), readHostIdentity() { assert.equal(this, settings); return 'local' as const } }
  const adapter = new DurableCatalogReadAdapter(settings)
  const otherAdapter = new DurableCatalogReadAdapter(settings)
  const native = eraseRpcMethods(STRUCTURED_AGENT_SESSION_METHODS)
  const originalSubscribe = native.find(method => method.name === 'agentSession.subscribe')
  const originalUnsubscribe = native.find(method => method.name === 'agentSession.unsubscribe')
  assert.ok(originalSubscribe && isStreamingMethod(originalSubscribe)); assert.ok(originalUnsubscribe)
  assert.equal(originalSubscribe.params, SubscribeParams); assert.equal(originalUnsubscribe.params, UnsubscribeParams)
  // Opt-out composition keeps these original declarations; binding never edits them in place.
  const originalHandler = originalSubscribe.handler, originalCleanup = originalUnsubscribe.handler
  const capturesAtConstruction = queryCaptures
  assert.equal(capturesAtConstruction, 1, 'one captured Pool/dataset owns the shared hint query')
  const methods = adapter.bind(native), secondBinding = adapter.bind(native)
  assert.equal(queryCaptures, capturesAtConstruction, 'bind does not construct another structured owner')
  const subscribe = methods.find(method => method.name === 'agentSession.subscribe')
  const unsubscribe = methods.find(method => method.name === 'agentSession.unsubscribe')
  assert.ok(subscribe && isStreamingMethod(subscribe)); assert.ok(unsubscribe && !isStreamingMethod(unsubscribe))
  assert.equal(subscribe.params, SubscribeParams); assert.equal(unsubscribe.params, UnsubscribeParams)
  assert.notEqual(subscribe.handler, originalHandler); assert.notEqual(unsubscribe.handler, originalCleanup)
  assert.equal(native.find(method => method.name === 'agentSession.subscribe'), originalSubscribe)
  assert.equal(originalSubscribe.handler, originalHandler); assert.equal(originalUnsubscribe.handler, originalCleanup)
  assert.equal(methods.find(method => method.name === 'agentSession.options'), native.find(method => method.name === 'agentSession.options'))
  assert.equal(secondBinding.find(method => method.name === 'agentSession.subscribe')?.params, SubscribeParams)
  assert.throws(() => SubscribeParams.parse({ sessionId: 'synthetic-wiring-session', unknown: true }))
  assert.throws(() => UnsubscribeParams.parse({ sessionId: 'synthetic-wiring-session', unknown: true }))
  const wrongUnary = { ...originalSubscribe, stream: false } as unknown as RpcAnyMethodDeclaration
  const wrongStream = { ...originalUnsubscribe, stream: true } as unknown as RpcAnyMethodDeclaration
  assert.throws(() => adapter.bind([wrongUnary]), /CATALOG_METHOD_KIND_MISMATCH/)
  assert.throws(() => adapter.bind([wrongStream]), /CATALOG_METHOD_KIND_MISMATCH/)
  const owner = fixtureRuntime(), registry = new RuntimeSubscriptionRegistry(), registered = new Set<string>()
  const runtime = new Proxy(owner.runtime, { get(object, property, receiver) {
    if (property === 'getClientSettings') { return () => ({ experimentalStructuredNativeChat: true }) }
    if (property === 'registerOwnedSubscriptionCleanup') {
      return (id: string, close: () => void, connection?: string) => {
        registered.add(id)
        return registry.registerOwned(id, () => { try { close() } finally { registered.delete(id) } }, connection)
      }
    }
    if (property === 'registerSubscriptionCleanup') { return registry.register.bind(registry) }
    if (property === 'cleanupSubscription') { return registry.cleanup.bind(registry) }
    return Reflect.get(object, property, receiver)
  } })
  const context = fixtureContext(runtime, { clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] })
  const parsed = SubscribeParams.parse({ sessionId: 'synthetic-wiring-session' })
  try {
    await assert.rejects(subscribe.handler(parsed as never, { ...context, authenticatedCallerFingerprint: undefined }, () => {}), /CATALOG_AUTHENTICATED_CALLER_REQUIRED/)
    await assert.rejects(Promise.resolve().then(() => unsubscribe.handler(parsed as never, { ...context, authenticatedCallerFingerprint: undefined })), /CATALOG_AUTHENTICATED_CALLER_REQUIRED/)
    // Replace the source config after construction. The adapter must retain its original captured Pool/host method.
    settings.pool = { connect() { throw new Error('Replacement Pool must not be captured') }, query() { throw new Error('Replacement query must not be captured') } } as unknown as Pool
    settings.readHostIdentity = () => { throw new Error('Replacement host method must not be captured') }
    const aborted = new AbortController(); aborted.abort()
    const frames: unknown[] = []
    await subscribe.handler(parsed as never, { ...context, signal: aborted.signal }, event => frames.push(event))
    await registry.cleanupAndWait(`agentSession:synthetic-connection:${parsed.sessionId}:synthetic-request`)
    assert.deepEqual(frames, [{ type: 'end' }]); assert.equal(registered.size, 0)
    assert.deepEqual(await unsubscribe.handler(UnsubscribeParams.parse({ sessionId: parsed.sessionId }) as never, context), { unsubscribed: true })
    adapter.dispose(); adapter.dispose()
    await assert.rejects(subscribe.handler(parsed as never, context, () => {}), /CATALOG_ADAPTER_DISPOSED/)
    await assert.rejects(Promise.resolve().then(() => unsubscribe.handler(parsed as never, context)), /CATALOG_ADAPTER_DISPOSED/)
    const sibling = otherAdapter.bind(native).find(method => method.name === 'agentSession.unsubscribe')
    assert.ok(sibling && !isStreamingMethod(sibling))
    await assert.rejects(Promise.resolve().then(() => sibling.handler(parsed as never, { ...context, authenticatedCallerFingerprint: undefined })), /CATALOG_AUTHENTICATED_CALLER_REQUIRED/)
    assert.equal(queryCaptures, capturesAtConstruction); assert.equal(connects, 0); assert.equal(queries, 0); assert.equal(poolEnds, 0)
    assert.deepEqual(owner.unexpected, [])
  } finally { adapter.dispose(); otherAdapter.dispose() }
})
