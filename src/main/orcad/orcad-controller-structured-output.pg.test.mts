import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { counter, logicalId } from '../../shared/durable-runtime/identity.ts'
import { LOCAL_HTTPS_TEST_CERTIFICATE, LOCAL_HTTPS_TEST_PRIVATE_KEY } from '../browser/browser-local-https-test-certificate.ts'
import { createDurablePool } from '../durable-runtime/db/connection.ts'
import type { JsonValue } from '../durable-runtime/db/atomic.ts'
import { readMigrations } from '../durable-runtime/db/migrate.ts'
import { registerEventProducer, enqueueRuntimeEvent } from '../durable-runtime/events/store.ts'
import { listDueReconciliations } from '../durable-runtime/lifecycle/due.ts'
import type { VerifiedWorkloadIdentity } from '../durable-runtime/runtime/runtime-evidence.ts'
import { captureOrcadControllerConfig } from './orcad-controller-config.ts'
import { ownOrcadController, type OrcadControllerOwner } from './orcad-controller.ts'

// Source만 제출합니다. Root가 지정한 격리 DB와 exact SQL 입력을 최초 배분 때 제공하며 여기서는 migration을 적용하지 않습니다.
if (process.env.ORCA_STRUCTURED_STARTUP_APPROVED !== 'root-ready' || !/^orca_p114_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? '')) {
  throw new Error('Root의 최초 실행 배분과 별도 소유 PG가 필요합니다.')
}

