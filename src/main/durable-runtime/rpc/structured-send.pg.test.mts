import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { registerCatalogProject, type CatalogRegistration } from '../catalog/register.ts'
import { captureCatalogReadContext } from './context.ts'
import { captureDurableCatalogReadConfig } from './config.ts'
import { DurableCatalogReadAdapter } from './public.ts'
import { fixtureConfig, fixtureRuntime, fixtureContext } from './fixture-support.mts'
import { eraseRpcMethods } from '../../runtime/rpc/core.ts'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher.ts'
import { WORKTREE_METHODS } from '../../runtime/rpc/methods/worktree.ts'
import { SESSION_TAB_METHODS } from '../../runtime/rpc/methods/session-tabs.ts'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../../runtime/rpc/methods/structured-agent-session.ts'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope.ts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { saveAttachmentImage, startAttachmentUpload, reserveAttachmentAlias } from '../attachments/store.ts'
import { attachmentUploadId } from '../attachments/types.ts'
import type { AgentSessionSendResult } from '../../../shared/agent-session-wire.ts'
import type { AgentSessionAttachResult, AgentSessionMutationResult } from '../../../shared/agent-session-wire.ts'
import type { CatalogWireResults } from '../catalog/wire.ts'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY, CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY, AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY } from '../../../shared/protocol-version.ts'

// Source only. Root supplies an exact already prepared owned database; no migration/reset.
if (process.env.ORCA_PUBLIC_STRUCTURED_SEND_APPROVED !== 'root-source-reviewed' ||
    !process.env.ORCA_PUBLIC_STRUCTURED_SEND_DB || process.env.ORCA_PUBLIC_STRUCTURED_SEND_DB !== process.env.PGDATABASE ||
    !(process.env.PGDATABASE ?? '').startsWith('orca_') || process.env.PGDATABASE === 'orca_dev') {
  throw new Error('Root review and exact owned structured send database required')
}
const methods = eraseRpcMethods([...WORKTREE_METHODS, ...SESSION_TAB_METHODS, ...STRUCTURED_AGENT_SESSION_METHODS])
const capabilities = [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY, CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY, AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY]
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

