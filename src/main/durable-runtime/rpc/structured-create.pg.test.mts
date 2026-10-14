import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { registerCatalogProject, type CatalogRegistration } from '../catalog/register.ts'
import { captureCatalogReadContext } from './context.ts'
import { captureDurableCatalogReadConfig } from './config.ts'
import { DurableCatalogReadAdapter } from './public.ts'
import { fixtureConfig, fixtureRuntime, fixtureContext, deferred } from './fixture-support.mts'
import { eraseRpcMethods } from '../../runtime/rpc/core.ts'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher.ts'
import { WORKTREE_METHODS } from '../../runtime/rpc/methods/worktree.ts'
import { SESSION_TAB_METHODS } from '../../runtime/rpc/methods/session-tabs.ts'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../../runtime/rpc/methods/structured-agent-session.ts'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope.ts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { appendSessionEvent } from '../journal/store.ts'
import { counter } from '../../../shared/durable-runtime/identity.ts'
import type { AgentSessionAttachResult, AgentSessionMutationResult } from '../../../shared/agent-session-wire.ts'
import type { CatalogWireResults } from '../catalog/wire.ts'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY, CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY } from '../../../shared/protocol-version.ts'

// Source only. Root supplies an exact already prepared owned database; no migration/reset.
if (process.env.ORCA_PUBLIC_STRUCTURED_CREATE_APPROVED !== 'root-source-reviewed' ||
    !process.env.ORCA_PUBLIC_STRUCTURED_CREATE_DB || process.env.ORCA_PUBLIC_STRUCTURED_CREATE_DB !== process.env.PGDATABASE ||
    !(process.env.PGDATABASE ?? '').startsWith('orca_') || process.env.PGDATABASE === 'orca_dev') {
  throw new Error('Root review and exact owned structured creation database required')
}
const methods = eraseRpcMethods([...WORKTREE_METHODS, ...SESSION_TAB_METHODS, ...STRUCTURED_AGENT_SESSION_METHODS])
const capabilities = [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY, CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY]
const ui = { lastActiveRepoId: null, lastActiveWorktreeId: null, activeView: 'terminal', sidebarWidth: 240,
  rightSidebarOpen: false, rightSidebarTab: 'explorer', rightSidebarExplorerView: 'files', rightSidebarWidth: 320,
  groupBy: 'none', sortBy: 'smart', projectOrderBy: 'manual', showActiveOnly: false, hideDefaultBranchWorkspace: false,
  filterRepoIds: [], collapsedGroups: [], uiZoomLevel: 0, editorFontZoomLevel: 0, worktreeCardProperties: [],
  statusBarItems: [], statusBarVisible: true, dismissedUpdateVersion: null, lastUpdateCheckAt: null }
