import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { AgentSessionAttachResult, AgentSessionMutationResult, AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY, CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { eraseRpcMethods, type RpcResponse } from '../../runtime/rpc/core'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../../runtime/rpc/methods/structured-agent-session'
import { WORKTREE_METHODS } from '../../runtime/rpc/methods/worktree'
import { SESSION_TAB_METHODS } from '../../runtime/rpc/methods/session-tabs'
import { RuntimeSubscriptionRegistry } from '../../runtime/runtime-subscription-registry'
import { registerCatalogProject } from '../catalog/register.ts'
import { parseCatalogUi } from '../catalog/ui.ts'
import type { CatalogWireResults } from '../catalog/wire.ts'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { appendSessionEvent } from '../journal/store.ts'
import { captureDurableCatalogReadConfig } from './config.ts'
import { captureCatalogReadContext } from './context.ts'
import { DurableCatalogReadAdapter } from './public.ts'
import { fixtureConfig, fixtureContext, fixtureRuntime, deferred } from './fixture-support.mts'

if (process.env.ORCA_STRUCTURED_SUBSCRIBE_WIRING_APPROVED !== 'root-source-reviewed' ||
    process.env.PGDATABASE !== 'orca_public_structured_subscribe_20261014' ||
    process.env.ORCA_STRUCTURED_SUBSCRIBE_WIRING_DB !== process.env.PGDATABASE) {
  throw new Error('Root review and existing exact wiring database required; no schema/reset here')
}

await test('배선 PG 1개: 실제 declaration→dispatcher→adapter→RR와 소유 cleanup을 확인합니다', { timeout: 15000 }, async t => {
  const pool = createDurablePool({ max: 4, application_name: 'orca-structured-subscribe-wiring-first' })
  type ReadGate = { entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> }
  let readGate: ReadGate | null = null
  const readGates: ReadGate[] = []
  const adapters: DurableCatalogReadAdapter[] = [], starts: Promise<void>[] = []
  t.after(async () => {
    for (const gate of readGates) { gate.release.resolve() }
    for (const adapter of adapters) { adapter.dispose() }
    await Promise.allSettled(starts)
    await pool.end()
  })
  const identity = (await pool.query(`SELECT current_database() AS database,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system`)).rows[0]
  assert.equal(identity.database, 'orca_public_structured_subscribe_20261014'); assert.equal(identity.oid, '84739')
  assert.equal(identity.system, '7696101282789175327')
  const ledger = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length, 19)
  // Preserve existing UUID seed rows; shared Catalog revision/UI heads may advance for this new registration.
  const originalTables = ['catalog_repositories', 'catalog_tab_metadata', 'workspaces', 'sessions', 'agents', 'tabs',
    'runtime_units', 'runtime_members', 'operations', 'attempts', 'execution_grants', 'storage_write_grants',
    'storage_domains', 'structured_session_aliases', 'rpc_receipts', 'session_events', 'outbox_events'] as const
  async function originalRows() {
    const result: Record<string, string[]> = {}
    for (const table of originalTables) {
      const rows = (await pool.query<{ row: string }>(`SELECT to_jsonb(t)::text AS row FROM durable_runtime.${table} t`)).rows
      result[table] = rows.map(row => createHash('sha256').update(row.row).digest('hex'))
    }
    return result
  }
  const existing = await originalRows()
  // The Pool still executes the original RR query. Only its completed COMMIT return can be paused.
  const observedPool = new Proxy(pool, { get(target, property) {
    if (property === 'connect') { return async () => {
      const gate = readGate; readGate = null
      const client = await target.connect(); let repeatableRead = false
      return new Proxy(client, { get(connection, key) {
        if (key === 'query') { return async (text: unknown, ...values: unknown[]) => {
          if (text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') { repeatableRead = true }
          const result = await Reflect.apply(connection.query, connection, [text, ...values])
          if (repeatableRead && text === 'COMMIT' && gate) {
            gate.entered.resolve(); await gate.release.promise
          }
          return result
        } }
        const value = Reflect.get(connection, key)
        return typeof value === 'function' ? value.bind(connection) : value
      } })
    } }
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const id = randomUUID(), repoId = `synthetic-wiring:${id}`, root = `/synthetic/wiring/${id}`
  const settings = { ...fixtureConfig(observedPool), repositoryIds: [repoId], pollIntervalMs: 10, launch: {
    policy: { operationDeadlineMs: 30000, idleDurationMs: null }, repositories: [{ repositoryId: repoId,
      worktreeRoot: `${root}/worktrees`, agentHomeRoot: `${root}/homes`, storage: {
        backendId: `synthetic-wiring-backend:${id}`, exportId: 'synthetic-export', localDirectory: root,
        canonicalDirectory: `/authority/wiring/${id}` } }] } }
  const owner = fixtureRuntime(), registry = new RuntimeSubscriptionRegistry(), registered = new Set<string>()
  const runtime = new Proxy(owner.runtime, { get(target, property, receiver) {
    if (property === 'getClientSettings') { return () => ({ experimentalStructuredNativeChat: true }) }
    if (property === 'registerOwnedSubscriptionCleanup') {
      return (key: string, close: () => void, connection?: string) => {
        registered.add(key)
        return registry.registerOwned(key, () => { try { close() } finally { registered.delete(key) } }, connection)
      }
    }
    if (property === 'registerSubscriptionCleanup') { return registry.register.bind(registry) }
    if (property === 'cleanupSubscription') { return registry.cleanup.bind(registry) }
    return Reflect.get(target, property, receiver)
  } })
  const adapter = new DurableCatalogReadAdapter(settings); adapters.push(adapter)
  const methods = eraseRpcMethods([...WORKTREE_METHODS, ...SESSION_TAB_METHODS, ...STRUCTURED_AGENT_SESSION_METHODS])
  const dispatcher = new RpcDispatcher({ runtime, methods: adapter.bind(methods) })
  const options = { authenticatedCallerFingerprint: 'a'.repeat(64), connectionId: 'synthetic-wiring-connection',
    clientKind: 'mobile' as const, clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY, CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] }
  async function invoke(method: string, params: unknown) {
    const result = await dispatcher.dispatch({ id: randomUUID(), authToken: '', method, params }, options)
    if (!result.ok) { throw new Error(result.error.message) }
    return result.result
  }
  const ui = parseCatalogUi({ lastActiveRepoId: null, lastActiveWorktreeId: null, activeView: 'terminal', sidebarWidth: 240,
    rightSidebarOpen: false, rightSidebarTab: 'explorer', rightSidebarExplorerView: 'files', rightSidebarWidth: 320,
    groupBy: 'none', sortBy: 'smart', projectOrderBy: 'manual', showActiveOnly: false, hideDefaultBranchWorkspace: false,
    filterRepoIds: [], collapsedGroups: [], uiZoomLevel: 0, editorFontZoomLevel: 0, worktreeCardProperties: [],
    statusBarItems: [], statusBarVisible: true, dismissedUpdateVersion: null, lastUpdateCheckAt: null })
  const authority = captureCatalogReadContext(captureDurableCatalogReadConfig(settings), fixtureContext(runtime)).authority
  await registerCatalogProject(pool, authority, { mutationId: `wiring-register:${id}`, group: null, ui,
    repo: { id: repoId, path: `${root}/repo`, displayName: repoId, kind: 'folder', executionHostId: 'local', badgeColor: '#ffffff', addedAt: 1 } })
  await withDurableTransaction(pool, async tx => { await tx.query(
    'INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2)', [settings.launch.repositories[0].storage.backendId, 'synthetic-export']) })
  const workspace = await invoke('worktree.create', { repo: `id:${repoId}`, name: 'wiring', clientMutationId: `wiring-workspace:${id}` }) as CatalogWireResults['worktree.create']
  const publicSessionId = `structured_${randomUUID().replaceAll('-', '_')}`, fields = { worktree: `id:${workspace.worktree.id}`, agent: 'codex' }
  const reserved = await invoke('agentSession.create', { ...fields, envelope: { sessionId: publicSessionId,
    clientOperationId: `wiring-create:${id}`, expectedRuntimeFence: null,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({ method: 'agentSession.create', sessionId: publicSessionId, fields }) } }) as AgentSessionMutationResult<AgentSessionAttachResult>
  assert.equal(reserved.ok, true)
  const alias = (await pool.query<{ session_id: string }>('SELECT session_id FROM durable_runtime.structured_session_aliases WHERE public_session_id=$1', [publicSessionId])).rows
  assert.equal(alias.length, 1)
  const sessionId = logicalId('session', alias[0].session_id)
  async function append(revision: number) {
    await withDurableTransaction(pool, tx => appendSessionEvent(tx, { sessionId,
      source: { kind: 'PRODUCER', sourceKind: 'STRUCTURED_PROVIDER_OUTPUT', producerId: sessionId,
        incarnation: `synthetic-wiring:${id}`, producerSeq: counter('sequence:producer', String(revision)) },
      body: { version: 1, kind: 'STRUCTURED_PROVIDER_OUTPUT', publicSessionId, provider: 'codex', source: { kind: 'PRODUCER' },
        observedAt: new Date(0).toISOString(), mutation: { kind: 'item', itemId: 'synthetic-wiring-item', revision,
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `synthetic-wiring-${revision}` }] } } } }))
  }
  const frames = new Map<string, AgentSessionSubscribeEvent[]>(), errors: RpcResponse[] = []
  const waiting: { frame: string; predicate: (event: AgentSessionSubscribeEvent) => boolean; done: ReturnType<typeof deferred<AgentSessionSubscribeEvent>> }[] = []
  function waitFor(frame: string, predicate: (event: AgentSessionSubscribeEvent) => boolean) {
    const found = frames.get(frame)?.find(predicate)
    if (found) { return Promise.resolve(found) }
    const done = deferred<AgentSessionSubscribeEvent>(); waiting.push({ frame, predicate, done }); return done.promise
  }
  function subscribe(frame: string, cursor?: AgentJournalCursor) {
    frames.set(frame, [])
    const start = dispatcher.dispatchStreaming({ id: frame, authToken: '', method: 'agentSession.subscribe',
      params: { sessionId: publicSessionId, ...(cursor ? { cursor } : {}) } }, raw => {
      const response = JSON.parse(raw) as RpcResponse
      if (!response.ok) { errors.push(response); for (const entry of waiting) { entry.done.reject(new Error(response.error.message)) }; return }
      if (!response.streaming) { return }
      const event = response.result as AgentSessionSubscribeEvent
      frames.get(frame)?.push(event)
      for (const entry of waiting) { if (entry.frame === frame && entry.predicate(event)) { entry.done.resolve(event) } }
    }, options)
    starts.push(start); return start
  }
  await subscribe('one')
  assert.equal(frames.get('one')?.[0].type, 'snapshot')
  const firstBatch = waitFor('one', event => event.type === 'batch' && event.batch.items.some(item => item.revision === 1))
  await append(1); const initial = await firstBatch
  if (initial.type !== 'batch') { throw new Error('Expected public batch after canonical journal commit') }
  const cursor = initial.batch.cursor
  await subscribe('two', cursor); assert.equal(frames.get('two')?.[0].type, 'batch')
  const retiredId = `agentSession:${options.connectionId}:${publicSessionId}:one`
  assert.deepEqual(await invoke('agentSession.unsubscribe', { sessionId: publicSessionId, subscriptionId: retiredId }), { unsubscribed: true })
  await registry.cleanupAndWait(retiredId)
  const retiredCount = frames.get('one')?.length
  const secondBatch = waitFor('two', event => event.type === 'batch' && event.batch.items.some(item => item.revision === 2))
  await append(2); await secondBatch
  assert.equal(frames.get('one')?.length, retiredCount)
  await subscribe('reconnect', cursor)
  const replay = frames.get('reconnect')?.[0]
  assert.equal(replay?.type, 'batch')
  if (replay?.type !== 'batch') { throw new Error('Expected public reconnect batch') }
  assert.equal(replay.batch.items[0].revision, 2)
  // A new public subscribe is held only after its original RR COMMIT has completed.
  const gate = { entered: deferred<void>(), release: deferred<void>() }; readGate = gate
  readGates.push(gate)
  const lateStart = subscribe('late', replay.batch.cursor)
  await gate.entered.promise
  adapter.dispose(); adapter.dispose()
  const countsAfterDispose = new Map(Array.from(frames, ([key, events]) => [key, events.length]))
  gate.release.resolve(); await lateStart
  assert.deepEqual(new Map(Array.from(frames, ([key, events]) => [key, events.length])), countsAfterDispose)
  assert.equal(registered.size, 0); assert.deepEqual(errors, [])
  assert.equal((await pool.query('SELECT 1 AS still_borrowed')).rows[0].still_borrowed, 1)
  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  const after = await originalRows()
  for (const table of originalTables) { for (const hash of existing[table]) { assert.ok(after[table].includes(hash), `existing ${table} row changed`) } }
  assert.deepEqual(owner.unexpected, [])
  // Synthetic transport fingerprint/provider body only; no actual pairing/provider/HA/live claim.
})
