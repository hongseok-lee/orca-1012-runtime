// Deferred isolated PG fixture: authority/provider proof are synthetic, not production authentication.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import type { AgentSessionCancelResult, AgentSessionMutationResult } from '../../../shared/agent-session-wire.ts'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope.ts'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version.ts'
import { createDurablePool } from '../db/connection.ts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { inputPayloadHash } from '../input/canonical.ts'
import { executionFixture, inExecution, fixed, type ExecutionFixture } from '../input/execution-fixtures.mts'
import { observeInputDeliveryInTransaction } from '../input/observe.ts'
import type { InputDeliveryObservation } from '../input/observation-types.ts'
import { createCatalogStructuredCancelRpc } from './structured-cancel.ts'
import { captureDurableCatalogReadConfig } from './config.ts'
import { fixtureConfig, fixtureRuntime, fixtureContext } from './fixture-support.mts'

async function seed(pool: Pool) {
  const f = await executionFixture(pool), namespace = `synthetic-public-cancel-${randomUUID()}`
  const scope = (await pool.query('SELECT w.id,w.public_id FROM durable_runtime.sessions s JOIN durable_runtime.workspaces w ON w.id=s.workspace_id WHERE s.id=$1',[f.authority.sessionId])).rows[0]
  const publicSessionId = `structured_${randomUUID().replaceAll('-', '_')}`, repoId = `${namespace}-repo`
  const path = `/synthetic/public-cancel/${namespace}`
  const repo = { id: repoId, path, displayName: repoId, kind: 'folder', executionHostId: 'local', badgeColor: '#ffffff', addedAt: 1 }
  const payload = { id: scope.public_id, repoId, path, head: '', branch: '', displayName: namespace, comment: '',
    isBare: false, isMainWorktree: true, sortOrder: 0, lastActivityAt: 1, linkedIssue: null, linkedPR: null,
    linkedLinearIssue: null, parentWorktreeId: null, childWorktreeIds: [], lineage: null,
    git: { path, head: '', branch: '', isBare: false, isMainWorktree: true }, isArchived: false, isUnread: false, isPinned: false }
  // New UUID-owned Catalog rows only. Do not change shared Catalog heads/UI or pre-existing rows.
  await inExecution(pool,f,async tx => {
    await tx.query("UPDATE durable_runtime.agents SET provider='claude' WHERE id=(SELECT agent_id FROM durable_runtime.sessions WHERE id=$1)",[f.authority.sessionId])
    await tx.query('UPDATE durable_runtime.sessions SET session_fence=1 WHERE id=$1',[f.authority.sessionId])
    await tx.query("UPDATE durable_runtime.messages SET intake_status='EFFECT_POSSIBLE' WHERE id=$1",[f.messageId])
    await tx.query('INSERT INTO durable_runtime.catalog_repositories(id,payload) VALUES($1,$2)',[repoId,JSON.stringify(repo)])
    await tx.query(`INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,repo_id,reserved_path,payload,create_request,runtime_unit_id)
      VALUES($1,'REPO_FOLDER',$2,$3,$4,'{}',$5)`,[scope.id,repoId,path,JSON.stringify(payload),f.context.runtimeUnitId])
    await tx.query(`INSERT INTO durable_runtime.structured_session_aliases
      (public_session_id,session_id,workspace_id,provider,execution_host_id,location,original_create,created_by)
      VALUES($1,$2,$3,'claude','local',$4,'{}',$5)`,[publicSessionId,f.authority.sessionId,scope.id,
      JSON.stringify({ workspaceId: scope.public_id, executionHostId: 'local', wslDistro: null, workspaceKind: 'folder' }),f.authority.principal])
  })
  return { f, namespace, scope, publicSessionId, repoId, repo, payload }
}
async function delivery(pool: Pool, f: ExecutionFixture) {
  const id = randomUUID()
  await inExecution(pool,f,tx => tx.query(`INSERT INTO durable_runtime.delivery_attempts
    (id,message_id,session_id,runtime_unit_id,attempt_id,execution_epoch,state,effect_possible_at,provider_ref)
    VALUES($1,$2,$3,$4,$5,$6,'EFFECT_POSSIBLE',clock_timestamp(),$7)`,
    [id,f.messageId,f.authority.sessionId,f.context.runtimeUnitId,f.attemptId,f.envelope.executionEpoch,`synthetic-native-${f.authority.sessionId}`]))
  return id
}
async function observe(pool: Pool, f: ExecutionFixture, deliveryId: string, turnId: string, state: 'ADMITTED' | 'SETTLED' | 'INTERRUPTED') {
  // This assertion supplies the fixture's synthetic opaque brand, never real provider authentication.
  const observation = { kind: state, proof: { ...fixed(f,deliveryId), targetMessageId: f.messageId,
    kind: state === 'ADMITTED' ? 'PROVIDER_ADMISSION' : state === 'SETTLED' ? 'PROVIDER_TARGET_COMPLETED' : 'PROVIDER_TARGET_STOPPED',
    source: 'PROVIDER_PROTOCOL', evidenceRef: `synthetic-public-cancel-proof-${randomUUID()}`, observedAt: new Date().toISOString(),
    providerRef: { provider: 'claude', nativeSessionRef: `synthetic-native-${f.authority.sessionId}`, nativeTurnId: turnId } }
  } as unknown as InputDeliveryObservation
  await inExecution(pool,f,tx => observeInputDeliveryInTransaction(tx,f.authority,fixed(f,deliveryId),observation))
}
async function snapshot(pool: Pool, f: ExecutionFixture) {
  return (await pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.version) FROM durable_runtime.schema_migrations r) AS ledger,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.messages r WHERE r.session_id=$1) AS messages,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.delivery_attempts r WHERE r.session_id=$1) AS deliveries,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.operation_id) FROM durable_runtime.cancel_intents r WHERE r.session_id=$1) AS cancels,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.session_context_records r WHERE r.session_id=$1) AS contexts,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.seq) FROM durable_runtime.session_events r WHERE r.session_id=$1) AS journal,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM durable_runtime.outbox_events r WHERE r.aggregate_id=$1 OR r.aggregate_id=$2) AS outbox,
    (SELECT to_jsonb(r) FROM durable_runtime.runtime_units r WHERE r.id=$2) AS unit,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.principal_id,r.session_scope,r.method,r.operation_key) FROM durable_runtime.rpc_receipts r WHERE r.session_scope=$3) AS receipts`,
    [f.authority.sessionId,f.context.runtimeUnitId,JSON.stringify(['structured-session',publicAlias.get(f.authority.sessionId)])])).rows[0]
}
const publicAlias = new Map<string,string>()
async function stored(pool: Pool, f: ExecutionFixture, key: string) {
  const result = await pool.query(`SELECT r.payload_hash,r.response,e.event_id,e.journal_epoch,e.seq,e.body,
    ci.target_message_id,ci.target_provider_turn_ref,ci.interrupt_status,o.event AS outbox
    FROM durable_runtime.rpc_receipts r JOIN durable_runtime.session_events e ON e.session_id=$1
      AND e.journal_epoch=(r.response->'cursor'->>'epoch')::bigint AND e.seq=(r.response->'cursor'->>'sequence')::bigint
    JOIN durable_runtime.cancel_intents ci ON ci.operation_id=(e.body->>'operationId')::uuid
    LEFT JOIN durable_runtime.outbox_events o ON o.id=e.event_id
    WHERE r.principal_id=$2 AND r.session_scope=$3 AND r.method='agentSession.cancel' AND r.operation_key=$4`,
    [f.authority.sessionId,fingerprintAttachmentPrincipal('a'.repeat(64)),JSON.stringify(['structured-session',publicAlias.get(f.authority.sessionId)]),key])
  assert.equal(result.rowCount,1)
  return result.rows[0]
}

await test('PG1 actual cancel handler는 원 turn·receipt-first·권한과 기존 wire 완료 의미를 보존합니다', async t => {
  assert.equal(process.env.ORCA_PUBLIC_STRUCTURED_CANCEL_APPROVED,'root-source-reviewed')
  const database = process.env.ORCA_PUBLIC_STRUCTURED_CANCEL_DATABASE, oid = process.env.ORCA_PUBLIC_STRUCTURED_CANCEL_DATABASE_OID
  assert.ok(database && database.startsWith('orca_')); assert.notEqual(database,'orca_dev'); assert.equal(process.env.PGDATABASE,database)
  assert.match(oid ?? '',/^[1-9][0-9]*$/); assert.notEqual(oid,'90361','PR75 DB is not this fixture execution database')
  const pool = createDurablePool({ database, max: 3 })
  t.after(async () => { await pool.end() })
  const actual = (await pool.query(`SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system,pg_backend_pid() AS backend_pid,
    (SELECT jsonb_agg(dataset_name ORDER BY dataset_name) FROM durable_runtime.dataset_metadata) AS datasets`)).rows[0]
  t.diagnostic(JSON.stringify({ phase: 'before-seed', ...actual }))
  assert.equal(actual.database,database); assert.equal(actual.oid,oid); assert.equal(actual.system,'7696101282789175327')
  assert.deepEqual(actual.datasets,['orca-1012-dev-v1']); assert.ok(Number.isInteger(actual.backend_pid) && actual.backend_pid > 0)
  const ledger = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length,19)
  const state = await seed(pool), { f, namespace, publicSessionId } = state
  publicAlias.set(f.authority.sessionId,publicSessionId)
  const native = fixtureRuntime(), config = { ...fixtureConfig(pool), repositoryIds: [state.repoId] }
  const context = fixtureContext(native.runtime,{ clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] })
  const handler = createCatalogStructuredCancelRpc(captureDurableCatalogReadConfig(config))
  function params(turnId: string, key = `synthetic-cancel:${randomUUID()}`, extra: { scope?: 'background-tasks'; taskId?: string } = {}, fence = 1) {
    const fields = { turnId, ...extra }
    return { ...fields, envelope: { sessionId: publicSessionId, clientOperationId: key, expectedRuntimeFence: fence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({ method: 'agentSession.cancel', sessionId: publicSessionId, fields }) } }
  }
  const invoke = (request: unknown, run = handler) => run(request,context) as Promise<AgentSessionMutationResult<AgentSessionCancelResult>>
  const turnA = `${namespace}-A`, turnB = `${namespace}-B`, a = await delivery(pool,f), b = await delivery(pool,f)
  await observe(pool,f,a,turnA,'ADMITTED'); await observe(pool,f,b,turnB,'SETTLED')
  const before = await snapshot(pool,f), unchangedB = before.deliveries.find((row: { id: string }) => row.id === b)
  assert.equal(before.messages[0].intake_status,'SETTLED','B completion must not complete A')
  const original = params(turnA), first = await invoke(original)
  assert.equal(first.ok,true); if (!first.ok) { throw new Error('Unexpected cancel refusal') }
  assert.equal(first.value.turnId,turnA); assert.equal(first.value.cancelled,false); assert.equal(first.replayed,false); assert.equal(first.fence,1)
  const saved = await stored(pool,f,original.envelope.clientOperationId)
  assert.equal(saved.interrupt_status,'REQUESTED'); assert.equal(saved.target_provider_turn_ref,turnA)
  assert.equal(saved.target_message_id,f.messageId); assert.equal(saved.body.fixedDelivery.deliveryAttemptId,a)
  assert.equal(saved.body.fixedDelivery.nativeTurnId,turnA); assert.equal(saved.body.fixedDelivery.provider,'claude')
  assert.equal(saved.outbox.kind,'INTERRUPT_FIXED_DELIVERY'); assert.equal(saved.outbox.fixedDelivery.deliveryAttemptId,a)
  assert.equal(saved.payload_hash,inputPayloadHash({ turnId: turnA })); assert.deepEqual(saved.response.value,first.value)
  assert.deepEqual(first.cursor,{ epoch: saved.journal_epoch, sequence: Number(saved.seq) })
  assert.deepEqual((await snapshot(pool,f)).deliveries.find((row: { id: string }) => row.id === b),unchangedB)
  assert.deepEqual((await snapshot(pool,f)).unit,before.unit,'cancel creates no desired/intent/activity/wake')
  const completed = params(turnB), done = await invoke(completed)
  assert.equal(done.ok,true); if (!done.ok) { throw new Error('Unexpected completed refusal') }
  assert.equal(done.value.cancelled,false)
  assert.equal((await stored(pool,f,completed.envelope.clientOperationId)).outbox,null)
  await observe(pool,f,a,turnA,'INTERRUPTED')
  const stopped = params(turnA), stop = await invoke(stopped)
  assert.equal(stop.ok,true); if (!stop.ok) { throw new Error('Unexpected stop refusal') }
  assert.equal(stop.value.cancelled,true)
  assert.equal((await stored(pool,f,stopped.envelope.clientOperationId)).outbox,null)
  async function noMutation(request: unknown, run: typeof handler, code: RegExp) {
    const prior = await snapshot(pool,f)
    await assert.rejects(invoke(request,run),code)
    assert.deepEqual(await snapshot(pool,f),prior)
  }
  await noMutation(params(turnB,original.envelope.clientOperationId),handler,/RECEIPT_PAYLOAD_CONFLICT/)
  await noMutation(params(turnA,undefined,{ scope: 'background-tasks', taskId: `${namespace}-task` }),handler,/STRUCTURED_BACKGROUND_CANCEL_NOT_CONNECTED/)
  const denied = createCatalogStructuredCancelRpc(captureDurableCatalogReadConfig({ ...config, repositoryIds: [] }))
  await noMutation(params(turnA),denied,/selector_not_found/)
  const wrongDataset = createCatalogStructuredCancelRpc(captureDurableCatalogReadConfig({ ...config, datasetName: 'synthetic-other-dataset' }))
  await noMutation(params(turnA),wrongDataset,/CATALOG_DATASET_MISMATCH/)
  await pool.query('UPDATE durable_runtime.catalog_repositories SET payload=$2 WHERE id=$1',[state.repoId,{ ...state.repo, executionHostId: 'runtime:synthetic-foreign' }])
  await noMutation(params(turnA),handler,/CATALOG_REGISTRATION_HOST_MISMATCH/)
  await pool.query('UPDATE durable_runtime.catalog_repositories SET payload=$2 WHERE id=$1',[state.repoId,state.repo])
  await pool.query('UPDATE durable_runtime.catalog_workspace_metadata SET payload=$2 WHERE workspace_id=$1',[state.scope.id,{ ...state.payload, hostId: 'runtime:synthetic-foreign' }])
  await noMutation(params(turnA),handler,/CATALOG_REGISTRATION_HOST_MISMATCH/)
  await pool.query('UPDATE durable_runtime.catalog_workspace_metadata SET payload=$2 WHERE workspace_id=$1',[state.scope.id,state.payload])
  const priorReplay = await snapshot(pool,f)
  assert.deepEqual(await invoke(original),{ ...first, replayed: true },'later original stop never rewrites the first false receipt')
  assert.deepEqual(await snapshot(pool,f),priorReplay)
  await pool.query('UPDATE durable_runtime.sessions SET session_fence=session_fence+1 WHERE id=$1',[f.authority.sessionId])
  await noMutation(params(turnA),handler,/INPUT_STALE_FENCE/)
  const fenced = await snapshot(pool,f)
  assert.deepEqual(await invoke(original),{ ...first, replayed: true }); assert.deepEqual(await snapshot(pool,f),fenced)
  await pool.query("UPDATE durable_runtime.sessions SET lifecycle='CLOSED' WHERE id=$1",[f.authority.sessionId])
  await pool.query('UPDATE durable_runtime.workspaces SET deleted_at=clock_timestamp() WHERE id=$1',[state.scope.id])
  const closed = await snapshot(pool,f)
  assert.deepEqual(await invoke(original),{ ...first, replayed: true }); assert.deepEqual(await snapshot(pool,f),closed)
  await noMutation(params(turnA,undefined,{},2),handler,/INPUT_SESSION_CLOSED/)
  await noMutation(params(turnA),denied,/selector_not_found/)
  assert.deepEqual((await snapshot(pool,f)).unit,before.unit)
  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows,ledger)
  assert.deepEqual(native.unexpected,[],'no native host/ensure/wake/provider interrupt/fallback')
})