function setup(pool: Pool, config: ReturnType<typeof configuration>) {
  const owner = fixtureRuntime()
  const runtime = new Proxy(owner.runtime, { get(target, property, receiver) {
    if (property === 'getClientSettings') { return () => ({ experimentalStructuredNativeChat: true }) }
    return Reflect.get(target, property, receiver)
  } })
  const adapter = new DurableCatalogReadAdapter({ ...config, pool })
  const dispatcher = new RpcDispatcher({ runtime, methods: adapter.bind(methods) })
  const transport = { authenticatedCallerFingerprint: 'a'.repeat(64), clientKind: 'mobile' as const,
    clientCapabilities: [...capabilities] }
  const invoke = async (method: string, params: unknown, overrides: { authenticatedCallerFingerprint?: string } = {}) => {
    const result = await dispatcher.dispatch({ id: randomUUID(), method, params, authToken: '' }, { ...transport, ...overrides })
    if (!result.ok) { throw new Error(result.error.message) }
    return result.result
  }
  return { ...owner, runtime, adapter, invoke, transport }
}
function configuration(pool: Pool, id: string) {
  const repoId = `synthetic-structured:${id}`, root = `/synthetic/structured/${id}`, canonicalDirectory = `/authority/structured/${id}`
  return { ...fixtureConfig(pool), repositoryIds: [repoId], launch: {
    policy: { operationDeadlineMs: 30000, idleDurationMs: null }, repositories: [{ repositoryId: repoId,
      worktreeRoot: `${root}/worktrees`, agentHomeRoot: `${root}/homes`,
      storage: { backendId: `synthetic-backend:${id}`, exportId: 'synthetic-export', localDirectory: root, canonicalDirectory } }] } }
}
async function fixture(pool: Pool) {
  const id = randomUUID(), config = configuration(pool, id), state = setup(pool, config), repoId = config.repositoryIds[0]
  const authority = captureCatalogReadContext(captureDurableCatalogReadConfig(config), fixtureContext(state.runtime)).authority
  await registerCatalogProject(pool, authority, { mutationId: `synthetic-register:${id}`, group: null, ui,
    repo: { id: repoId, path: `${config.launch.repositories[0].storage.localDirectory}/repo`, displayName: repoId,
      kind: 'folder', executionHostId: 'local', badgeColor: '#ffffff', addedAt: 1 } } as CatalogRegistration)
  await withDurableTransaction(pool, async tx => { await tx.query(
    'INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2)',
    [config.launch.repositories[0].storage.backendId, config.launch.repositories[0].storage.exportId]) })
  const created = await state.invoke('worktree.create', { repo: `id:${repoId}`, name: 'existing', clientMutationId: `workspace:${id}` }) as CatalogWireResults['worktree.create']
  const baseline = (await pool.query(`SELECT w.id,m.runtime_unit_id,r.storage_binding_id,to_jsonb(b) AS binding
    FROM durable_runtime.workspaces w JOIN durable_runtime.catalog_workspace_metadata m ON m.workspace_id=w.id
    JOIN durable_runtime.sessions s ON s.workspace_id=w.id JOIN durable_runtime.runtime_members r ON r.session_id=s.id
    JOIN durable_runtime.storage_bindings b ON b.id=r.storage_binding_id WHERE w.public_id=$1`, [created.worktree.id])).rows[0]
  state.adapter.dispose()
  return { id, config, repoId, publicId: created.worktree.id, baseline }
}
function intent(worktree: string, agent: 'codex' | 'claude' = 'codex', resumeFrom?: { providerSessionId: string }) {
  const publicId = `structured_${randomUUID().replaceAll('-', '_')}`, fields = { worktree: `id:${worktree}`, agent,
    ...(resumeFrom === undefined ? {} : { resumeFrom }) }
  return { ...fields, envelope: { sessionId: publicId, clientOperationId: `structured-create:${randomUUID()}`,
    expectedRuntimeFence: null, payloadFingerprint: computeAgentSessionPayloadFingerprint({ method: 'agentSession.create', sessionId: publicId, fields }) } }
}
async function physical(pool: Pool) {
  return (await pool.query(`SELECT (SELECT count(*)::integer FROM durable_runtime.attempts) AS attempts,
    (SELECT count(*)::integer FROM durable_runtime.execution_grants) AS execution_grants,
    (SELECT count(*)::integer FROM durable_runtime.storage_write_grants) AS storage_grants,
    (SELECT count(*)::integer FROM durable_runtime.storage_bindings WHERE identity_verified_at IS NOT NULL) AS verification`)).rows[0]
}
async function counts(pool: Pool) {
  return (await pool.query(`SELECT (SELECT count(*)::integer FROM durable_runtime.structured_session_aliases) AS aliases,
    (SELECT count(*)::integer FROM durable_runtime.sessions) AS sessions,(SELECT count(*)::integer FROM durable_runtime.agents) AS agents,
    (SELECT count(*)::integer FROM durable_runtime.tabs) AS tabs,(SELECT count(*)::integer FROM durable_runtime.session_events) AS events,
    (SELECT count(*)::integer FROM durable_runtime.rpc_receipts) AS receipts`)).rows[0]
}