await test('실제 startup의 structured 출력 선택 소비는 reconcile 후보보다 먼저 같은 원 사건을 commit하고 빌린 Pool을 보존한다', async () => {
  const pool = createDurablePool({ max: 3, application_name: 'orca-p114-structured-startup-fixture',
    connectionTimeoutMillis: 5000, statement_timeout: 15000 })
  const dir = mkdtempSync(path.join(tmpdir(), 'orca-controller-structured-pg-')), sockets = new Set<Socket>()
  const owners: OrcadControllerOwner[] = [], serverErrors: string[] = []
  let catalogStops = 0
  const namespace = 'fixture-structured-output', dataset = 'orca-1012-dev-v1', token = 'fixture-synthetic-structured-inventory'
  const server = createServer({ key: LOCAL_HTTPS_TEST_PRIVATE_KEY, cert: LOCAL_HTTPS_TEST_CERTIFICATE }, (request, response) => {
    const url = new URL(request.url ?? '', 'https://fixture.invalid')
    if (request.headers.authorization !== `Bearer ${token}` || request.method !== 'GET' ||
        url.pathname !== `/api/v1/namespaces/${namespace}/pods` ||
        url.searchParams.get('labelSelector') !== `orca.dev/role=runtime-agent,orca.dev/dataset=${dataset}`) {
      serverErrors.push('SYNTHETIC_INVENTORY_BOUNDARY'); response.writeHead(403); response.end(); return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(url.searchParams.get('watch') === 'true'
      ? `${JSON.stringify({ type: 'BOOKMARK', object: { apiVersion: 'v1', kind: 'Pod', metadata: { resourceVersion: 'fixture-watch' } } })}\n`
      : JSON.stringify({ apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: 'fixture-list' }, items: [] }))
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  // 실제 snapshot/PG 결과를 조건으로 기다립니다. 고정 sleep을 첫 pass 완료의 대용으로 사용하지 않습니다.
  async function observed(check: () => boolean): Promise<void> {
    for (let n = 0; n < 500; n++) { if (check()) { return }; await delay(10) }
    assert.fail('소유 fixture의 실제 worker 결과를 관측하지 못했습니다.')
  }
  async function physicalRows() {
    const rows: Record<string, unknown> = {}
    for (const table of ['runtime_units', 'operations', 'runtime_commands', 'attempts', 'execution_grants', 'storage_write_grants', 'storage_mounts']) {
      rows[table] = (await pool.query(`SELECT to_jsonb(t) AS value FROM durable_runtime.${table} t ORDER BY id`)).rows
    }
    return rows
  }
  try {
    assert.ok(process.env.P114_STRUCTURED_MIGRATIONS, 'Root가 고정한 SQL 입력 디렉터리가 필요합니다.')
    const expected = await readMigrations(process.env.P114_STRUCTURED_MIGRATIONS)
    const ledger = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
    assert.equal(expected.length, 19)
    assert.deepEqual(ledger.map(({ version, checksum }) => ({ version, checksum })), expected.map(({ version, checksum }) => ({ version, checksum })))
    const agentId = logicalId('agent', randomUUID()), workspaceId = randomUUID(), sessionId = logicalId('session', randomUUID())
    const unitIds = [logicalId('runtime-unit', randomUUID()), logicalId('runtime-unit', randomUUID())]
    const attemptId = logicalId('attempt', randomUUID()), producerId = logicalId('producer', randomUUID()), eventId = logicalId('event', randomUUID())
    const storage = randomUUID(), incarnation = `fixture-incarnation-${randomUUID()}`, podUid = `fixture-seed-${randomUUID()}`
    const publicSessionId = `fixture_structured_${randomUUID().replaceAll('-', '')}`
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'claude')", [agentId])
      await client.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'fixture-structured-startup','READY')", [workspaceId, randomUUID()])
      for (const unit of unitIds) {
        await client.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase,execution_epoch) VALUES($1,'RUNNING','ABSENT',1)", [unit])
      }
      await client.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision,updated_at) VALUES($1,0,'{}',0,clock_timestamp())", [unitIds[0]])
      // 원 producer binding용 STOPPED seed 행 1개입니다. Pod/provider/새 물리 실행을 만들지 않습니다.
      await client.query("INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,resource_profile_revision,effective_resources,status) VALUES($1,$2,1,'COLD',$3,$4,0,'{}','STOPPED')", [attemptId, unitIds[0], podUid, incarnation])
      await client.query("INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,'fixture-export')", [storage])
      await client.query("INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state) VALUES($1,$2,'fixture-export',$3,'RO')", [storage, storage, `/synthetic/structured/${storage}`])
      await client.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'CLOSED')", [sessionId, agentId, workspaceId])
      await client.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)', [unitIds[0], sessionId, storage])
      await client.query("INSERT INTO durable_runtime.structured_session_aliases(public_session_id,session_id,workspace_id,provider,execution_host_id,location,original_create,created_by) VALUES($1,$2,$3,'claude','local','{}','{}','fixture-only')", [publicSessionId, sessionId, workspaceId])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: 격리 fixture의 합성 producer 입력이며 실제 workload 인증이나 controller 권한 발급 증거가 아닙니다.
    const workload = { attemptId, producerId, incarnation, podUid, executionEpoch: counter('execution-epoch', '1'),
      principalRef: 'fixture-not-authenticated', authenticationEvidenceRef: 'fixture-not-auth-proof' } as unknown as VerifiedWorkloadIdentity
    const producer = { workload, agentId, runtimeUnitId: unitIds[0] }
    await registerEventProducer(pool, producer)
    const payload: JsonValue = { version: 1, kind: 'STRUCTURED_PROVIDER_OUTPUT', publicSessionId, provider: 'claude',
      observedAt: '2026-10-14T16:00:00.000Z', source: { kind: 'PRODUCER' }, mutation: { kind: 'item', itemId: 'synthetic-item', revision: 1,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: '합성 startup 출력' }] } } }
    await enqueueRuntimeEvent(pool, producer, { eventId, sequence: counter('sequence:producer', '1'), payload, targetSessionIds: [sessionId] })
    const due = await listDueReconciliations(pool)
    assert.ok(unitIds.every(id => due.includes(id)))
    assert.ok(unitIds.length > 1)
    const before = await physicalRows()
    writeFileSync(`${dir}/ca.pem`, LOCAL_HTTPS_TEST_CERTIFICATE, { mode: 0o600 })
    writeFileSync(`${dir}/token`, token, { mode: 0o600 })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const config = (enabled: boolean) => captureOrcadControllerConfig({ datasetName: dataset, inventory: {
      apiOrigin: `https://127.0.0.1:${address.port}`, namespace, dataset, caFile: `${dir}/ca.pem`, tokenFile: `${dir}/token`,
      requestTimeoutMs: 1000, watchTimeoutSeconds: 1, listLimit: 10 }, policy: {
      lease: { revision: 'structured-startup-fixture-v1', durationMs: 5000 }, renewIntervalMs: 1000,
      standbyPollIntervalMs: 50, passPollIntervalMs: 60000, maximumWork: 1, externalBudgetMs: 3000 },
      ...(enabled ? { structuredOutput: { claimDurationMs: 1000 } } : {}) })
    function owner() {
      // Pool은 이 fixture caller가 소유합니다. 원 Catalog stop receiver는 기록만 하고 worker 종료 뒤에도 Pool을 열어 둡니다.
      const result = ownOrcadController({ readConfig: { pool, datasetName: dataset, hostId: 'local', readHostIdentity: () => 'local',
        repositoryIds: ['synthetic-repository'], projectGroupIds: [], workspacePublicIds: [] }, stop: async () => { catalogStops++ } })
      owners.push(result); return result
    }
    const inert = owner()
    await inert.startController(config(false))
    await observed(() => inert.controllerSnapshot().worker?.lastPass?.status === 'FINISHED')
    const first = inert.controllerSnapshot().worker; assert.ok(first?.confirmedLease)
    assert.ok(first.lastPass?.items.some(item => item.kind === 'INVENTORY' && item.disposition === 'OBSERVED'))
    assert.equal(first.lastPass?.items.some(item => item.kind === 'RECONCILE' || item.kind === 'QUEUE'), false)
    const pending = (await pool.query('SELECT state,attempt_count FROM durable_runtime.runtime_event_queue WHERE event_id=$1', [eventId])).rows[0]
    assert.deepEqual(pending, { state: 'PENDING', attempt_count: '0' })
    const inertStop = inert.stop(); assert.equal(inertStop, inert.stop()); await inertStop
    assert.equal(inert.controllerSnapshot().worker?.lastRelease?.status, 'RELEASED')
    assert.equal((await pool.query('SELECT 1 AS open')).rows[0].open, 1)
    const enabled = owner()
    await enabled.startController(config(true))
    await observed(() => enabled.controllerSnapshot().worker?.lastPass?.items.some(item => item.kind === 'QUEUE' &&
      item.identity === eventId && item.disposition === 'DONE') === true)
    const next = enabled.controllerSnapshot().worker; assert.ok(next?.confirmedLease)
    assert.equal(next.confirmedLease.scope, first.confirmedLease.scope)
    assert.notEqual(next.confirmedLease.owner, first.confirmedLease.owner)
    assert.equal(BigInt(next.confirmedLease.term), BigInt(first.confirmedLease.term) + 1n)
    assert.equal(next.lastPass?.items.some(item => item.kind === 'RECONCILE'), false)
    const rows = (await pool.query(`SELECT j.event_id,j.seq,j.body,j.source_key,o.id AS outbox_id,o.revision,o.event,
      q.event_id AS original_event_id,q.state,q.attempt_count,r.principal_id,r.operation_key,r.response,
      j.xmin::text AS journal_xid,o.xmin::text AS outbox_xid,q.xmin::text AS queue_xid,r.xmin::text AS receipt_xid
      FROM durable_runtime.session_events j JOIN durable_runtime.outbox_events o ON o.id=j.event_id
      JOIN durable_runtime.runtime_event_queue q ON q.event_id=$1
      JOIN durable_runtime.rpc_receipts r ON r.session_scope='runtime-event:'||q.event_id::text AND r.method='runtime-event.process'
      WHERE j.session_id=$2 AND j.body->>'kind'='STRUCTURED_PROVIDER_OUTPUT'`, [eventId, sessionId])).rows
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.deepEqual(row.body, payload); assert.deepEqual(row.event, payload)
    assert.equal(row.event_id, row.outbox_id); assert.equal(row.seq, row.revision)
    assert.equal(row.original_event_id, eventId); assert.equal(row.state, 'DONE'); assert.equal(row.attempt_count, '1')
    assert.equal(row.principal_id, next.confirmedLease.owner)
    logicalId('claim', row.operation_key)
    assert.deepEqual(row.response, { eventId, state: 'DONE' })
    assert.ok([row.outbox_xid, row.queue_xid, row.receipt_xid].every(xid => xid === row.journal_xid))
    assert.deepEqual(JSON.parse(row.source_key), ['v1', sessionId, 'producer', 'STRUCTURED_PROVIDER_OUTPUT', producerId, incarnation, '1'])
    const history = (await pool.query("SELECT controller_term FROM durable_runtime.runtime_event_attempt_history WHERE event_id=$1 AND stage='STARTED'", [eventId])).rows
    assert.deepEqual(history, [{ controller_term: next.confirmedLease.term }])
    const stop = enabled.stop(); assert.equal(stop, enabled.stop()); await stop
    assert.equal(enabled.controllerSnapshot().worker?.lastRelease?.status, 'RELEASED')
    assert.equal(catalogStops, 2)
    assert.equal((await pool.query('SELECT 1 AS open')).rows[0].open, 1)
    assert.deepEqual(await physicalRows(), before)
    assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
    assert.deepEqual(serverErrors, [])
  } finally {
    try { await Promise.allSettled(owners.map(value => value.stop())) } finally {
      for (const socket of sockets) { socket.destroy() }
      if (server.listening) { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
      try { await pool.end() } finally { rmSync(dir, { recursive: true, force: true }) }
    }
  }
})
