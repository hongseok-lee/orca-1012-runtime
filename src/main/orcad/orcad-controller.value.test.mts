import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { LOCAL_HTTPS_TEST_CERTIFICATE, LOCAL_HTTPS_TEST_PRIVATE_KEY } from '../browser/browser-local-https-test-certificate.ts'
import { createDurablePool } from '../durable-runtime/db/connection.ts'
import { captureOrcadControllerConfig, readOrcadControllerConfig, OrcadControllerConfigurationError } from './orcad-controller-config.ts'
import { ownOrcadController, prepareOrcadControllerInventory } from './orcad-controller.ts'
import { ownOrcadOpsPublication } from './orcad-ops-publication.ts'
import { prepareOrcadStartup } from './orcad-ops.ts'
import { stopOrcadRuntimeWithDurableCatalog } from './orcad-durable-catalog-cleanup.ts'

if (process.env.ORCA_CONTROLLER_STARTUP_APPROVED !== 'root-ready') {
  throw new Error('Root controller startup source review and first execution assignment required')
}

await test('controller opt-in captures strict private config, follows token rotation without credential errors, and cleans partial owners in order', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orca-controller-value-')), ca = dir + '/ca.pem', token = dir + '/token-current'
  const configPath = dir + '/controller.json', old = process.env.ORCA_DURABLE_CONTROLLER_CONFIG
  const sockets = new Set<Socket>(), headers: (string | undefined)[] = []
  const server = createServer({ key: LOCAL_HTTPS_TEST_PRIVATE_KEY, cert: LOCAL_HTTPS_TEST_CERTIFICATE }, (request, response) => {
    headers.push(request.headers.authorization)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: 'fixture-list-rv' }, items: [] }))
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  const input = (apiOrigin = 'https://127.0.0.1:1') => ({ datasetName: 'orca-1012-dev-v1', inventory: {
    apiOrigin, namespace: 'fixture-inventory', dataset: 'orca-1012-dev-v1', caFile: ca, tokenFile: token,
    requestTimeoutMs: 1000, watchTimeoutSeconds: 1, listLimit: 10 }, policy: {
    lease: { revision: 'controller-startup-fixture-v1', durationMs: 5000 }, renewIntervalMs: 1000,
    standbyPollIntervalMs: 50, passPollIntervalMs: 100, maximumWork: 10, externalBudgetMs: 3000 } })
  const sanitized = (error: unknown): boolean => error instanceof OrcadControllerConfigurationError &&
    error.code === error.message && /^CONTROLLER_[A-Z0-9_]+$/u.test(error.message) &&
    !error.message.includes(dir) && !error.message.includes('fixture-synthetic')
  try {
    delete process.env.ORCA_DURABLE_CONTROLLER_CONFIG
    assert.equal(readOrcadControllerConfig(), null)
    assert.deepEqual(await prepareOrcadStartup({ catalog: null, ops: null }, owner => assert.equal(owner, null)), {})
    const mutable = input(), captured = captureOrcadControllerConfig(mutable)
    mutable.policy.lease.durationMs = 1; mutable.inventory.namespace = 'changed'
    assert.equal(captured.policy.lease.durationMs, 5000); assert.equal(captured.inventory.namespace, 'fixture-inventory')
    assert.ok(Object.isFrozen(captured.inventory)); assert.ok(Object.isFrozen(captured.policy.lease))
    for (const invalid of [
      { ...input(), owner: 'external-owner' }, { ...input(), datasetName: 'another-dataset' },
      { ...input(), inventory: { ...input().inventory, password: 'fixture-synthetic-secret' } },
      { ...input(), inventory: { ...input().inventory, apiOrigin: 'https://user:fixture-synthetic-secret@localhost' } },
      { ...input(), inventory: { ...input().inventory, tokenFile: '../relative' } },
      { ...input(), inventory: { ...input().inventory, listLimit: 0 } },
      { ...input(), inventory: { ...input().inventory, requestTimeoutMs: 2147483648 } },
      { ...input(), policy: { ...input().policy, renewIntervalMs: 5000 } },
      { ...input(), policy: { ...input().policy, term: '1' } },
      { ...input(), policy: { ...input().policy, maximumWork: Number.NaN } }
    ]) { assert.throws(() => captureOrcadControllerConfig(invalid), sanitized) }
    await assert.rejects(prepareOrcadStartup({ catalog: null, ops: null, controller: captured }, () => {}), sanitized)

    process.env.ORCA_DURABLE_CONTROLLER_CONFIG = configPath
    writeFileSync(configPath, JSON.stringify(input()), { mode: 0o600 })
    assert.equal(readOrcadControllerConfig()?.datasetName, 'orca-1012-dev-v1')
    chmodSync(configPath, 0o640); assert.throws(readOrcadControllerConfig, sanitized); chmodSync(configPath, 0o600)
    const link = dir + '/config-symlink'; symlinkSync(configPath, link)
    process.env.ORCA_DURABLE_CONTROLLER_CONFIG = link; assert.throws(readOrcadControllerConfig, sanitized)
    process.env.ORCA_DURABLE_CONTROLLER_CONFIG = configPath
    writeFileSync(configPath, JSON.stringify(input()).replace('"datasetName":', '"datasetName":"orca-1012-dev-v1","datasetName":'))
    assert.throws(readOrcadControllerConfig, error => sanitized(error) && error instanceof OrcadControllerConfigurationError &&
      error.code === 'CONTROLLER_STARTUP_DUPLICATE_KEY')
    writeFileSync(configPath, JSON.stringify(input()).replace('"renewIntervalMs":', '"renewIntervalMs":1000,"renewIntervalMs":'))
    assert.throws(readOrcadControllerConfig, sanitized)
    writeFileSync(configPath, '{"credential":"fixture-synthetic-secret",'); assert.throws(readOrcadControllerConfig, sanitized)
    writeFileSync(configPath, Buffer.alloc(1024 * 1024 + 1, 32)); assert.throws(readOrcadControllerConfig, sanitized)

    writeFileSync(ca, LOCAL_HTTPS_TEST_CERTIFICATE, { mode: 0o600 })
    writeFileSync(dir + '/token-one', 'fixture-synthetic-first', { mode: 0o600 })
    writeFileSync(dir + '/token-two', 'fixture-synthetic-rotated', { mode: 0o600 })
    symlinkSync(dir + '/token-one', token)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const selected = input(`https://127.0.0.1:${address.port}`), transport = await prepareOrcadControllerInventory(captureOrcadControllerConfig(selected))
    // The CA is an owned copy; replacing its local source after preparation cannot alter the active transport.
    writeFileSync(ca, 'changed-local-ca-after-capture')
    selected.inventory.tokenFile = '/not-selected'; selected.inventory.apiOrigin = 'https://not-selected.invalid'
    assert.equal((await transport.list(new AbortController().signal)).resourceVersion, 'fixture-list-rv')
    symlinkSync(dir + '/token-two', dir + '/replacement-link'); renameSync(dir + '/replacement-link', token)
    await transport.list(new AbortController().signal)
    assert.deepEqual(headers, ['Bearer fixture-synthetic-first', 'Bearer fixture-synthetic-rotated'])
    unlinkSync(token)
    await assert.rejects(transport.list(new AbortController().signal), sanitized)
    assert.equal(headers.length, 2, 'A failed rotated token read must not open an HTTP request')

    for (const boundary of ['missing-ca', 'wrong-host', 'wrong-dataset']) {
      const pool = createDurablePool({ max: 1 }), order: string[] = []
      let connects = 0, ends = 0
      Object.defineProperty(pool, 'connect', { value: () => { connects++; throw new Error('unexpected value fixture PG access') } })
      const controller = ownOrcadController({ readConfig: { pool, datasetName: boundary === 'wrong-dataset' ? 'another-dataset' : 'orca-1012-dev-v1',
        hostId: boundary === 'wrong-host' ? 'ssh:fixture' : 'local', readHostIdentity: () => boundary === 'wrong-host' ? 'ssh:fixture' : 'local',
        repositoryIds: ['synthetic-controller-repo'], projectGroupIds: [], workspacePublicIds: [] },
      stop: async () => { ends++; order.push('catalog'); await pool.end() } })
      const publication = ownOrcadOpsPublication({ readConfig: controller.readConfig, stop: () => {
        order.push('controller'); const first = controller.stop(); assert.equal(first, controller.stop()); return first
      } })
      try {
        const config = captureOrcadControllerConfig({ ...input(), inventory: { ...input().inventory, caFile: dir + '/missing-ca' } })
        await assert.rejects(async () => controller.startController(config), sanitized)
        assert.equal(controller.controllerSnapshot().worker, null)
        await stopOrcadRuntimeWithDurableCatalog({ stopRpc: async () => { order.push('rpc') }, stopAgentControlAdapter: () => {},
          stopDaemon: async () => {}, uninstallObservedStatusIdentity: () => {}, uninstallHookStatusRepublish: () => {},
          stopAgentHookServer: () => {}, stopDurableCatalog: () => {
            order.push('publication'); const first = publication.stop(); assert.equal(first, publication.stop()); return first
          } })
        assert.deepEqual(order, ['rpc', 'publication', 'controller', 'catalog']); assert.equal(ends, 1); assert.equal(connects, 0)
      } finally { await publication.stop() }
      assert.equal(ends, 1)
    }
  } finally {
    if (old === undefined) { delete process.env.ORCA_DURABLE_CONTROLLER_CONFIG } else { process.env.ORCA_DURABLE_CONTROLLER_CONFIG = old }
    for (const socket of sockets) { socket.destroy() }
    if (server.listening) { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
    rmSync(dir, { recursive: true, force: true })
  }
})
