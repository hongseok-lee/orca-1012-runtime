import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import type { RpcAnyMethodDeclaration } from '../../runtime/rpc/core'
import { eraseRpcMethods, isStreamingMethod } from '../../runtime/rpc/core'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../../runtime/rpc/methods/structured-agent-session'
import { HoldParams } from '../../runtime/rpc/methods/structured-agent-session-schemas'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { RuntimeSubscriptionRegistry } from '../../runtime/runtime-subscription-registry'
import { DurableCatalogReadAdapter } from './public.ts'
import { deferred, fixtureConfig, fixtureContext, fixtureRuntime } from './fixture-support.mts'

if (process.env.ORCA_STRUCTURED_HOLDS_APPROVED !== 'root-delegated-first-verification') {
  throw new Error('Root delegation required before structured holds verification')
}

await test('값 1개: 실제 hold/release 배선은 관찰자 capture·연결 격리·대기 중 종료를 보존합니다', async () => {
  const sessionId = `structured_${randomUUID().replaceAll('-', '_')}`, secondSession = `${sessionId}_other`
  const internalSession = randomUUID(), workspaceId = randomUUID(), publicId = `synthetic-hold-${randomUUID()}`
  const registry = new RuntimeSubscriptionRegistry(), native = fixtureRuntime()
  const registrations: { id: string; connection?: string; calls: number; close(): void }[] = []
  let enabled = true, connects = 0, releases = 0, ends = 0, directQueries = 0
  let connectGate: ReturnType<typeof deferred<void>> | null = null
  const sqlSeen: { sql: string; values: readonly unknown[] }[] = []
  const runtimeMethods = {
    getClientSettings() { assert.equal(this, runtime); return { experimentalStructuredNativeChat: enabled } },
    registerOwnedSubscriptionCleanup(id: string, close: () => void, connection?: string) {
      assert.equal(this, runtime)
      const entry = { id, connection, calls: 0, close() { entry.calls++; close() } }
      registrations.push(entry)
      const registration = registry.registerOwned(id, entry.close, connection)
      const owner = { releaseIfCurrent() { assert.equal(this, owner); registration.releaseIfCurrent() } }
      return owner
    },
    registerSubscriptionCleanup(id: string, close: () => void, connection?: string) {
      assert.equal(this, runtime); registry.register(id, close, connection)
    },
    cleanupSubscription(id: string) { assert.equal(this, runtime); registry.cleanup(id) }
  }
  const runtime = new Proxy(native.runtime, { get(object, property, receiver) {
    return property in runtimeMethods ? Reflect.get(runtimeMethods, property, receiver) : Reflect.get(object, property, receiver)
  } })
  const workspace = { workspace_id: workspaceId, public_id: publicId, deleted_at: null, kind: 'FOLDER_WORKSPACE',
    repo_id: null, project_group_id: 'allowed-group', reserved_path: '/synthetic/hold',
    payload: { id: publicId, projectGroupId: 'allowed-group', name: 'synthetic hold', folderPath: '/synthetic/hold',
      comment: '', createdAt: 1, updatedAt: 1, lastActivityAt: 1, sortOrder: 0,
      isArchived: false, isUnread: false, isPinned: false } }
  const client = { async query(sql: string, values: readonly unknown[] = []) {
    assert.equal(this, client); sqlSeen.push({ sql, values })
    if (sql.includes('dataset_metadata')) { return { rows: [{ dataset_name: 'orca-1012-dev-v1' }], rowCount: 1 } }
    if (sql.includes('SELECT a.public_session_id')) {
      assert.ok(values[0] === sessionId || values[0] === secondSession)
      return { rows: [{ public_session_id: values[0], session_id: internalSession, workspace_id: workspaceId,
        actual_workspace_id: workspaceId, public_id: publicId, provider: 'claude', actual_provider: 'claude',
        execution_host_id: 'local', agent_dataset: 'orca-1012-dev-v1', workspace_dataset: 'orca-1012-dev-v1' }], rowCount: 1 }
    }
    if (sql.includes('catalog_workspace_metadata')) { return { rows: [workspace], rowCount: 1 } }
    if (sql.includes('workspace_aliases')) { return { rows: [], rowCount: 0 } }
    if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [], rowCount: 0, command: sql === 'COMMIT' ? 'COMMIT' : sql }
    }
    throw new Error('Unexpected SQL in focused hold value fixture')
  }, release() { assert.equal(this, client); releases++ } }
  const owner = { async connect() {
    assert.equal(this, owner); connects++
    const gate = connectGate; connectGate = null
    if (gate) { await gate.promise }
    return client
  }, async query() { directQueries++; throw new Error('Unexpected direct Pool query') }, end() { ends++ } }
  const pool = owner as unknown as Pool
  const config = { ...fixtureConfig(pool), projectGroupIds: ['allowed-group'],
    readHostIdentity() { assert.equal(this, config); return 'local' as const } }
  const adapters: DurableCatalogReadAdapter[] = []
  const declarations = eraseRpcMethods(STRUCTURED_AGENT_SESSION_METHODS)
  function bind() {
    const adapter = new DurableCatalogReadAdapter(config); adapters.push(adapter)
    const methods = adapter.bind(declarations)
    const hold = methods.find(method => method.name === 'agentSession.hold'), release = methods.find(method => method.name === 'agentSession.release')
    assert.ok(hold && !isStreamingMethod(hold)); assert.ok(release && !isStreamingMethod(release))
    return { adapter, hold: hold.handler, release: release.handler }
  }
  const bound = bind(), context = fixtureContext(runtime, { clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] })
  const params = { sessionId, holderId: 'surface' }
  const hold = (input = params, ctx = context) => Promise.resolve(bound.hold(input as never, ctx))
  const release = (input = params, ctx = context) => Promise.resolve(bound.release(input as never, ctx))
  const count = () => registrations.map(entry => entry.calls)
  try {
    for (const name of ['agentSession.hold', 'agentSession.release']) {
      const original = declarations.find(method => method.name === name)!
      assert.equal(original.params, HoldParams)
      assert.equal(bound.adapter.bind(declarations).find(method => method.name === name)?.params, HoldParams)
      assert.notEqual(bound.adapter.bind(declarations).find(method => method.name === name)?.handler, original.handler)
      assert.throws(() => bound.adapter.bind([{ ...original, stream: true } as unknown as RpcAnyMethodDeclaration]), /CATALOG_REGISTRY_KIND/)
    }
    assert.equal(bound.adapter.bind(declarations).find(method => method.name === 'agentSession.options'), declarations.find(method => method.name === 'agentSession.options'))
    await assert.rejects(hold({ ...params, unknown: true } as typeof params))
    await assert.rejects(release({ ...params, unknown: true } as typeof params))
    await assert.rejects(hold(params, { ...context, authenticatedCallerFingerprint: undefined }), /CATALOG_AUTHENTICATED_CALLER_REQUIRED/)
    await assert.rejects(release(params, { ...context, authenticatedCallerFingerprint: 'invalid' }), /CATALOG_AUTHENTICATED_CALLER_REQUIRED/)
    await assert.rejects(hold(params, { ...context, clientCapabilities: [] }), /unsupported/)
    await assert.rejects(release(params, { ...context, clientCapabilities: [] }), /unsupported/)
    enabled = false; await assert.rejects(hold(), /unsupported/); enabled = true
    assert.equal(connects, 0); assert.equal(sqlSeen.length, 0); assert.equal(registrations.length, 0)
    const contexts = [
      { ...context, connectionId: 'one:two' }, { ...context, connectionId: 'one' },
      { ...context, connectionId: 'one:two', authenticatedCallerFingerprint: 'b'.repeat(64) }, context,
      { ...context, connectionId: undefined }, { ...context, connectionId: 'local' }
    ]
    const inputs = [{ sessionId, holderId: 'three' }, { sessionId, holderId: 'two:three' },
      { sessionId, holderId: 'three' }, { sessionId: secondSession, holderId: 'surface' }, params, params]
    for (let i = 0; i < contexts.length; i++) { assert.deepEqual(await hold(inputs[i], contexts[i]), { held: true }) }
    const isolated = registrations.slice(-6)
    assert.equal(new Set(isolated.map(entry => entry.id)).size, 6)
    assert.ok(isolated.every(entry => entry.calls === 0), 'colon components, Session, fingerprint and local scope never replace one another')
    assert.ok(isolated.every(entry => !entry.id.includes('a'.repeat(64)) && !entry.id.includes('b'.repeat(64))))
    enabled = false
    const noPG = connects
    assert.deepEqual(await release(inputs[0], contexts[0]), { released: true })
    assert.deepEqual(await release(inputs[0], contexts[0]), { released: true })
    assert.equal(connects, noPG); assert.ok(isolated[0].calls > 0)
    assert.ok(isolated.slice(1).every(entry => entry.calls === 0))
    for (const entry of isolated) { await registry.cleanupAndWait(entry.id); entry.close() }
    enabled = true
    // A release while the actual Pool connect is pending cannot return held:true later.
    let gate = deferred<void>(); connectGate = gate
    let pending = hold(), rejected = assert.rejects(pending, /STRUCTURED_HOLD_CLOSED/)
    const releasedEntry = registrations.at(-1)!
    assert.deepEqual(await release(), { released: true }); gate.resolve(); await rejected
    await registry.cleanupAndWait(releasedEntry.id)
    gate = deferred<void>(); connectGate = gate
    pending = hold(); rejected = assert.rejects(pending, /STRUCTURED_HOLD_CLOSED/)
    registry.cleanupForConnection(context.connectionId!); gate.resolve(); await rejected
    // Same key replacement: neither late completion nor late failure can retire the newer registration.
    for (const fail of [false, true]) {
      gate = deferred<void>(); connectGate = gate
      pending = hold(); rejected = assert.rejects(pending, fail ? /DB_FAILURE/ : /STRUCTURED_HOLD_CLOSED/)
      assert.deepEqual(await hold(), { held: true })
      const newest = registrations.at(-1)!
      if (fail) { gate.reject(new Error('Synthetic delayed Pool failure')) } else { gate.resolve() }
      await rejected; assert.equal(newest.calls, 0)
      await registry.cleanupAndWait(newest.id); assert.ok(newest.calls > 0)
    }
    const abort = new AbortController()
    gate = deferred<void>(); connectGate = gate
    pending = hold(params, { ...context, signal: abort.signal }); rejected = assert.rejects(pending, /STRUCTURED_HOLD_CLOSED/)
    abort.abort(); gate.resolve(); await rejected
    const disposable = bind()
    gate = deferred<void>(); connectGate = gate
    pending = Promise.resolve(disposable.hold(params as never, context)); rejected = assert.rejects(pending, /CATALOG_ADAPTER_DISPOSED/)
    disposable.adapter.dispose(); disposable.adapter.dispose(); gate.resolve(); await rejected
    // The original params/context/config/Pool/runtime methods and receivers survive the first await.
    const mutableParams = { ...params }, mutableContext = { ...context }, originalContext = { ...context }
    gate = deferred<void>(); connectGate = gate
    pending = hold(mutableParams, mutableContext)
    mutableParams.sessionId = secondSession; mutableParams.holderId = 'changed'
    Object.assign(mutableContext, { authenticatedCallerFingerprint: 'c'.repeat(64), connectionId: 'changed', clientCapabilities: [], clientKind: 'runtime' })
    config.projectGroupIds.length = 0
    config.readHostIdentity = () => { throw new Error('Changed host method') }
    owner.connect = async () => { throw new Error('Changed Pool connect') }
    runtimeMethods.getClientSettings = () => { throw new Error('Changed settings method') }
    runtimeMethods.registerOwnedSubscriptionCleanup = () => { throw new Error('Changed cleanup registration') }
    runtimeMethods.cleanupSubscription = () => { throw new Error('Changed cleanup method') }
    gate.resolve(); assert.deepEqual(await pending, { held: true })
    const captured = registrations.at(-1)!, beforeRelease = connects
    assert.deepEqual(await release(params, originalContext), { released: true })
    assert.ok(captured.calls > 0); assert.equal(connects, beforeRelease)
    assert.ok(sqlSeen.some(entry => entry.sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'))
    assert.ok(sqlSeen.every(entry => !/\b(?:INSERT|UPDATE|DELETE)\b/.test(entry.sql)))
    assert.equal(directQueries, 0); assert.equal(ends, 0); assert.deepEqual(native.unexpected, [])
    assert.equal(releases, connects - 1, 'only the intentionally rejected connect has no borrowed client to release')
    bound.adapter.dispose()
    await assert.rejects(hold(), /CATALOG_ADAPTER_DISPOSED/)
    await assert.rejects(release(), /CATALOG_ADAPTER_DISPOSED/)
    assert.equal(ends, 0)
    assert.ok(count().every(calls => calls > 0))
  } finally { for (const adapter of adapters) { adapter.dispose() } }
})
