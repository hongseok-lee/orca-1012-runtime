import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
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
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation.ts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { prepareInputRequest } from '../input/canonical.ts'
import { appendInputComponent } from '../input/append.ts'
import { appendSessionEvent } from '../journal/store.ts'
import { counter, logicalId, type SessionId } from '../../../shared/durable-runtime/identity.ts'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key.ts'
import type { AgentSessionHistoryResult, AgentSessionMutationResult, AgentSessionAttachResult } from '../../../shared/agent-session-wire.ts'
import type { CatalogWireResults } from '../catalog/wire.ts'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY, CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY } from '../../../shared/protocol-version.ts'

// Read dependency: corrected PR64 product d4399f7705b2d6110ebbf5aeb2ce2f69316c23c6.
// Source only: future Root dispatch supplies the exact prepared isolated DB. No DDL/reset/delete.
if (process.env.ORCA_PUBLIC_STRUCTURED_HISTORY_APPROVED !== 'root-source-reviewed' ||
    !process.env.ORCA_PUBLIC_STRUCTURED_HISTORY_DB || process.env.ORCA_PUBLIC_STRUCTURED_HISTORY_DB !== process.env.PGDATABASE ||
    !(process.env.PGDATABASE ?? '').startsWith('orca_') || process.env.PGDATABASE === 'orca_dev') {
  throw new Error('Root review and exact owned structured history database required')
}
const methods = eraseRpcMethods([...WORKTREE_METHODS, ...SESSION_TAB_METHODS, ...STRUCTURED_AGENT_SESSION_METHODS])
const capabilities = [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY, CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY]
const ui = { lastActiveRepoId: null, lastActiveWorktreeId: null, activeView: 'terminal', sidebarWidth: 240,
  rightSidebarOpen: false, rightSidebarTab: 'explorer', rightSidebarExplorerView: 'files', rightSidebarWidth: 320,
  groupBy: 'none', sortBy: 'smart', projectOrderBy: 'manual', showActiveOnly: false, hideDefaultBranchWorkspace: false,
  filterRepoIds: [], collapsedGroups: [], uiZoomLevel: 0, editorFontZoomLevel: 0, worktreeCardProperties: [],
  statusBarItems: [], statusBarVisible: true, dismissedUpdateVersion: null, lastUpdateCheckAt: null }
