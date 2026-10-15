import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { createCatalogStructuredCancelRpc } from './structured-cancel.ts'
import { captureDurableCatalogReadConfig } from './config.ts'
import { fixtureConfig, fixtureRuntime, fixtureContext, deferred } from './fixture-support.mts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { inputPayloadHash } from '../input/canonical.ts'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope.ts'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version.ts'

if (process.env.ORCA_PUBLIC_STRUCTURED_CANCEL_APPROVED !== 'root-source-reviewed') {
  throw new Error('Root source review is required before the first structured cancel value callback')
}

// Fake SQL/receipt below observes the real handler's capture only, not PG/auth/provider qualification.
test('공개 cancel handler는 strict wire·cleanup 정책·동기 capture와 receipt-first 반환을 보존합니다', async () => {
  const publicSessionId = `structured_${randomUUID().replaceAll('-', '_')}`
  const sessionId = randomUUID(), workspaceId = randomUUID(), publicId = `synthetic-cancel-${randomUUID()}`
  const turnId = `synthetic-turn-${randomUUID()}`, fingerprint = 'a'.repeat(64)
  const principal = fingerprintAttachmentPrincipal(fingerprint), gate = deferred<void>()
  const seen: { sql: string; values: readonly unknown[] }[] = []
  let connects = 0, releases = 0, ends = 0, wait = false
  const workspace = { workspace_id: workspaceId, public_id: publicId, kind: 'FOLDER_WORKSPACE',
    repo_id: null, project_group_id: 'allowed-group', reserved_path: '/synthetic/cancel',
    payload: { id: publicId, projectGroupId: 'allowed-group', name: 'synthetic cancel', folderPath: '/synthetic/cancel',
      comment: '', createdAt: 1, updatedAt: 1, lastActivityAt: 1, sortOrder: 0,
      isArchived: false, isUnread: false, isPinned: false } }
  const saved = { fence: 1, cursor: { epoch: '0', sequence: 7 }, value: { turnId, cancelled: false } }
  const client = { async query(sql: string, values: readonly unknown[] = []) {
    assert.equal(this,client)
    seen.push({ sql, values })
    if (sql.includes('dataset_metadata')) {
      return { rows: [{ dataset_name: 'orca-1012-dev-v1' }], rowCount: 1 }
    }
    if (sql.includes('SELECT a.public_session_id')) {
      assert.equal(values[0],publicSessionId)
      return { rows: [{ public_session_id: publicSessionId, session_id: sessionId, workspace_id: workspaceId,
        actual_workspace_id: workspaceId, public_id: publicId, provider: 'claude', actual_provider: 'claude',
        execution_host_id: 'local', agent_dataset: 'orca-1012-dev-v1', workspace_dataset: 'orca-1012-dev-v1' }], rowCount: 1 }
    }
    if (sql.includes('catalog_workspace_metadata')) { return { rows: [workspace], rowCount: 1 } }
    if (sql.includes('SELECT a.*,s.workspace_id')) {
      assert.equal(values[0],publicSessionId)
      return { rows: [{ public_session_id: publicSessionId, session_id: sessionId, workspace_id: workspaceId,
        actual_workspace_id: workspaceId, workspace_public_id: publicId, provider: 'claude', execution_host_id: 'local',
        location: {} }], rowCount: 1 }
    }
    if (sql === 'SELECT id FROM durable_runtime.sessions WHERE id=$1') {
      assert.equal(values[0],sessionId)
      return { rows: [{ id: sessionId }], rowCount: 1 }
    }
    if (sql.includes('SELECT payload_hash,response')) {
      assert.deepEqual(values,[principal,JSON.stringify(['structured-session',publicSessionId]),'agentSession.cancel','capture-original'])
      return { rows: [{ payload_hash: inputPayloadHash({ turnId }), response: saved,
        committed_at: new Date('2026-10-15T00:00:00Z'), intake_at: null }], rowCount: 1 }
    }
    if (sql === 'COMMIT') { return { command: 'COMMIT', rows: [], rowCount: 0 } }
    return { rows: [], rowCount: 0 }
  }, release() { assert.equal(this,client); releases++ } }
  const owner = { async connect() { assert.equal(this,owner); connects++; if (wait) { await gate.promise }; return client },
    async query() { assert.equal(this,owner); throw new Error('Unexpected direct Pool query') },
    end() { ends++ } }
  const pool = owner as unknown as Pool
  const config = { ...captureDurableCatalogReadConfig({ ...fixtureConfig(pool), projectGroupIds: ['allowed-group'] }),
    projectGroupIds: ['allowed-group'] }
  const run = createCatalogStructuredCancelRpc(config), native = fixtureRuntime()
  const context = fixtureContext(native.runtime,{ clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] })
  const params = { turnId, envelope: { sessionId: publicSessionId, clientOperationId: 'capture-original', expectedRuntimeFence: 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({ method: 'agentSession.cancel', sessionId: publicSessionId, fields: { turnId } }) } }
  await assert.rejects(run({},context))
  await assert.rejects(run({ ...params, messageId: randomUUID() },context),'internal UUID is not a strict CancelParams field')
  await assert.rejects(run({ ...params, taskId: 'synthetic-task' },context),'taskId requires background scope')
  await assert.rejects(run(params,{ ...context, authenticatedCallerFingerprint: undefined }),/CATALOG_AUTHENTICATED_CALLER_REQUIRED/)
  await assert.rejects(run(params,{ ...context, authenticatedCallerFingerprint: 'invalid' }),/CATALOG_AUTHENTICATED_CALLER_REQUIRED/)
  const refusal = await run({ ...params, envelope: { ...params.envelope, payloadFingerprint: 'f'.repeat(64) } },context)
  assert.equal((refusal as { ok: boolean }).ok,false)
  await assert.rejects(run(params,{ ...context, clientCapabilities: [] }),/unsupported/)
  assert.equal(connects,0,'strict/auth/capability refusals perform no intended I/O')
  // Setting is OFF; Claude/pending-send extra capabilities are intentionally absent for cleanup.
  assert.deepEqual(await run(params,context),{ ok: true, replayed: true, ...saved })
  assert.equal(connects,4,'current Catalog authorization, immutable alias/scope discovery and P103 receipt read')
  assert.deepEqual(native.unexpected,[],'no native host creation/ensure/wake/interrupt/fallback')
  wait = true
  const pending = run(params,context)
  params.turnId = 'changed-after-first-await'
  params.envelope.sessionId = `structured_${randomUUID().replaceAll('-', '_')}`
  params.envelope.clientOperationId = 'changed-operation'
  params.envelope.expectedRuntimeFence = 2
  Object.assign(context,{ authenticatedCallerFingerprint: 'b'.repeat(64), clientKind: 'runtime', clientCapabilities: [] })
  config.projectGroupIds.length = 0
  Object.assign(config,{ datasetName: 'changed', hostId: 'foreign', assertCurrentHost() { throw new Error('Replaced host method') } })
  owner.connect = async () => { throw new Error('Replaced connect method') }
  owner.query = async () => { throw new Error('Replaced query method') }
  gate.resolve()
  assert.deepEqual(await pending,{ ok: true, replayed: true, ...saved })
  assert.equal(connects,8); assert.equal(releases,8); assert.equal(ends,0)
  assert.ok(seen.some(item => item.sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'))
  assert.ok(seen.every(item => !/\b(?:INSERT|UPDATE|DELETE)\b/.test(item.sql)))
  assert.equal(Object.isFrozen(owner),false,'borrowed Pool remains owned by the caller')
  assert.deepEqual(native.unexpected,[])
})
