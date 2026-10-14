import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { appendSessionEvent } from '../journal/store.ts'
import { registerCatalogProject } from '../catalog/register.ts'
import { parseCatalogUi } from '../catalog/ui.ts'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  EMPTY_STRUCTURED_AGENT_SESSION, reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import type {
  AgentSessionAttachResult, AgentSessionHistoryResult, AgentSessionMutationResult, AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY, CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { eraseRpcMethods } from '../../runtime/rpc/core'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { WORKTREE_METHODS } from '../../runtime/rpc/methods/worktree'
import { SESSION_TAB_METHODS } from '../../runtime/rpc/methods/session-tabs'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../../runtime/rpc/methods/structured-agent-session'
import type { CatalogWireResults } from '../catalog/wire.ts'
import { captureCatalogReadContext } from './context.ts'
import { captureDurableCatalogReadConfig } from './config.ts'
import { DurableCatalogReadAdapter } from './public.ts'
// Exact PR67 dd0196e3 read dependency. No local copy of its reader or projector.
import { createCatalogStructuredHistoryRpc } from './structured-history.ts'
import { createCatalogStructuredSubscriptions, type StructuredHistoryReadInput } from './structured-subscriptions.ts'
import { fixtureConfig, fixtureContext, fixtureRuntime, deferred } from './fixture-support.mts'

if (process.env.ORCA_STRUCTURED_SUBSCRIBE_SOURCE_APPROVED !== 'root-source-reviewed' ||
    !process.env.ORCA_STRUCTURED_SUBSCRIBE_DB || process.env.ORCA_STRUCTURED_SUBSCRIBE_DB !== process.env.PGDATABASE ||
    !(process.env.PGDATABASE ?? '').startsWith('orca_') || process.env.PGDATABASE === 'orca_dev') {
  throw new Error('Root review and exact owned structured subscribe database required; no schema/reset here')
}

await test('PG 1개: 실제 RR history·원 commit·snapshot/batch/reset·두 frame cleanup을 관찰합니다', async t => {
  const pool = createDurablePool({ max: 4, application_name: 'orca-structured-subscribe-first' })
  t.after(async () => { await pool.end() })
  const ledger = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length, 19, 'Root supplies the existing exact isolated schema; this fixture applies nothing')
  const id = randomUUID(), repoId = `synthetic-subscribe:${id}`, root = `/synthetic/subscribe/${id}`
  const settings = { ...fixtureConfig(pool), repositoryIds: [repoId], pollIntervalMs: 60000, launch: {
    policy: { operationDeadlineMs: 30000, idleDurationMs: null }, repositories: [{ repositoryId: repoId,
      worktreeRoot: `${root}/worktrees`, agentHomeRoot: `${root}/homes`, storage: {
        backendId: `synthetic-subscribe-backend:${id}`, exportId: 'synthetic-export', localDirectory: root,
        canonicalDirectory: `/authority/subscribe/${id}` } }] } }
  const config = captureDurableCatalogReadConfig(settings), owner = fixtureRuntime()
  const runtime = new Proxy(owner.runtime, { get(target, property, receiver) {
    if (property === 'registerOwnedSubscriptionCleanup') { return undefined }
    if (property === 'getClientSettings') { return () => ({ experimentalStructuredNativeChat: true }) }
    return Reflect.get(target, property, receiver)
  } })
  const capabilities = [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY, CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
  const context = (requestId: string) => fixtureContext(runtime, { requestId, clientCapabilities: capabilities })
  const adapter = new DurableCatalogReadAdapter(settings)
  t.after(() => adapter.dispose())
  const methods = eraseRpcMethods([...WORKTREE_METHODS, ...SESSION_TAB_METHODS, ...STRUCTURED_AGENT_SESSION_METHODS])
  const dispatcher = new RpcDispatcher({ runtime, methods: adapter.bind(methods) })
  async function invoke(method: string, params: unknown) {
    const result = await dispatcher.dispatch({ id: randomUUID(), authToken: '', method, params }, {
      authenticatedCallerFingerprint: 'a'.repeat(64), clientKind: 'mobile', clientCapabilities: capabilities })
    if (!result.ok) { throw new Error(result.error.message) }
    return result.result
  }
  const ui = parseCatalogUi({ lastActiveRepoId: null, lastActiveWorktreeId: null, activeView: 'terminal', sidebarWidth: 240,
    rightSidebarOpen: false, rightSidebarTab: 'explorer', rightSidebarExplorerView: 'files', rightSidebarWidth: 320,
    groupBy: 'none', sortBy: 'smart', projectOrderBy: 'manual', showActiveOnly: false, hideDefaultBranchWorkspace: false,
    filterRepoIds: [], collapsedGroups: [], uiZoomLevel: 0, editorFontZoomLevel: 0, worktreeCardProperties: [],
    statusBarItems: [], statusBarVisible: true, dismissedUpdateVersion: null, lastUpdateCheckAt: null })
  const authority = captureCatalogReadContext(config, context('registration')).authority
  await registerCatalogProject(pool, authority, { mutationId: `subscribe-register:${id}`, group: null, ui,
    repo: { id: repoId, path: `${root}/repo`, displayName: repoId, kind: 'folder', executionHostId: 'local', badgeColor: '#ffffff', addedAt: 1 } })
  await withDurableTransaction(pool, async tx => { await tx.query(
    'INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2)', [settings.launch.repositories[0].storage.backendId, 'synthetic-export']) })
  // Actual existing reservation methods create fixture seed rows; they do not execute a provider.
  const workspace = await invoke('worktree.create', { repo: `id:${repoId}`, name: 'existing', clientMutationId: `subscribe-workspace:${id}` }) as CatalogWireResults['worktree.create']
  const publicSessionId = `structured_${randomUUID().replaceAll('-', '_')}`, fields = { worktree: `id:${workspace.worktree.id}`, agent: 'codex' }
  const reserved = await invoke('agentSession.create', { ...fields, envelope: { sessionId: publicSessionId,
    clientOperationId: `subscribe-create:${id}`, expectedRuntimeFence: null,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({ method: 'agentSession.create', sessionId: publicSessionId, fields }) } }) as AgentSessionMutationResult<AgentSessionAttachResult>
  assert.equal(reserved.ok, true)
  const aliases = await pool.query<{ session_id: string }>('SELECT session_id FROM durable_runtime.structured_session_aliases WHERE public_session_id=$1', [publicSessionId])
  assert.equal(aliases.rowCount, 1)
  const sessionId = logicalId('session', aliases.rows[0].session_id)
  async function stableState() {
    const tables = ['agents', 'runtime_units', 'runtime_members', 'operations', 'attempts', 'execution_grants', 'storage_write_grants'] as const
    const rows: Record<string, unknown> = {}
    for (const table of tables) { rows[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM durable_runtime.${table} t ORDER BY to_jsonb(t)::text`)).rows }
    // Only the fixture's canonical append may advance the Session journal head.
    rows.session = (await pool.query("SELECT to_jsonb(s)-'next_event_seq' AS row FROM durable_runtime.sessions s WHERE id=$1", [sessionId])).rows
    return rows
  }
  const before = await stableState()
  async function append(revision: number) {
    return withDurableTransaction(pool, tx => appendSessionEvent(tx, { sessionId,
      source: { kind: 'PRODUCER', sourceKind: 'STRUCTURED_PROVIDER_OUTPUT', producerId: sessionId,
        incarnation: `synthetic-subscribe:${id}`, producerSeq: counter('sequence:producer', String(revision)) },
      body: { version: 1, kind: 'STRUCTURED_PROVIDER_OUTPUT', publicSessionId, provider: 'codex',
        source: { kind: 'PRODUCER' }, observedAt: new Date(0).toISOString(), mutation: { kind: 'item', itemId: 'synthetic-provider-item', revision,
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `synthetic-output-${revision}` }] } } } }))
  }
  const historyRpc = createCatalogStructuredHistoryRpc(config)
  let firstRead = true, late: ReturnType<typeof deferred<void>> | null = null
  const entered = deferred<void>(), failed: unknown[] = []
  // Source-only composition seam: uses the real PR67 RPC closure. Its approved minimal
  // synchronous captured-reader extraction is still pending the Root merge notice.
  const readerOwner = { capture(input: StructuredHistoryReadInput) {
    const policyRuntime = new Proxy(runtime, { get(target, property, receiver) {
      if (property === 'getClientSettings') { return () => ({ experimentalStructuredNativeChat: input.structuredNativeChatEnabled }) }
      return Reflect.get(target, property, receiver)
    } })
    const fixed = fixtureContext(policyRuntime, { authenticatedCallerFingerprint: input.authenticatedCallerFingerprint,
      clientKind: input.clientKind, clientCapabilities: input.clientCapabilities })
    return async (request: Parameters<typeof historyRpc>[0]): Promise<AgentSessionHistoryResult> => {
      const result = await historyRpc(request, fixed)
      if (firstRead) { firstRead = false; await append(1) } // Commit strictly after opening RR snapshot, before listener attach.
      if (late) { const gate = late; late = null; entered.resolve(); await gate.promise }
      return result
    }
  } }
  const source = createCatalogStructuredSubscriptions(config, readerOwner)
  t.after(() => source.dispose())
  const frames: AgentSessionSubscribeEvent[] = [], sibling: AgentSessionSubscribeEvent[] = []
  let rendered = EMPTY_STRUCTURED_AGENT_SESSION
  await source.subscribe({ sessionId: publicSessionId }, context('one'), event => {
    frames.push(event); rendered = reduceStructuredAgentSession(rendered, { type: 'event', event })
  })
  assert.equal(frames[0].type, 'snapshot'); assert.equal(rendered.items.length, 0)
  await source.flush()
  assert.equal(frames.at(-1)?.type, 'batch'); assert.equal(rendered.items[0].itemId, 'synthetic-provider-item')
  const cursor = rendered.cursor; assert.ok(cursor)
  await source.subscribe({ sessionId: publicSessionId, cursor }, context('two'), event => sibling.push(event))
  assert.equal(sibling[0].type, 'batch')
  source.unsubscribe({ sessionId: publicSessionId, subscriptionId: `agentSession:synthetic-connection:${publicSessionId}:one` }, context('unsubscribe'))
  const stoppedAt = frames.length
  await append(2); await source.flush()
  assert.equal(frames.length, stoppedAt); assert.equal(sibling.at(-1)?.type, 'batch')
  const replay: AgentSessionSubscribeEvent[] = []
  await source.subscribe({ sessionId: publicSessionId, cursor }, context('reconnect'), event => replay.push(event))
  assert.equal(replay[0].type, 'batch')
  const event = replay[0]
  if (event.type !== 'batch') { throw new Error('Expected original after page batch') }
  assert.equal(event.batch.items[0].revision, 2)
  const reset: AgentSessionSubscribeEvent[] = []
  await source.subscribe({ sessionId: publicSessionId, cursor: { epoch: 'synthetic-old-epoch', sequence: 0 } }, context('reset'), event => reset.push(event))
  assert.equal(reset[0].type, 'reset')
  let reconstructed = reduceStructuredAgentSession(rendered, { type: 'event', event })
  const actualTail = await historyRpc({ sessionId: publicSessionId, direction: 'tail' }, context('compare'))
  assert.deepEqual(reconstructed.items, actualTail.page.items)
  await append(3); late = deferred<void>()
  const gate = late, pending = source.flush(); await entered.promise
  source.dispose(); const afterClose = sibling.length
  gate.resolve(); await pending
  assert.equal(sibling.length, afterClose); assert.equal(owner.cleanups.size, 0)
  const deniedConfig = captureDurableCatalogReadConfig({ ...settings, repositoryIds: [], launch: { ...settings.launch, repositories: [] } })
  const deniedRpc = createCatalogStructuredHistoryRpc(deniedConfig)
  const denied = createCatalogStructuredSubscriptions(deniedConfig, { capture: () => request => deniedRpc(request, context('denied')) })
  try {
    const delivered: AgentSessionSubscribeEvent[] = []
    await assert.rejects(denied.subscribe({ sessionId: publicSessionId }, context('denied'), event => delivered.push(event)), /ALIAS_SCOPE/)
    assert.ok(delivered.every(frame => frame.type === 'end'))
  } finally { denied.dispose() }
  let failQuery = false
  const observedPool = new Proxy(pool, { get(target, property) {
    if (property === 'query') { return (...args: Parameters<typeof pool.query>) => failQuery ? pool.query('SELECT 1/0') : pool.query(...args) }
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const observedConfig = captureDurableCatalogReadConfig({ ...settings, pool: observedPool })
  const bad = createCatalogStructuredSubscriptions(observedConfig, readerOwner)
  try {
    await bad.subscribe({ sessionId: publicSessionId }, { ...context('db-error'), reportSubscriptionError: error => failed.push(error) }, () => {})
    failQuery = true; await bad.flush()
    assert.equal(failed.length, 1); assert.match(String(failed[0]), /22012/)
  } finally { bad.dispose() }
  assert.deepEqual(await stableState(), before)
  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  assert.equal((await pool.query('SELECT 1 AS still_borrowed')).rows[0].still_borrowed, 1)
  assert.deepEqual(owner.unexpected, [])
  // Synthetic authenticated context/provider body; no pairing, provider execution, Spot, HA or iPhone evidence.
})
