import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { LOCAL_HTTPS_TEST_CERTIFICATE, LOCAL_HTTPS_TEST_PRIVATE_KEY } from '../../browser/browser-local-https-test-certificate.ts'
import { ownOrcadController, type OrcadControllerOwner } from '../../orcad/orcad-controller.ts'
import { captureOrcadControllerConfig } from '../../orcad/orcad-controller-config.ts'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { CONTROLLER_SCOPE, CONTROLLER_DATASET } from '../ha/instance.ts'
import { gate, until, observedPool } from '../ha/worker-fixtures.mts'
import { initializeLifecycleScope } from './intent.ts'

if (process.env.ORCA_CONTROLLER_INVENTORY_APPROVED !== 'root-ready' ||
    !/^orca_controller_inventory_[a-z0-9_]+$/u.test(process.env.PGDATABASE ?? '')) {
  throw new Error('Root first inventory persistence assignment and isolated schema-ready database required')
}

test('actual startup inventory commits observation history without adopting targets or issuing execution authority', async t => {
  const actual = createDurablePool({ max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000 })
  const observer = createDurablePool({ max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000 })
  const directory = mkdtempSync(path.join(tmpdir(), 'orca-inventory-persistence-'))
  const sockets = new Set<Socket>(), owners: OrcadControllerOwner[] = []
  const unit = randomUUID(), operation = randomUUID(), foreignOperation = randomUUID(), attempt = randomUUID(), uid = `fixture-pod-${randomUUID()}`
  const namespace = 'fixture-controller-observation', name = `orca-unit-${operation}`
  const credential = 'fixture-controller-observation-only'
  let listObjects: unknown[] = [], watchEvents: unknown[] = [], watchRequests = 0
  let fault: 'NONE' | 'STALE' | 'OUTBOX_FAILURE' | 'UNKNOWN_COMMIT' | 'LATE_COMMIT' = 'NONE'
  let held = gate()
  const inventoryClients = new WeakSet<object>()
  const pool = observedPool(actual, async (sql, values, client, execute) => {
    if (sql.includes('SELECT o.id,u.dataset_name,o.controller_scope')) {
      inventoryClients.add(client)
      const result = await execute()
      if (fault === 'STALE') {
        fault = 'NONE'
        await observer.query(`UPDATE durable_runtime.controller_leases SET owner='fixture-successor',term=term+1,
          revision=revision+1 WHERE scope=$1`, [CONTROLLER_SCOPE])
      }
      return result
    }
    if (inventoryClients.has(client) && sql.includes('INSERT INTO durable_runtime.outbox_events') && fault === 'OUTBOX_FAILURE') {
      fault = 'NONE'
      return client.query('SELECT 1/0') // Real PG statement failure rolls the prior audit INSERT back.
    }
    const result = await execute()
    if (sql === 'COMMIT' && inventoryClients.delete(client)) {
      const selected = fault; fault = 'NONE'
      if (selected === 'UNKNOWN_COMMIT') {
        throw Object.assign(new Error('fixture loses original inventory COMMIT reply'), { code: 'ECONNRESET' })
      }
      if (selected === 'LATE_COMMIT') { held.signal(); await held.wait }
    }
    if (sql === 'ROLLBACK') { inventoryClients.delete(client) }
    return result
  })
  function pod(version: string, changes: Record<string, unknown> = {}) {
    return { apiVersion: 'v1', kind: 'Pod', metadata: { namespace, name, uid, resourceVersion: version,
      labels: { 'orca.dev/role': 'runtime-agent', 'orca.dev/dataset': CONTROLLER_DATASET, 'orca.dev/runtime-unit': unit },
      annotations: { 'orca.dev/operation-id': operation, 'orca.dev/execution-epoch': '0', 'orca.dev/spec-hash': 'a'.repeat(64) },
      ...changes } }
  }
  const server = createServer({ key: LOCAL_HTTPS_TEST_PRIVATE_KEY, cert: LOCAL_HTTPS_TEST_CERTIFICATE }, (request, response) => {
    const url = new URL(request.url ?? '', 'https://fixture.invalid')
    if (request.method !== 'GET' || request.headers.authorization !== `Bearer ${credential}` ||
        url.pathname !== `/api/v1/namespaces/${namespace}/pods`) { response.writeHead(403); response.end(); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    if (url.searchParams.get('watch') === 'true') {
      watchRequests++; response.end(watchEvents.map(event => JSON.stringify(event) + '\n').join(''))
    } else {
      response.end(JSON.stringify({ apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: 'opaque-list-rv' }, items: listObjects }))
    }
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  async function physicalRows() {
    const rows: Record<string, unknown> = {}
    for (const table of ['runtime_units', 'operations', 'attempts', 'execution_grants', 'storage_write_grants']) {
      rows[table] = (await observer.query(`SELECT to_jsonb(t) AS value FROM durable_runtime.${table} t ORDER BY id`)).rows
    }
    return rows
  }
  async function audits() {
    return (await observer.query(`SELECT id,next_state,producer_seq FROM durable_runtime.runtime_audit_events
      WHERE runtime_unit_id=$1 AND kind='CONTROLLER_INVENTORY_OBSERVATION' ORDER BY producer_seq`, [unit])).rows
  }
  async function outboxCount() {
    return (await observer.query(`SELECT count(*)::text AS n FROM durable_runtime.outbox_events
      WHERE aggregate_id=$1 AND event->>'kind'='CONTROLLER_INVENTORY_OBSERVATION'`, [unit])).rows[0].n
  }
  try {
    const ledger = (await observer.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
    await withDurableTransaction(observer, async tx => {
      await initializeLifecycleScope(tx)
      await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','READY')", [unit])
      await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0)", [unit])
      await tx.query(`INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,
        resource_profile_revision,effective_resources,status) VALUES($1,$2,0,'COLD',$3,'fixture',0,'{}','RUNNING')`, [attempt, unit, uid])
      await tx.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=$2 WHERE id=$1', [unit, attempt])
      await tx.query(`INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,
        controller_term,step,expected_pod_uid,execution_epoch,external_resource_name)
        VALUES($1,$2,'WAKE',0,$3,0,'ENSURE_ATTEMPT',$4,0,$5)`, [operation, unit, CONTROLLER_SCOPE, uid, name])
      await tx.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES('fixture-foreign-scope','unowned',0,'epoch')")
      await tx.query(`INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,
        controller_term,step,expected_pod_uid,execution_epoch,external_resource_name,result)
        VALUES($1,$2,'WAKE',0,'fixture-foreign-scope',0,'ENSURE_ATTEMPT',$3,0,$4,'{}')`, [foreignOperation, unit, uid, name])
      await tx.query(`INSERT INTO durable_runtime.execution_grants(id,runtime_unit_id,attempt_id,execution_epoch,state)
        VALUES($1,$2,$3,0,'ACTIVE')`, [randomUUID(), unit, attempt])
    })
    const before = await physicalRows()
    writeFileSync(`${directory}/ca.pem`, LOCAL_HTTPS_TEST_CERTIFICATE, { mode: 0o600 })
    writeFileSync(`${directory}/token`, credential, { mode: 0o600 })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => {
      server.off('error', reject); resolve()
    }) })
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const config = captureOrcadControllerConfig({ datasetName: CONTROLLER_DATASET, inventory: {
      namespace, dataset: CONTROLLER_DATASET, apiOrigin: `https://127.0.0.1:${address.port}`,
      caFile: `${directory}/ca.pem`, tokenFile: `${directory}/token`, requestTimeoutMs: 5000, watchTimeoutSeconds: 1, listLimit: 20 },
      policy: { lease: { revision: 'inventory-persistence-fixture', durationMs: 120000 }, renewIntervalMs: 60000,
        standbyPollIntervalMs: 100000, passPollIntervalMs: 100000, maximumWork: 10, externalBudgetMs: 20000 } })
    async function start() {
      const owner = ownOrcadController({ readConfig: { pool, datasetName: CONTROLLER_DATASET, hostId: 'local',
        readHostIdentity: () => 'local', repositoryIds: [], projectGroupIds: [], workspacePublicIds: [] }, stop: async () => {} })
      owners.push(owner); await owner.startController(config); return owner
    }
    async function completed(owner: OrcadControllerOwner) {
      await until(() => owner.controllerSnapshot().worker?.lastPass !== null && owner.controllerSnapshot().worker?.lastPass !== undefined)
    }
    await t.test('actual entry/worker/pass records once, replays once, rejects exact target conflicts and retains raw spec hash as unavailable', async () => {
      const changedSpec = pod('opaque-initial-rv', { annotations: { 'orca.dev/operation-id': operation,
        'orca.dev/execution-epoch': '0', 'orca.dev/spec-hash': 'b'.repeat(64) } })
      listObjects = [pod('opaque-initial-rv'), pod('wrong-name-rv', { name: 'another-name' }), pod('wrong-uid-rv', { uid: 'another-uid' }),
        pod('wrong-epoch-rv', { annotations: { 'orca.dev/operation-id': operation, 'orca.dev/execution-epoch': '1', 'orca.dev/spec-hash': 'a'.repeat(64) } }),
        pod('foreign-scope-rv', { annotations: { 'orca.dev/operation-id': foreignOperation, 'orca.dev/execution-epoch': '0', 'orca.dev/spec-hash': 'a'.repeat(64) } }),
        pod('unknown-rv', { labels: { 'orca.dev/role': 'runtime-agent', 'orca.dev/dataset': CONTROLLER_DATASET, 'orca.dev/runtime-unit': randomUUID() } })]
      watchEvents = [{ type: 'ADDED', object: pod('opaque-initial-rv') }, { type: 'ADDED', object: changedSpec },
        { type: 'MODIFIED', object: pod('opaque-modified-rv') }, { type: 'DELETED', object: pod('opaque-deleted-rv') },
        { type: 'BOOKMARK', object: { apiVersion: 'v1', kind: 'Pod', metadata: { resourceVersion: 'opaque-bookmark-rv' } } }]
      const owner = await start(); await completed(owner)
      const result = await audits(); assert.equal(result.length, 3); assert.equal(await outboxCount(), '3')
      assert.deepEqual(result.map(row => row.producer_seq), ['1', '2', '3'])
      assert.deepEqual(result.map(row => row.next_state.type), ['ADDED', 'MODIFIED', 'DELETED'])
      assert.ok(result.every(row => row.next_state.specHashVerification === 'UNAVAILABLE' && row.next_state.observedSpecHash === 'a'.repeat(64)))
      assert.equal(owner.controllerSnapshot().worker?.lastPass?.status, 'FINISHED')
      assert.equal(owner.controllerSnapshot().latestObservation?.persistence, 'CURSOR_ONLY')
      assert.equal(owner.controllerSnapshot().latestObservation?.counts.total, 5)
      assert.deepEqual(await physicalRows(), before); await owner.stop()
    })
    await t.test('BOOKMARK alone writes no inventory audit/outbox', async () => {
      listObjects = []; watchEvents = [{ type: 'BOOKMARK', object: { apiVersion: 'v1', kind: 'Pod', metadata: { resourceVersion: 'bookmark-only-rv' } } }]; const owner = await start(); await completed(owner)
      assert.equal((await audits()).length, 3); assert.equal(await outboxCount(), '3')
      assert.equal(owner.controllerSnapshot().latestObservation?.persistence, 'CURSOR_ONLY'); await owner.stop()
    })
    await t.test('actual lease change between pass gate and sink lock fails closed without a snapshot or audit', async () => {
      listObjects = [pod('stale-term-rv')]; watchEvents = []; fault = 'STALE'
      const owner = await start(); await completed(owner)
      assert.equal(owner.controllerSnapshot().worker?.lastPass?.status, 'STOPPED')
      assert.equal(owner.controllerSnapshot().latestObservation, null); assert.equal((await audits()).length, 3)
      await owner.stop()
      await observer.query("UPDATE durable_runtime.controller_leases SET expires_at='epoch' WHERE scope=$1", [CONTROLLER_SCOPE])
    })
    await t.test('actual outbox failure rolls back the audit; a lost real COMMIT reply is not success', async () => {
      listObjects = [pod('rollback-rv')]; fault = 'OUTBOX_FAILURE'
      const rollback = await start(); await completed(rollback); await rollback.stop()
      assert.equal(rollback.controllerSnapshot().latestObservation, null); assert.equal((await audits()).length, 3)
      listObjects = [pod('unknown-commit-rv')]; fault = 'UNKNOWN_COMMIT'
      const unknown = await start(); await completed(unknown); await unknown.stop()
      assert.equal(unknown.controllerSnapshot().latestObservation, null)
      assert.equal(unknown.controllerSnapshot().worker?.lastPass?.status, 'STOPPED')
      assert.equal((await audits()).length, 4, 'A real commit survived reply loss; no automatic replay is attempted')
      assert.equal(await outboxCount(), '4')
    })
    await t.test('stop retains a late sink promise until settlement and never advances its closed snapshot', async () => {
      listObjects = [pod('late-commit-rv')]; fault = 'LATE_COMMIT'; held = gate()
      const watchesBefore = watchRequests, owner = await start(); await held.entered
      const stopping = owner.stop(); let finished = false; void stopping.then(() => { finished = true })
      await until(() => owner.controllerSnapshot().worker?.lastPass?.status === 'STOPPED')
      assert.equal(finished, false); assert.equal(owner.controllerSnapshot().worker?.inFlight.callbacks, 1)
      assert.equal(owner.controllerSnapshot().latestObservation, null)
      held.release(); await stopping
      assert.equal(owner.controllerSnapshot().worker?.inFlight.callbacks, 0)
      assert.equal(owner.controllerSnapshot().latestObservation, null); assert.equal(watchRequests, watchesBefore)
      assert.equal((await audits()).length, 5); assert.equal(await outboxCount(), '5')
      assert.equal((await actual.query('SELECT 1 AS n')).rows[0].n, 1, 'Borrowed Pool remains usable')
    })
    assert.deepEqual(await physicalRows(), before)
    assert.deepEqual((await observer.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  } finally {
    held.release(); await Promise.allSettled(owners.map(owner => owner.stop()))
    for (const socket of sockets) { socket.destroy() }
    if (server.listening) { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
    await Promise.all([actual.end(), observer.end()]); rmSync(directory, { recursive: true, force: true })
  }
})
