import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { captureDurableCatalogReadConfig, CatalogReadError } from './config.ts'
import { captureCatalogReadContext } from './context.ts'
import { DurableCatalogReadAdapter } from './public.ts'
import { CATALOG_PUBLIC_READ_METHODS, CATALOG_PUBLIC_STREAM_METHODS, CATALOG_PUBLIC_CLEANUP_METHODS,
  isCatalogMethodNotConnected } from './registry.ts'
import { SharedCatalogHeadHints } from './head-hints.ts'
import { fixtureConfig, fixtureRuntime, fixtureContext, syntheticFingerprint, deferred } from './fixture-support.mts'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher.ts'
import { defineMethod, defineStreamingMethod, eraseRpcMethods, type RpcContext,
  type RpcAnyMethodDeclaration, type RpcStreamingMethodDeclaration } from '../../runtime/rpc/core.ts'
import { REPO_METHODS } from '../../runtime/rpc/methods/repo.ts'
import { WORKTREE_METHODS } from '../../runtime/rpc/methods/worktree.ts'
import { SESSION_TAB_METHODS } from '../../runtime/rpc/methods/session-tabs.ts'
import { CLIENT_UI_METHODS } from '../../runtime/rpc/methods/client-ui.ts'
import { TERMINAL_METHODS } from '../../runtime/rpc/methods/terminal.ts'
import { RuntimeRpcRequestAdmission } from '../../runtime/runtime-rpc/runtime-rpc-request-admission.ts'
import { fingerprintAuthenticatedPairingCredential } from '../../runtime/rpc/orchestration-mutation-executor.ts'

// WRITTEN, NOT EXECUTED. Root/bridge Ready handoff precedes first invocation.
if (process.env.ORCA_P116_PUBLIC_READ_APPROVED !== 'root-ready') { throw new Error('Root Ready handoff required') }
const noIo = { connect: () => { throw new Error('unexpected PG access') } } as unknown as Pool
function isStreamingDeclaration(method: RpcAnyMethodDeclaration): method is RpcStreamingMethodDeclaration {
  return 'stream' in method && method.stream === true
}

await test('server namespace, arrays and original host method are captured before I/O', () => {
  const input = fixtureConfig(noIo), allowed = ['synthetic-repo']
  const mutable = { ...input, repositoryIds: allowed, readHostIdentity() { return this.hostId } }
  const captured = captureDurableCatalogReadConfig(mutable)
  allowed.push('other-repo'); mutable.readHostIdentity = () => 'runtime:other'
  assert.deepEqual(captured.repositoryIds, ['synthetic-repo'])
  captured.assertCurrentHost()
  assert.equal(captured.pool, noIo); assert.ok(Object.isFrozen(captured.repositoryIds))
  assert.equal(captureDurableCatalogReadConfig({ ...input, pollIntervalMs: undefined }).pollIntervalMs, 1000)
})

await test('claimed payload identity and empty direct context cannot issue authority', async () => {
  const { runtime } = fixtureRuntime(), adapter = new DurableCatalogReadAdapter(fixtureConfig(noIo))
  await assert.rejects(adapter.read('repo.list', { principal: syntheticFingerprint, client: { id: syntheticFingerprint } }, { runtime }),
    (error: unknown) => error instanceof CatalogReadError && error.code === 'CATALOG_AUTHENTICATED_CALLER_REQUIRED')
  const first = captureCatalogReadContext(captureDurableCatalogReadConfig(fixtureConfig(noIo)), fixtureContext(runtime))
  const second = captureCatalogReadContext(captureDurableCatalogReadConfig({ ...fixtureConfig(noIo), datasetName: 'synthetic-other-dataset' }), fixtureContext(runtime))
  assert.notEqual(first.authority.principalId, second.authority.principalId)
  assert.deepEqual(first.authority.repositoryIds, [])
  adapter.dispose()
})

await test('existing registry names, params schemas and stream kinds stay identical; old mutations are denied', async () => {
  const { runtime, unexpected } = fixtureRuntime(), adapter = new DurableCatalogReadAdapter(fixtureConfig(noIo))
  const original = eraseRpcMethods([...REPO_METHODS, ...WORKTREE_METHODS, ...SESSION_TAB_METHODS, ...CLIENT_UI_METHODS, ...TERMINAL_METHODS])
  const bound = adapter.bind(original)
  assert.equal(bound.length, original.length)
  for (let index = 0; index < original.length; index++) {
    assert.equal(bound[index].name, original[index].name)
    assert.equal(bound[index].params, original[index].params)
    assert.equal(isStreamingDeclaration(bound[index]), isStreamingDeclaration(original[index]))
    if (isCatalogMethodNotConnected(bound[index].name) &&
      ![...CATALOG_PUBLIC_READ_METHODS, ...CATALOG_PUBLIC_STREAM_METHODS, ...CATALOG_PUBLIC_CLEANUP_METHODS].includes(bound[index].name as never)) {
      const method = bound[index]
      await assert.rejects(async () => isStreamingDeclaration(method)
        ? method.handler(undefined as never, fixtureContext(runtime), () => {})
        : method.handler(undefined as never, fixtureContext(runtime)),
        (error: unknown) => error instanceof CatalogReadError && error.code === 'CATALOG_METHOD_NOT_CONNECTED')
    }
  }
  for (const name of [...CATALOG_PUBLIC_READ_METHODS, ...CATALOG_PUBLIC_STREAM_METHODS, ...CATALOG_PUBLIC_CLEANUP_METHODS]) {
    assert.equal(bound.filter(method => method.name === name).length, 1)
  }
  assert.equal(bound.find(method => method.name === 'terminal.read'), original.find(method => method.name === 'terminal.read'))
  assert.deepEqual(unexpected, [])
  adapter.dispose()
})

