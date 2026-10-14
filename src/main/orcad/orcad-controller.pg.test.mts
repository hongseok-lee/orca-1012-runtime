import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { getDefaultUIState } from '../../shared/constants.ts'
import { LOCAL_HTTPS_TEST_CERTIFICATE, LOCAL_HTTPS_TEST_PRIVATE_KEY } from '../browser/browser-local-https-test-certificate.ts'
import type { CatalogAuthority } from '../durable-runtime/catalog/authority.ts'
import { registerCatalogProject } from '../durable-runtime/catalog/register.ts'
import { parseCatalogUi } from '../durable-runtime/catalog/ui.ts'
import { createDurablePool } from '../durable-runtime/db/connection.ts'
import { CONTROLLER_SCOPE } from '../durable-runtime/ha/instance.ts'
import { captureOrcadDurableCatalogConfig } from './orcad-durable-catalog.ts'
import { captureOrcadControllerConfig } from './orcad-controller-config.ts'
import { captureOrcadOpsConfig } from './orcad-ops-config.ts'
import { prepareOrcadStartup, type OrcadStartupOwner } from './orcad-ops.ts'
import { stopOrcadRuntimeWithDurableCatalog } from './orcad-durable-catalog-cleanup.ts'

// Root supplies a fresh owned schema-only DB. No migration, dev/C3 config, cluster/RBAC or provider execution occurs here.
if (process.env.ORCA_CONTROLLER_STARTUP_APPROVED !== 'root-ready' ||
    !/^orca_p114_startup_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? '')) {
  throw new Error('Root first controller startup execution assignment and separate owned schema-only DB required')
}