await test('공개 structured 생성의 지정 PG 경계', async t => {
  const pool = createDurablePool({ max: 4 })
  t.after(async () => { await pool.end() })
  await t.test('PG1 공개 인증 handler가 원 Unit/binding과 같은 TX에 예약하고 서버 홈 및 실제 최초 빈 page를 보존합니다', async () => {
    const ws = await fixture(pool), state = setup(pool, ws.config), request = intent(ws.publicId), before = await physical(pool)
    try {
      assert.deepEqual(await state.invoke('agentSession.createSupport', { worktree: request.worktree, agent: request.agent }),
        { supported: false, reason: 'agent' })
      const result = await state.invoke('agentSession.create', request) as AgentSessionMutationResult<AgentSessionAttachResult>
      assert.equal(result.ok, true); if (!result.ok) { throw new Error('Unexpected refusal') }
      const row = (await pool.query(`SELECT a.*,s.agent_id,s.session_fence,s.lifecycle,r.runtime_unit_id,r.storage_binding_id,
        t.id AS tab_id,t.kind,t.terminal_handle,t.leaf_id,t.pane_key,m.launch_request,m.payload
        FROM durable_runtime.structured_session_aliases a JOIN durable_runtime.sessions s ON s.id=a.session_id
        JOIN durable_runtime.runtime_members r ON r.session_id=s.id JOIN durable_runtime.tabs t ON t.session_id=s.id
        JOIN durable_runtime.catalog_tab_metadata m ON m.tab_id=t.id WHERE a.public_session_id=$1`, [request.envelope.sessionId])).rows[0]
      assert.equal(row.runtime_unit_id, ws.baseline.runtime_unit_id); assert.equal(row.storage_binding_id, ws.baseline.storage_binding_id)
      assert.notEqual(row.session_id, request.envelope.sessionId); assert.equal(row.workspace_id, ws.baseline.id)
      assert.equal(row.created_by, fingerprintAttachmentPrincipal('a'.repeat(64))); assert.equal(row.session_fence, '1')
      assert.equal(row.kind, 'agent-session'); assert.equal(row.terminal_handle, null); assert.equal(row.leaf_id, null); assert.equal(row.pane_key, null)
      assert.equal(row.payload.sessionId, request.envelope.sessionId)
      const stored = { ...row.launch_request }; delete stored.server
      assert.deepEqual(stored, request); assert.deepEqual(row.original_create, { worktree: request.worktree, agent: request.agent })
      const launch = ws.config.launch.repositories[0]
      assert.equal(row.launch_request.server.agentHomePath, `${launch.agentHomeRoot}/${row.agent_id}`)
      assert.deepEqual(row.launch_request.server.storagePathMapping, { localDirectory: launch.storage.localDirectory,
        canonicalDirectory: launch.storage.canonicalDirectory })
      const events = (await pool.query('SELECT event_id,journal_epoch::text,seq::text,body FROM durable_runtime.session_events WHERE session_id=$1 ORDER BY seq', [row.session_id])).rows
      assert.equal(events.length, 1); assert.equal(events[0].body.kind, 'STRUCTURED_SESSION_CREATED'); assert.equal(events[0].seq, '1')
      assert.equal(events[0].body.tabId, row.tab_id); assert.equal(events[0].body.agentId, row.agent_id)
      const receipt = (await pool.query('SELECT principal_id,response FROM durable_runtime.rpc_receipts WHERE method=$1 AND operation_key=$2',
        ['agentSession.create', request.envelope.clientOperationId])).rows[0]
      assert.equal(receipt.principal_id, row.created_by); assert.equal(receipt.response.kind, 'STRUCTURED_SESSION_RESERVED')
      assert.equal(receipt.response.reservation.sessionId, row.session_id); assert.equal(receipt.response.event.eventId, events[0].event_id)
      assert.equal(result.fence, 1); assert.equal(result.cursor.sequence, 1); assert.equal(result.cursor.epoch, events[0].journal_epoch)
      assert.deepEqual(result.value.page, { sessionId: request.envelope.sessionId, epoch: result.cursor.epoch, fence: 1, direction: 'tail',
        items: [], removedItemIds: [], submissions: [], window: { oldest: null, newest: null, nextCursor: result.cursor },
        liveCursor: result.cursor, hasOlder: false, hasNewer: false })
      assert.deepEqual(result.value.unconfirmedClientMessageIds, [])
      assert.deepEqual((await pool.query('SELECT to_jsonb(b) AS binding FROM durable_runtime.storage_bindings b WHERE id=$1', [row.storage_binding_id])).rows[0].binding, ws.baseline.binding)
      assert.deepEqual(await physical(pool), before); assert.deepEqual(state.unexpected, [])
    } finally { state.adapter.dispose() }
  })
  await t.test('PG2 원 key 재생은 후속 상태보다 우선하며 인증·scope·fingerprint·attach/resume 거절과 호출자 mutation은 새 효과를 만들지 않습니다', async () => {
    const ws = await fixture(pool), foreign = await fixture(pool), gate = deferred<void>(), entered = deferred<void>()
    let blocked = false, endCalls = 0
    const borrowed = new Proxy(pool, { get(target, property) {
      if (property === 'end') { return () => { endCalls++; throw new Error('Borrowed Pool end forbidden') } }
      if (property === 'connect') { return async () => { if (!blocked) { blocked = true; entered.resolve(); await gate.promise } return target.connect() } }
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value
    } })
    const state = setup(borrowed, ws.config), request = intent(ws.publicId, 'claude'), original = JSON.parse(JSON.stringify(request)) as typeof request
    try {
      const pending = state.invoke('agentSession.create', request)
      await entered.promise
      request.agent = 'codex'; request.envelope.clientOperationId = 'mutated-after-await'
      request.envelope.payloadFingerprint = '0'.repeat(64); state.transport.authenticatedCallerFingerprint = 'b'.repeat(64)
      state.transport.clientCapabilities.splice(0); ws.config.launch.repositories[0].agentHomeRoot = '/synthetic/changed-after-capture'
      gate.resolve()
      const result = await pending as AgentSessionMutationResult<AgentSessionAttachResult>
      assert.equal(result.ok, true); if (!result.ok) { throw new Error('Unexpected refusal') }
      state.transport.authenticatedCallerFingerprint = 'a'.repeat(64); state.transport.clientCapabilities.push(...capabilities)
      const alias = (await pool.query('SELECT * FROM durable_runtime.structured_session_aliases WHERE public_session_id=$1', [original.envelope.sessionId])).rows[0]
      assert.equal(alias.provider, 'claude'); assert.equal(alias.created_by, fingerprintAttachmentPrincipal('a'.repeat(64)))
      const retained = (await pool.query('SELECT m.launch_request,s.agent_id FROM durable_runtime.catalog_tab_metadata m JOIN durable_runtime.tabs t ON t.id=m.tab_id JOIN durable_runtime.sessions s ON s.id=t.session_id WHERE t.session_id=$1', [alias.session_id])).rows[0]
      assert.equal(retained.launch_request.server.agentHomePath, `/synthetic/structured/${ws.id}/homes/${retained.agent_id}`)
      assert.deepEqual(retained.launch_request.envelope, original.envelope)
      const beforeInvalid = await counts(pool)
      const bad = intent(ws.publicId); bad.envelope.payloadFingerprint = '0'.repeat(64)
      const refused = await state.invoke('agentSession.create', bad) as AgentSessionMutationResult<AgentSessionAttachResult>
      assert.equal(refused.ok, false)
      await assert.rejects(state.invoke('agentSession.create', intent(ws.publicId), { authenticatedCallerFingerprint: undefined }), /CATALOG_AUTHENTICATED_CALLER_REQUIRED/)
      await assert.rejects(state.invoke('agentSession.create', intent(foreign.publicId)), /selector_not_found/)
      await assert.rejects(state.invoke('agentSession.create', intent(ws.publicId, 'claude', { providerSessionId: 'synthetic-native-session' })), /STRUCTURED_RESUME_NOT_CONNECTED/)
      const attachId = `structured_${randomUUID().replaceAll('-', '_')}`
      const attachFields = { location: { executionHostId: 'local', wslDistro: null, workspaceId: ws.publicId, workspaceKind: 'folder' },
        provider: 'codex', agent: 'codex', accountHome: { variable: 'CODEX_HOME', path: '/synthetic/account' },
        runtimeKind: 'native', providerHandle: { kind: 'codex', threadId: 'synthetic-thread' } }
      const attach = { ...attachFields, envelope: { sessionId: attachId, clientOperationId: `attach:${randomUUID()}`, expectedRuntimeFence: null,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({ method: 'agentSession.attach', sessionId: attachId,
          fields: { ...attachFields, expectedRuntimeFence: null } }) } }
      await assert.rejects(state.invoke('agentSession.create', attach), /STRUCTURED_ATTACH_NOT_CONNECTED/)
      assert.deepEqual(await counts(pool), beforeInvalid)
      await withDurableTransaction(pool, async tx => {
        await appendSessionEvent(tx, { sessionId: alias.session_id,
          source: { kind: 'PRODUCER', sourceKind: 'SYNTHETIC_LATER', producerId: randomUUID(), incarnation: 'later', producerSeq: counter('sequence:producer', '1') },
          body: { kind: 'SYNTHETIC_LATER', version: 1 } })
        await tx.query("UPDATE durable_runtime.sessions SET lifecycle='CLOSED' WHERE id=$1", [alias.session_id])
        await tx.query("UPDATE durable_runtime.tabs SET lifecycle='CLOSED',closed_at=clock_timestamp() WHERE session_id=$1", [alias.session_id])
        await tx.query('UPDATE durable_runtime.workspaces SET deleted_at=clock_timestamp() WHERE id=$1', [ws.baseline.id])
        await tx.query('UPDATE durable_runtime.catalog_repositories SET deleted_at=clock_timestamp() WHERE id=$1', [ws.repoId])
      })
      const changed = setup(pool, { ...ws.config, launch: { ...ws.config.launch, repositories: [] } })
      try {
        const beforeReplay = await counts(pool)
        for (const replay of await Promise.all([changed.invoke('agentSession.create', original), changed.invoke('agentSession.create', original)])) {
          assert.deepEqual(replay, { ...result, replayed: true })
        }
        assert.deepEqual(await counts(pool), beforeReplay)
        const changedPayload = { ...original, agent: 'codex' }
        changedPayload.envelope = { ...original.envelope, payloadFingerprint: computeAgentSessionPayloadFingerprint({ method: 'agentSession.create',
          sessionId: original.envelope.sessionId, fields: { worktree: original.worktree, agent: changedPayload.agent } }) }
        await assert.rejects(changed.invoke('agentSession.create', changedPayload), /RECEIPT_PAYLOAD_CONFLICT/)
        assert.deepEqual(await counts(pool), beforeReplay); assert.deepEqual(changed.unexpected, [])
      } finally { changed.adapter.dispose() }
      assert.deepEqual(state.unexpected, [])
    } finally { gate.resolve(); state.adapter.dispose(); assert.equal(endCalls, 0) }
  })
})