// Source fixture intentionally requires the actual future public wiring; no test injection replaces it.
await test('PG1 실제 registry send는 receipt-first·원 입력·scope·COMMITTED owner alias를 보존하며 물리 실행을 만들지 않습니다', async t => {
  const pool = createDurablePool({ max: 4 })
  t.after(async () => { await pool.end() })
  const probe = setup(pool, configuration(pool, randomUUID()))
  try {
    const raw = methods.find(x => x.name === 'agentSession.send')
    const bound = probe.adapter.bind(methods).find(x => x.name === 'agentSession.send')
    assert.ok(raw && bound)
    assert.notEqual(bound.handler, raw.handler, 'Root가 public.ts/registry.ts 실제 send 배선을 승인·연결한 뒤에만 PG fixture를 실행합니다')
  } finally { probe.adapter.dispose() }
  const ws = await fixture(pool), state = setup(pool, ws.config)
  try {
    const created = intent(ws.publicId, 'claude')
    await state.invoke('agentSession.create', created)
    const publicSessionId = created.envelope.sessionId
    const alias = (await pool.query('SELECT * FROM durable_runtime.structured_session_aliases WHERE public_session_id=$1', [publicSessionId])).rows[0]
    const principal = fingerprintAttachmentPrincipal(state.transport.authenticatedCallerFingerprint)
    const otherPrincipal = fingerprintAttachmentPrincipal('b'.repeat(64))
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
    const ownerImage = await withDurableTransaction(pool, tx => saveAttachmentImage(tx, {
      id: attachmentUploadId(randomUUID()), principal, contentBase64: png, aliasRoot: `/synthetic/images/${ws.id}` }))
    const otherImage = await withDurableTransaction(pool, tx => saveAttachmentImage(tx, {
      id: attachmentUploadId(randomUUID()), principal: otherPrincipal, contentBase64: png, aliasRoot: `/synthetic/other/${ws.id}` }))
    const openId = attachmentUploadId(randomUUID())
    await withDurableTransaction(pool, tx => startAttachmentUpload(tx, { id: openId, principal, expectedBase64Length: png.length }))
    function send(body: unknown, key = `send:${randomUUID()}`) {
      return { body, envelope: { sessionId: publicSessionId, clientOperationId: key, expectedRuntimeFence: 1,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({ method: 'agentSession.send', sessionId: publicSessionId, fields: { body } }) } }
    }
    const text = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: '  same original\ntext  ' }] }
    const inputCounts = async () => (await pool.query(`SELECT
      (SELECT count(*)::integer FROM durable_runtime.input_components WHERE session_id=$1) AS inputs,
      (SELECT count(*)::integer FROM durable_runtime.structured_submissions WHERE session_id=$1) AS submissions,
      (SELECT count(*)::integer FROM durable_runtime.session_events WHERE session_id=$1 AND body->>'kind'='INPUT_SUBMISSION') AS events,
      (SELECT count(*)::integer FROM durable_runtime.rpc_receipts WHERE method='agentSession.send' AND session_scope=$2) AS receipts`,
      [alias.session_id, JSON.stringify(['structured-session', publicSessionId])])).rows[0]
    const physicalBefore = await physical(pool)
    assert.deepEqual(physicalBefore, { attempts: 0, execution_grants: 0, storage_grants: 0, verification: 0 })
    const firstParams = send(text), first = await state.invoke('agentSession.send', firstParams) as AgentSessionMutationResult<AgentSessionSendResult>
    assert.equal(first.ok, true); if (!first.ok) { throw new Error('Unexpected send refusal') }
    assert.equal(first.value.submission.dispatchState, 'pending'); assert.equal(first.value.submission.providerItemId, null)
    const initial = await inputCounts()
    assert.deepEqual(initial, { inputs: 1, submissions: 1, events: 1, receipts: 1 })
    assert.deepEqual(await state.invoke('agentSession.send', firstParams), { ...first, replayed: true })
    const conflict = send({ ...text, blocks: [{ type: 'text', text: 'different' }] }, firstParams.envelope.clientOperationId)
    await assert.rejects(state.invoke('agentSession.send', conflict), /RECEIPT_PAYLOAD_CONFLICT/)
    await state.invoke('agentSession.send', send(text))
    const imageBody = { kind: 'message', role: 'user', blocks: [
      { type: 'text', text: 'before' }, { type: 'image-ref', path: ownerImage.aliasPath, alt: ' first ' },
      { type: 'text', text: 'between' }, { type: 'image-ref', path: ownerImage.aliasPath, alt: ' second ' }] }
    const imageParams = send(imageBody)
    await state.invoke('agentSession.send', imageParams)
    const saved = (await pool.query(`SELECT i.*,s.client_message_id,s.wire_payload_fingerprint,s.journal_sequence,
      e.body AS event_body,r.response AS receipt_response
      FROM durable_runtime.input_components i JOIN durable_runtime.structured_submissions s ON s.input_id=i.id
      JOIN durable_runtime.session_events e ON e.session_id=i.session_id AND e.seq=s.journal_sequence
      JOIN durable_runtime.rpc_receipts r ON r.principal_id=s.principal_id AND r.operation_key=s.client_message_id AND r.method='agentSession.send'
      WHERE i.session_id=$1 AND s.client_message_id=$2`, [alias.session_id, imageParams.envelope.clientOperationId])).rows[0]
    assert.ok(saved); assert.deepEqual(saved.body_or_blob_ref.payload.body, imageBody)
    assert.deepEqual(saved.body_or_blob_ref.attachments, [0, 1].map(() => ({ aliasPath: ownerImage.aliasPath, contentHash: ownerImage.contentHash })))
    assert.equal(saved.authenticated_sender, principal); assert.equal(saved.event_body.inputId, saved.id)
    assert.equal(saved.event_body.messageId, saved.message_id)
    assert.equal(saved.wire_payload_fingerprint, imageParams.envelope.payloadFingerprint)
    assert.equal(saved.receipt_response.value.submission.dispatchState, 'pending')
    const positions = (await pool.query('SELECT position,blob_ref,content_hash FROM durable_runtime.input_attachments WHERE input_id=$1 ORDER BY position', [saved.id])).rows
    assert.deepEqual(positions.map(x => [x.position, x.blob_ref, x.content_hash]), [0, 1].map(index => [String(index), ownerImage.aliasPath, ownerImage.contentHash]))
    const unit = (await pool.query('SELECT desired_mode,reconcile_due_at FROM durable_runtime.runtime_units WHERE id=$1', [ws.baseline.runtime_unit_id])).rows[0]
    assert.equal(unit.desired_mode, 'RUNNING'); assert.ok(unit.reconcile_due_at)
    const beforeRejected = await inputCounts()
    const image = (path: string) => ({ kind: 'message', role: 'user', blocks: [{ type: 'image-ref', path }] })
    for (const path of [otherImage.aliasPath, `/synthetic/missing/${randomUUID()}`, reserveAttachmentAlias(`/synthetic/images/${ws.id}`, openId)]) {
      await assert.rejects(state.invoke('agentSession.send', send(image(path))), /ALIAS_NOT_FOUND/)
    }
    await assert.rejects(state.invoke('agentSession.send', send({ kind: 'message', role: 'user', blocks: [
      { type: 'image-ref', url: 'https://example.invalid/not-connected.png' }] })), /STRUCTURED_IMAGE_URL_NOT_CONNECTED/)
    const denied = setup(pool, { ...ws.config, repositoryIds: [], workspacePublicIds: [], projectGroupIds: [] })
    try { await assert.rejects(denied.invoke('agentSession.send', send(text)), /selector_not_found/) }
    finally { denied.adapter.dispose() }
    await assert.rejects(state.invoke('agentSession.send', send(image(ownerImage.aliasPath)), { authenticatedCallerFingerprint: 'b'.repeat(64) }), /ALIAS_NOT_FOUND/)
    assert.deepEqual(await inputCounts(), beforeRejected)
    assert.deepEqual(beforeRejected, { inputs: 3, submissions: 3, events: 3, receipts: 3 })
    await withDurableTransaction(pool, async tx => {
      await tx.query("UPDATE durable_runtime.sessions SET session_fence=session_fence+1,lifecycle='CLOSED' WHERE id=$1", [alias.session_id])
      await tx.query("UPDATE durable_runtime.tabs SET lifecycle='CLOSED',closed_at=clock_timestamp() WHERE session_id=$1", [alias.session_id])
      await tx.query('UPDATE durable_runtime.workspaces SET deleted_at=clock_timestamp() WHERE id=$1', [alias.workspace_id])
    })
    assert.deepEqual(await state.invoke('agentSession.send', firstParams), { ...first, replayed: true })
    await assert.rejects(state.invoke('agentSession.send', send(text)))
    assert.deepEqual(await inputCounts(), beforeRejected)
    assert.deepEqual(await physical(pool), physicalBefore)
    assert.deepEqual(state.unexpected, [])
  } finally { state.adapter.dispose() }
})
