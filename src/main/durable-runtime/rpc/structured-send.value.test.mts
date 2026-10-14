import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { createCatalogStructuredSendRpc } from './structured-send.ts'
import { captureDurableCatalogReadConfig } from './config.ts'
import { fixtureConfig, fixtureRuntime, fixtureContext, deferred } from './fixture-support.mts'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope.ts'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY, CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY } from '../../../shared/protocol-version.ts'

if (process.env.ORCA_PUBLIC_STRUCTURED_SEND_APPROVED !== 'root-source-reviewed') {
  throw new Error('Root source review is required before the first structured send value callback')
}
// Fake SQL below observes capture only. It is not PG/auth/provider qualification.
test('공개 send는 strict wire와 인증·협상 거절 및 첫 await 이전의 원 입력·context·config capture를 보존합니다', async () => {
  const gate = deferred<void>(), publicSessionId = `structured_${randomUUID().replaceAll('-', '_')}`
  const workspaceId = randomUUID(), sessionId = randomUUID(), workspacePublicId = `ws_${randomUUID()}`
  const seen: { sql: string; values: unknown[] }[] = []
  let connects = 0, releases = 0, ends = 0, wait = false
  const workspace = { workspace_id: workspaceId, public_id: workspacePublicId, kind: 'FOLDER_WORKSPACE',
    repo_id: null, project_group_id: 'allowed-group', reserved_path: '/synthetic/source',
    payload: { id: workspacePublicId, projectGroupId: 'allowed-group', name: 'fixture', folderPath: '/synthetic/source',
      comment: '', createdAt: 1, updatedAt: 1, lastActivityAt: 1, sortOrder: 0,
      isArchived: false, isUnread: false, isPinned: false } }
  const client = { async query(sql: string, values: unknown[] = []) {
    seen.push({ sql, values })
    if (sql.includes('dataset_metadata')) { return { rows: [{ dataset_name: 'orca-1012-dev-v1' }], rowCount: 1 } }
    if (sql.includes('SELECT a.public_session_id')) {
      assert.equal(values[0], publicSessionId)
      return { rows: [{ public_session_id: publicSessionId, session_id: sessionId, workspace_id: workspaceId,
        actual_workspace_id: workspaceId, public_id: workspacePublicId, provider: 'claude', actual_provider: 'claude',
        execution_host_id: 'local', agent_dataset: 'orca-1012-dev-v1', workspace_dataset: 'orca-1012-dev-v1' }], rowCount: 1 }
    }
    if (sql.includes('catalog_workspace_metadata')) { return { rows: [workspace], rowCount: 1 } }
    return { rows: [], rowCount: 0 }
  }, release() { releases++ } }
  const owner = { async connect() { assert.equal(this, owner); connects++; if (wait) { await gate.promise }; return client },
    async query() { throw new Error('Value fixture must not enter input core') }, end() { ends++ } }
  const pool = owner as unknown as Pool
  const configuration = { ...captureDurableCatalogReadConfig({ ...fixtureConfig(pool), projectGroupIds: ['allowed-group'] }),
    projectGroupIds: ['allowed-group'] }
  const run = createCatalogStructuredSendRpc(configuration), runtimeFixture = fixtureRuntime()
  let policy = true
  const runtime = new Proxy(runtimeFixture.runtime, { get(target, key, receiver) {
    return key === 'getClientSettings' ? () => ({ experimentalStructuredNativeChat: policy }) : Reflect.get(target, key, receiver)
  } })
  const capabilities = [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY, CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY]
  const context = fixtureContext(runtime, { clientCapabilities: [...capabilities] })
  const body = { kind: 'message', role: 'user', blocks: [{ type: 'image-ref', url: 'https://example.invalid/original.png', alt: 'original alt' }] }
  const params = { body, envelope: { sessionId: publicSessionId, clientOperationId: 'capture-original', expectedRuntimeFence: 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({ method: 'agentSession.send', sessionId: publicSessionId, fields: { body } }) } }
  await assert.rejects(run({}, context))
  await assert.rejects(run(params, { ...context, authenticatedCallerFingerprint: undefined }), /CATALOG_AUTHENTICATED_CALLER_REQUIRED/)
  await assert.rejects(run(params, { ...context, authenticatedCallerFingerprint: 'invalid' }), /CATALOG_AUTHENTICATED_CALLER_REQUIRED/)
  const refusal = await run({ ...params, envelope: { ...params.envelope, payloadFingerprint: 'f'.repeat(64) } }, context)
  assert.equal((refusal as { ok: boolean }).ok, false)
  await assert.rejects(run(params, { ...context, clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] }), /PENDING_SEND_CAPABILITY/)
  await assert.rejects(run(params, { ...context, clientCapabilities: [AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY] }), /unsupported/)
  policy = false; await assert.rejects(run(params, context), /unsupported/); policy = true
  assert.equal(connects, 0)
  await assert.rejects(run(params, { ...context, clientCapabilities: capabilities.filter(x => x !== CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY) }), /CLAUDE_CAPABILITY_MISSING/)
  wait = true
  const pending = run(params, context)
  params.envelope.sessionId = `structured_${randomUUID().replaceAll('-', '_')}`
  params.body.blocks[0].url = 'https://example.invalid/changed.png'
  Object.assign(params.body.blocks[0], { type: 'text', text: 'changed after await' })
  Object.assign(context, { authenticatedCallerFingerprint: 'b'.repeat(64), clientCapabilities: [] })
  policy = false; configuration.projectGroupIds.length = 0
  Object.assign(configuration, { datasetName: 'changed', hostId: 'foreign' })
  owner.connect = async () => { throw new Error('Captured connect was replaced') }
  gate.resolve()
  await assert.rejects(pending, /STRUCTURED_IMAGE_URL_NOT_CONNECTED/)
  assert.equal(releases, 2); assert.equal(ends, 0); assert.equal(Object.isFrozen(owner), false)
  assert.ok(seen.some(x => x.sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ'))
  assert.ok(seen.every(x => !x.sql.includes('READ ONLY')))
  assert.deepEqual(runtimeFixture.unexpected, [])
})