function configuration(pool: Pool, id: string) {
  const repoId = `synthetic-history:${id}`, root = `/synthetic/history/${id}`
  return { ...fixtureConfig(pool), repositoryIds: [repoId], launch: {
    policy: { operationDeadlineMs: 30000, idleDurationMs: null }, repositories: [{ repositoryId: repoId,
      worktreeRoot: `${root}/worktrees`, agentHomeRoot: `${root}/homes`, storage: {
        backendId: `synthetic-history-backend:${id}`, exportId: 'synthetic-export', localDirectory: root,
        canonicalDirectory: `/authority/history/${id}` } }] } }
}
function setup(config: ReturnType<typeof configuration>) {
  const owner = fixtureRuntime()
  const runtime = new Proxy(owner.runtime, { get(target, property, receiver) {
    if (property === 'getClientSettings') { return () => ({ experimentalStructuredNativeChat: true }) }
    return Reflect.get(target, property, receiver)
  } })
  const adapter = new DurableCatalogReadAdapter(config)
  const dispatcher = new RpcDispatcher({ runtime, methods: adapter.bind(methods) })
  const invoke = async (method: string, params: unknown, fingerprint: string | null | undefined = 'a'.repeat(64)) => {
    const result = await dispatcher.dispatch({ id: randomUUID(), method, params, authToken: '' },
      { authenticatedCallerFingerprint: fingerprint ?? undefined, clientKind: 'mobile', clientCapabilities: [...capabilities] })
    if (!result.ok) { throw new Error(result.error.message) }
    return result.result
  }
  return { ...owner, runtime, adapter, invoke }
}
async function appendInput(pool: Pool, sessionId: SessionId, publicSessionId: string, fingerprint: string, clientMessageId: string) {
  const principal = fingerprintAttachmentPrincipal(fingerprint)
  const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: '  exact original history input\n' }] }
  const wireFingerprint = structuredAgentSessionPayloadFingerprint({ method: 'agentSession.send', sessionId: publicSessionId, fields: { body } })
  return withDurableTransaction(pool, async tx => {
    await lockAggregates(tx, { sessionIds: [sessionId] })
    const prepared = prepareInputRequest({ authority: { principal, sessionId, scope: { kind: 'SESSION' } },
      method: 'agentSession.send', operationKey: clientMessageId, inputKind: 'GENERAL', sessionFence: counter('session-fence', '1'),
      payload: { body }, attachments: [] })
    const appended = await appendInputComponent(tx, prepared)
    const event = await appendSessionEvent(tx, { sessionId,
      source: { kind: 'PRODUCER', sourceKind: 'INPUT_SUBMISSION', producerId: sessionId,
        incarnation: 'durable-input-v1', producerSeq: counter('sequence:producer', appended.inputSequence) },
      body: { kind: 'INPUT_SUBMISSION', ...appended, originalPayloadHash: prepared.identity.payloadHash } })
    await tx.query(`INSERT INTO durable_runtime.structured_submissions(input_id,message_id,session_id,principal_id,
      client_message_id,wire_payload_fingerprint,wire_fence,journal_epoch,journal_sequence,submitted_at)
      VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9)`, [appended.inputId, appended.messageId, sessionId, principal,
      clientMessageId, wireFingerprint, event.journalEpoch, event.sequence, event.recordedAt])
    return { ...appended, event, wireFingerprint }
  })
}
async function storedState(pool: Pool, sessionId: SessionId) {
  const tables = ['sessions', 'agents', 'tabs', 'runtime_units', 'runtime_members', 'attempts', 'operations',
    'execution_grants', 'storage_write_grants', 'rpc_receipts', 'outbox_events', 'session_events',
    'structured_submissions', 'input_components', 'messages', 'schema_migrations'] as const
  const result: Record<string, unknown> = {}
  for (const table of tables) {
    // Literal fixture allowlist only; full row equality exposes unexpected wake/provider/receipt effects.
    result[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM durable_runtime.${table} t ORDER BY to_jsonb(t)::text`)).rows
  }
  result.session = (await pool.query('SELECT to_jsonb(s) AS row FROM durable_runtime.sessions s WHERE id=$1', [sessionId])).rows
  return result
}

test('PG1 실제 공개 adapter·Catalog·alias·RR reader·projector·history 경계', async t => {
  const pool = createDurablePool({ max: 4, application_name: 'orca-public-structured-history-first' })
  t.after(async () => { await pool.end() })
  const ledger = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length, 19, 'Root supplies SQL001–019; the fixture never applies schema')
  const id = randomUUID(), config = configuration(pool, id), state = setup(config)
  t.after(() => state.adapter.dispose())
  const authority = captureCatalogReadContext(captureDurableCatalogReadConfig(config), fixtureContext(state.runtime)).authority
  const repoId = config.repositoryIds[0], launch = config.launch.repositories[0]
  await registerCatalogProject(pool, authority, { mutationId: `history-register:${id}`, group: null, ui,
    repo: { id: repoId, path: `${launch.storage.localDirectory}/repo`, displayName: repoId, kind: 'folder',
      executionHostId: 'local', badgeColor: '#ffffff', addedAt: 1 } } as CatalogRegistration)
  await withDurableTransaction(pool, async tx => { await tx.query(
    'INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2)', [launch.storage.backendId, launch.storage.exportId]) })
  const workspace = await state.invoke('worktree.create', { repo: `id:${repoId}`, name: 'existing', clientMutationId: `history-workspace:${id}` }) as CatalogWireResults['worktree.create']
  const publicSessionId = `structured_${randomUUID().replaceAll('-', '_')}`, fields = { worktree: `id:${workspace.worktree.id}`, agent: 'codex' }
  const operationKey = `history-create:${id}`
  const reservation = await state.invoke('agentSession.create', { ...fields, envelope: { sessionId: publicSessionId,
    clientOperationId: operationKey, expectedRuntimeFence: null,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({ method: 'agentSession.create', sessionId: publicSessionId, fields }) } }) as AgentSessionMutationResult<AgentSessionAttachResult>
  assert.equal(reservation.ok, true)
  const alias = (await pool.query('SELECT a.*,s.agent_id FROM durable_runtime.structured_session_aliases a JOIN durable_runtime.sessions s ON s.id=a.session_id WHERE a.public_session_id=$1', [publicSessionId])).rows[0]
  const sessionId = logicalId('session', alias.session_id)
  assert.notEqual(sessionId, publicSessionId)
  const receipt = (await pool.query('SELECT principal_id,response FROM durable_runtime.rpc_receipts WHERE method=$1 AND operation_key=$2', ['agentSession.create', operationKey])).rows[0]
  assert.equal(receipt.principal_id, fingerprintAttachmentPrincipal('a'.repeat(64)))
  assert.equal(receipt.response.reservation.sessionId, sessionId)
  const own = await appendInput(pool, sessionId, publicSessionId, 'a'.repeat(64), 'same-history-key')
  const foreign = await appendInput(pool, sessionId, publicSessionId, 'b'.repeat(64), 'same-history-key')
  await withDurableTransaction(pool, async tx => {
    await appendSessionEvent(tx, { sessionId, source: { kind: 'PRODUCER', sourceKind: 'STRUCTURED_PROVIDER_OUTPUT',
      producerId: sessionId, incarnation: 'synthetic-history-output', producerSeq: counter('sequence:producer', '1') },
      body: { kind: 'STRUCTURED_PROVIDER_OUTPUT', version: 1, publicSessionId, provider: 'codex',
        observedAt: '2026-10-14T17:00:00.000Z', source: { kind: 'PRODUCER' },
        mutation: { kind: 'item', itemId: 'synthetic-provider-item', revision: 1,
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'synthetic provider output' }] } } } })
    await tx.query("UPDATE durable_runtime.sessions SET lifecycle='CLOSED',session_fence=17 WHERE id=$1", [sessionId])
    await tx.query("UPDATE durable_runtime.tabs SET lifecycle='CLOSED',closed_at=clock_timestamp() WHERE session_id=$1", [sessionId])
  })
  const before = await storedState(pool, sessionId)
  const transactions: { statements: string[]; released: number }[] = []
  const entered = deferred<void>(), resume = deferred<void>()
  let gateConnect = false
  const observedPool = new Proxy(pool, { get(target, property) {
    if (property === 'end') { return () => { throw new Error('Borrowed Pool end forbidden') } }
    if (property === 'connect') { return async () => {
      if (gateConnect) { gateConnect = false; entered.resolve(); await resume.promise }
      const client = await target.connect(), trace = { statements: [] as string[], released: 0 }
      transactions.push(trace)
      // Fixture-only instrumented actual client; no replacement query results.
      return { query: async (sql: string, values?: unknown[]) => {
        trace.statements.push(sql); return client.query(sql, values)
      }, release: (destroy?: boolean) => { trace.released++; client.release(destroy) } } as unknown as PoolClient
    } }
    const value = Reflect.get(target, property)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const observed = setup({ ...config, pool: observedPool })
  t.after(() => observed.adapter.dispose())
  const history = async (params: unknown, fingerprint?: string) => await observed.invoke('agentSession.history', params, fingerprint) as AgentSessionHistoryResult
  const request = { sessionId: publicSessionId, direction: 'tail' }
  const result = await history(request)
  assert.equal(result.ok, true); assert.equal(result.page.fence, 17); assert.equal(result.page.epoch, '0')
  assert.deepEqual(result.page.items.map(item => item.itemId), [agentJournalSubmissionKey('same-history-key'), `input:${foreign.inputId}`, 'synthetic-provider-item'])
  assert.equal(result.page.submissions.length, 1); assert.equal(result.page.submissions[0].payloadFingerprint, own.wireFingerprint)
  assert.equal(result.page.submissions[0].dispatchState, 'pending'); assert.equal(result.page.submissions[0].providerItemId, null)
  assert.equal(result.page.liveCursor?.sequence, 4)
  assert.equal(transactions.length, 1); assert.equal(transactions[0].released, 1)
  assert.equal(transactions[0].statements[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(transactions[0].statements.at(-1), 'COMMIT')
  assert.equal(transactions[0].statements.filter(sql => sql.includes('structured_session_aliases')).length, 2)
  assert.ok(transactions[0].statements.some(sql => sql.includes('input_components')))
  const mutableRequest = { sessionId: publicSessionId, direction: 'tail', limit: 40 }
  const mutableCapabilities = [...capabilities]
  const mutableContext = fixtureContext(observed.runtime, { clientCapabilities: mutableCapabilities })
  gateConnect = true
  const detached = observed.adapter.history(mutableRequest, mutableContext)
  await entered.promise
  mutableRequest.sessionId = `structured_${randomUUID().replaceAll('-', '_')}`
  mutableRequest.direction = 'after'; mutableRequest.limit = 1
  mutableContext.authenticatedCallerFingerprint = 'b'.repeat(64)
  mutableContext.clientKind = undefined; mutableCapabilities.splice(0)
  mutableContext.runtime = fixtureRuntime().runtime
  resume.resolve()
  assert.deepEqual(await detached, result)
  const other = await history(request, 'b'.repeat(64))
  assert.deepEqual(other.page.items.map(item => item.itemId), [`input:${own.inputId}`, agentJournalSubmissionKey('same-history-key'), 'synthetic-provider-item'])
  assert.equal(other.page.submissions[0].payloadFingerprint, foreign.wireFingerprint)
  const after = await history({ sessionId: publicSessionId, direction: 'after', cursor: { epoch: '0', sequence: 1 }, limit: 1 })
  assert.equal(after.page.window.nextCursor.sequence, 2); assert.equal(after.page.submissions.length, 1)
  await assert.rejects(state.invoke('agentSession.history', request, null), /CATALOG_AUTHENTICATED_CALLER_REQUIRED/)
  await assert.rejects(history({ ...request, principal: 'a'.repeat(64) }), /schema|parameter|unrecognized|UNREADABLE/i)
  const denied = setup({ ...config, repositoryIds: [] })
  const wrongHost = setup({ ...config, hostId: 'foreign-host', readHostIdentity: () => 'foreign-host' })
  try {
    await assert.rejects(denied.invoke('agentSession.history', request), /STRUCTURED_HISTORY_ALIAS_SCOPE/)
    await assert.rejects(wrongHost.invoke('agentSession.history', request), /HOST_MISMATCH|ALIAS_SCOPE/)
    assert.deepEqual(denied.unexpected, []); assert.deepEqual(wrongHost.unexpected, [])
  } finally { denied.adapter.dispose(); wrongHost.adapter.dispose() }
  assert.deepEqual(await storedState(pool, sessionId), before)
  assert.deepEqual(state.unexpected, [])
  // A stored alias with a real Session/Workspace but mismatched Agent provider is malformed.
  // Prepare it once in the fixture, then verify the failed read performs zero writes.
  const malformedSession = logicalId('session', randomUUID())
  const malformedPublic = `structured_${randomUUID().replaceAll('-', '_')}`
  await withDurableTransaction(pool, async tx => {
    await tx.query(`INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle,session_fence)
      VALUES($1,$2,$3,'CLOSED',0)`, [malformedSession, alias.agent_id, alias.workspace_id])
    await tx.query(`INSERT INTO durable_runtime.structured_session_aliases(public_session_id,session_id,workspace_id,
      provider,execution_host_id,location,original_create,created_by) VALUES($1,$2,$3,'claude','local','{}','{}',$4)`,
      [malformedPublic, malformedSession, alias.workspace_id, fingerprintAttachmentPrincipal('a'.repeat(64))])
  })
  const beforeMalformed = await storedState(pool, sessionId)
  await assert.rejects(history({ sessionId: malformedPublic, direction: 'tail' }), /STRUCTURED_HISTORY_ALIAS_SCOPE/)
  assert.deepEqual(await storedState(pool, sessionId), beforeMalformed)
  // Unknown durable rows are preserved and rejected explicitly, never blank tail/missing fallback.
  await withDurableTransaction(pool, async tx => { await appendSessionEvent(tx, { sessionId,
    source: { kind: 'PRODUCER', sourceKind: 'SYNTHETIC_UNKNOWN_HISTORY', producerId: sessionId,
      incarnation: 'synthetic-history-unknown', producerSeq: counter('sequence:producer', '1') },
    body: { kind: 'INPUT_OBSERVATION', version: 1 } }) })
  const beforeUnknown = await storedState(pool, sessionId)
  await assert.rejects(history(request), /STRUCTURED_HISTORY_UNPROJECTED_EVENT/)
  assert.deepEqual(await storedState(pool, sessionId), beforeUnknown)
  assert.equal(transactions.at(-1)?.statements.at(-1), 'ROLLBACK')
  assert.ok(transactions.every(trace => trace.released === 1))
  assert.deepEqual(observed.unexpected, [])
  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  // Synthetic dispatcher context is not actual pairing, iPhone, CLI, Pod or HA evidence.
})