await test('unary and streaming dispatch preserve fingerprint and paired device; capabilities are detached', async () => {
  const { runtime } = fixtureRuntime(), contexts: RpcContext[] = []
  const dispatcher = new RpcDispatcher({ runtime, methods: eraseRpcMethods([
    defineMethod({ name: 'repo.list', params: null, handler: (_params, context) => { contexts.push(context); return {} } }),
    defineStreamingMethod({ name: 'session.tabs.subscribeAll', params: null, handler: async (_params, context, emit) => {
      contexts.push(context); emit({ type: 'snapshots', snapshots: [] })
    } })
  ]) })
  const capabilities = [...fixtureContext(runtime).clientCapabilities!]
  const options = { authenticatedCallerFingerprint: syntheticFingerprint, pairedDeviceId: 'synthetic-device', clientCapabilities: capabilities }
  const unary = dispatcher.dispatch({ id: 'synthetic-unary', method: 'repo.list', authToken: '' }, options)
  capabilities.length = 0
  assert.equal((await unary).ok, true)
  await dispatcher.dispatchStreaming({ id: 'synthetic-stream', method: 'session.tabs.subscribeAll', authToken: '' }, () => {},
    { ...options, clientCapabilities: fixtureContext(runtime).clientCapabilities })
  for (const context of contexts) {
    assert.equal(context.authenticatedCallerFingerprint, syntheticFingerprint)
    assert.equal(context.pairedDeviceId, 'synthetic-device')
    assert.equal(context.clientCapabilities?.length, 1)
  }
  assert.equal(typeof contexts[1].reportSubscriptionError, 'function')
})

await test('shared-token admission forwards fingerprint only after the actual parseAndAuth check', async () => {
  const { runtime } = fixtureRuntime(), received: unknown[] = [], token = randomBytes(32).toString('hex')
  // Existing admission methods run on a synthetic owner; no socket/server start or live credential.
  const owner = Object.assign(Object.create(RuntimeRpcRequestAdmission.prototype) as Record<string, unknown>, {
    runtime, authToken: token, admitLongPoll: () => null, releaseLongPoll: () => {},
    dispatcher: { dispatch: async (_request: unknown, options: unknown) => { received.push(options); return { ok: true } } }
  }) as unknown as { handleMessage(raw: string): Promise<{ ok: boolean }> }
  assert.equal((await owner.handleMessage(JSON.stringify({ id: 'synthetic-rejected', method: 'repo.list', authToken: 'invalid' }))).ok, false)
  assert.deepEqual(received, [])
  assert.equal((await owner.handleMessage(JSON.stringify({ id: 'synthetic-valid', method: 'repo.list', authToken: token }))).ok, true)
  assert.deepEqual(received, [{ signal: undefined, authenticatedCallerFingerprint: fingerprintAuthenticatedPairingCredential(token) }])
})

await test('shared head poll has one query, no overlap and no pending callback after last detach', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = deferred<{ rows: unknown[] }>(); let queries = 0, callbacks = 0
  const pool = { connect: () => {}, query: () => { queries++; return pending.promise } } as unknown as Pool
  const config = captureDurableCatalogReadConfig(fixtureConfig(pool)), hints = SharedCatalogHeadHints.for(config)
  assert.equal(hints, SharedCatalogHeadHints.for(config))
  const offA = hints.forSubscriber(() => { callbacks++ }).listen(() => { callbacks++ })
  const offB = hints.forSubscriber(() => { callbacks++ }).listen(() => { callbacks++ })
  t.mock.timers.tick(10); await Promise.resolve()
  t.mock.timers.tick(100); await Promise.resolve()
  assert.equal(queries, 1)
  offA(); offB()
  pending.resolve({ rows: [{ scope: 'catalog', dataset_name: config.datasetName, publication_epoch: 'synthetic-epoch', revision: '1' }] })
  await Promise.resolve(); await Promise.resolve()
  t.mock.timers.tick(100)
  assert.equal(callbacks, 0); assert.equal(queries, 1)
})