await test('two actual startup owners share one PG scope, observe owned HTTPS inventory and hand over without physical execution', async () => {
  const pg = { host: process.env.PGHOST!, port: Number(process.env.PGPORT ?? '5432'),
    database: process.env.PGDATABASE!, user: process.env.PGUSER!, max: 2 }
  const observer = createDurablePool(pg), dir = mkdtempSync(path.join(tmpdir(), 'orca-controller-pg-'))
  const sockets = new Set<Socket>(), owners: OrcadStartupOwner[] = [], ends = [0, 0], requests = [0, 0]
  const order: string[] = [], serverErrors: string[] = []
  const namespace = 'fixture-startup-inventory', dataset = 'orca-1012-dev-v1'
  const unitId = randomUUID(), operationId = randomUUID(), podUid = randomUUID()
  const tokenValues = ['fixture-startup-owner-a', 'fixture-startup-owner-b']
  const server = createServer({ key: LOCAL_HTTPS_TEST_PRIVATE_KEY, cert: LOCAL_HTTPS_TEST_CERTIFICATE }, (request, response) => {
    const index = tokenValues.findIndex(token => request.headers.authorization === `Bearer ${token}`)
    const url = new URL(request.url ?? '', 'https://fixture.invalid')
    if (index < 0 || request.method !== 'GET' || url.pathname !== `/api/v1/namespaces/${namespace}/pods` ||
        url.searchParams.get('labelSelector') !== `orca.dev/role=runtime-agent,orca.dev/dataset=${dataset}`) {
      serverErrors.push('SYNTHETIC_REQUEST_BOUNDARY'); response.writeHead(403); response.end(); return
    }
    requests[index]++
    response.writeHead(200, { 'Content-Type': 'application/json' })
    if (url.searchParams.get('watch') === 'true') {
      response.end(`${JSON.stringify({ type: 'BOOKMARK', object: { apiVersion: 'v1', kind: 'Pod',
        metadata: { resourceVersion: 'fixture-watch-rv' } } })}\n`)
    } else {
      response.end(JSON.stringify({ apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: 'fixture-list-rv' },
        items: [{ apiVersion: 'v1', kind: 'Pod', metadata: { namespace, name: 'fixture-pod', uid: podUid,
          resourceVersion: 'fixture-item-rv', labels: { 'orca.dev/role': 'runtime-agent', 'orca.dev/dataset': dataset,
            'orca.dev/runtime-unit': unitId }, annotations: { 'orca.dev/operation-id': operationId,
            'orca.dev/execution-epoch': '0', 'orca.dev/spec-hash': 'a'.repeat(64) } } }] }))
    }
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  async function observed(check: () => boolean): Promise<void> {
    for (let n = 0; n < 500; n++) { if (check()) { return }; await delay(20) }
    assert.fail('actual startup boundary was not observed before the owned fixture observation timeout')
  }
  async function physicalRows() {
    const result: Record<string, unknown> = {}
    for (const table of ['runtime_units', 'operations', 'runtime_commands', 'attempts', 'execution_grants', 'storage_write_grants']) {
      result[table] = (await observer.query(`SELECT to_jsonb(t) AS value FROM durable_runtime.${table} t ORDER BY id`)).rows
    }
    return result
  }
  async function stop(index: number): Promise<void> {
    const owner = owners[index]
    if (!owner) { return }
    await stopOrcadRuntimeWithDurableCatalog({ stopRpc: async () => { order.push(`${index}:rpc`) },
      stopAgentControlAdapter: () => {}, stopDaemon: async () => {}, uninstallObservedStatusIdentity: () => {},
      uninstallHookStatusRepublish: () => {}, stopAgentHookServer: () => {}, stopDurableCatalog: () => {
        order.push(`${index}:owner`); const first = owner.stop(); assert.equal(first, owner.stop()); return first
      } })
  }
  try {
    const ledgerBefore = (await observer.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
    assert.equal(ledgerBefore.length, 19)
    const before = await physicalRows()
    assert.ok(Object.values(before).every(rows => Array.isArray(rows) && rows.length === 0))
    const repo = `fixture-startup:${randomUUID()}`
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Separate owned PG fixture authority; never production/client controller authority.
    const authority = { principalId: 'fixture-startup-registration', repositoryIds: [repo],
      projectGroupIds: [], workspacePublicIds: [] } as unknown as CatalogAuthority
    const registered = await registerCatalogProject(observer, authority, { mutationId: `fixture-register:${randomUUID()}`,
      repo: { id: repo, displayName: repo, path: '/synthetic/controller-startup/project', addedAt: 1,
        badgeColor: '#0ea5e9', kind: 'folder', projectGroupId: null, executionHostId: 'local' },
      group: null, ui: parseCatalogUi(getDefaultUIState()) })
    assert.equal(registered.status, 'COMMITTED')
    writeFileSync(dir + '/ca.pem', LOCAL_HTTPS_TEST_CERTIFICATE, { mode: 0o600 })
    for (const [index, token] of tokenValues.entries()) { writeFileSync(dir + `/token-${index}`, token, { mode: 0o600 }) }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const port = address.port
    async function start(index: number) {
      return prepareOrcadStartup({ catalog: captureOrcadDurableCatalogConfig({ datasetName: dataset, hostId: 'local',
        repositoryIds: [repo], projectGroupIds: [], workspacePublicIds: [], pg }, process.env.PGPASSFILE!),
      ops: captureOrcadOpsConfig({ origin: 'http://127.0.0.1:16768', namespaceId: `fixture-controller:${index}`,
        workspaceIds: [], lifecyclePolicy: { operationDeadlineMs: 120000, idleDurationMs: null }, pollIntervalMs: 100 }),
      controller: captureOrcadControllerConfig({ datasetName: dataset, inventory: { apiOrigin: `https://127.0.0.1:${port}`,
        namespace, dataset, caFile: dir + '/ca.pem', tokenFile: dir + `/token-${index}`, requestTimeoutMs: 1000,
        watchTimeoutSeconds: 1, listLimit: 10 }, policy: { lease: { revision: 'startup-inventory-fixture-v1', durationMs: 5000 },
        renewIntervalMs: 1000, standbyPollIntervalMs: 50, passPollIntervalMs: 100, maximumWork: 10, externalBudgetMs: 3000 } }) }, owner => {
        assert.ok(owner?.controllerSnapshot)
        owners[index] = owner
        const pool = owner.readConfig.pool, end = pool.end.bind(pool)
        Object.defineProperty(pool, 'end', { value: async () => { ends[index]++; order.push(`${index}:pool`); await end() } })
      })
    }
    const first = await start(0)
    assert.ok(first.opsHttp)
    await observed(() => owners[0].controllerSnapshot?.().worker?.phase === 'ACTIVE' &&
      owners[0].controllerSnapshot?.().worker?.lastPass?.items.some(item => item.kind === 'INVENTORY' && item.disposition === 'OBSERVED') === true)
    const firstLease = owners[0].controllerSnapshot?.().worker?.confirmedLease; assert.ok(firstLease)
    assert.equal(firstLease.scope, CONTROLLER_SCOPE)
    assert.ok(owners[0].controllerSnapshot?.().latestObservation?.counts.list)
    const second = await start(1)
    assert.ok(second.opsHttp); assert.notEqual(first.durableCatalogRead?.pool, second.durableCatalogRead?.pool)
    await observed(() => owners[1].controllerSnapshot?.().worker?.phase === 'STANDBY')
    assert.equal(owners[1].controllerSnapshot?.().latestObservation, null); assert.equal(requests[1], 0)
    const actor = { datasetName: dataset, namespaceId: 'fixture-controller:0', workspaceIds: [],
      principalId: 'fixture-existing-ops-verifier', authorizationRef: 'fixture-existing-ops-verifier' }
    assert.deepEqual((await first.opsHttp.services.units(actor)).units, [])
    await stop(0)
    assert.equal(ends[0], 1); assert.equal(ends[1], 0)
    const stopped = owners[0].controllerSnapshot?.(); assert.equal(stopped?.worker?.phase, 'STOPPED')
    assert.equal(stopped?.worker?.lastRelease?.status, 'RELEASED')
    const oldRequests = requests[0], oldObservation = stopped?.latestObservation
    await observed(() => owners[1].controllerSnapshot?.().worker?.phase === 'ACTIVE' &&
      owners[1].controllerSnapshot?.().worker?.lastPass?.items.some(item => item.kind === 'INVENTORY' && item.disposition === 'OBSERVED') === true)
    const next = owners[1].controllerSnapshot?.().worker?.confirmedLease; assert.ok(next)
    assert.notEqual(next.owner, firstLease.owner); assert.equal(BigInt(next.term), BigInt(firstLease.term) + 1n)
    assert.ok(requests[1] >= 2); assert.ok(owners[1].controllerSnapshot?.().latestObservation?.counts.watch)
    assert.equal((await observer.query('SELECT owner,term FROM durable_runtime.controller_leases WHERE scope=$1', [CONTROLLER_SCOPE])).rows[0].owner, next.owner)
    await delay(50)
    assert.equal(requests[0], oldRequests); assert.deepEqual(owners[0].controllerSnapshot?.().latestObservation, oldObservation)
    await stop(1)
    assert.equal(ends[1], 1); assert.equal(owners[1].controllerSnapshot?.().worker?.lastRelease?.status, 'RELEASED')
    assert.deepEqual(order, ['0:rpc', '0:owner', '0:pool', '1:rpc', '1:owner', '1:pool'])
    assert.deepEqual(await physicalRows(), before)
    assert.deepEqual((await observer.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledgerBefore)
    assert.deepEqual(serverErrors, [])
    // Inventory is an owned synthetic HTTPS observation, never real K8s/RBAC/Spot/fence/provider or writer-stop proof.
  } finally {
    try { await Promise.allSettled(owners.map(owner => owner.stop())) } finally {
      for (const socket of sockets) { socket.destroy() }
      if (server.listening) { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
      await observer.end(); rmSync(dir, { recursive: true, force: true })
    }
  }
})
