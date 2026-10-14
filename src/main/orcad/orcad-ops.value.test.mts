import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { captureOrcadOpsConfig, readOrcadOpsConfig, OrcadOpsConfigurationError } from './orcad-ops-config.ts'
import { readOrcadStartupConfig, prepareOrcadStartup, prepareOrcadOps, OrcadDurableCatalogConfigurationError } from './orcad-ops.ts'
import { startOrcadWithLifecycle } from './orcad-lifecycle.ts'
import { stopOrcadRuntimeWithDurableCatalog } from './orcad-durable-catalog-cleanup.ts'

// Source delivery only. Root must separately authorize the first callback execution.
if (process.env.ORCA_OPS_STARTUP_APPROVED !== 'root-ready') { throw new Error('Root Ops startup Ready required') }
function input() {
  return { origin: 'http://localhost:16768', namespaceId: 'synthetic-ops-scope',
    workspaceIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
    lifecyclePolicy: { operationDeadlineMs: 10000, idleDurationMs: null }, pollIntervalMs: 1000 }
}
const code = (expected: string) => (error: unknown): boolean =>
  error instanceof OrcadOpsConfigurationError && error.message === expected && error.code === expected

await test('unset Ops and configured Ops without Catalog retain distinct sanitized startup paths', async () => {
  const original = { ops: process.env.ORCA_OPS_CONFIG, catalog: process.env.ORCA_DURABLE_CATALOG_CONFIG }
  const directory = mkdtempSync(join(tmpdir(), 'orca-ops-opt-in-'))
  try {
    delete process.env.ORCA_OPS_CONFIG
    delete process.env.ORCA_DURABLE_CATALOG_CONFIG
    assert.deepEqual(readOrcadStartupConfig(), { catalog: null, ops: null })
    assert.equal(await prepareOrcadOps(null, undefined), undefined)
    let ownershipCalls = 0
    assert.deepEqual(await prepareOrcadStartup(readOrcadStartupConfig(), catalog => {
      ownershipCalls++; assert.equal(catalog, null)
    }), {})
    assert.equal(ownershipCalls, 1)
    const file = join(directory, 'synthetic-private-config.json')
    writeFileSync(file, JSON.stringify(input()), { mode: 0o600 })
    process.env.ORCA_OPS_CONFIG = file
    assert.throws(readOrcadStartupConfig, code('OPS_STARTUP_CATALOG_REQUIRED'))
    await assert.rejects(prepareOrcadOps(captureOrcadOpsConfig(input()), undefined), (error: unknown) => {
      assert.ok(error instanceof OrcadDurableCatalogConfigurationError)
      return code('OPS_STARTUP_CATALOG_REQUIRED')(error)
    }) // The existing entry's configuration class maps this subclass to exit 78.
  } finally {
    for (const [key, value] of Object.entries({ ORCA_OPS_CONFIG: original.ops, ORCA_DURABLE_CATALOG_CONFIG: original.catalog })) {
      if (value === undefined) { delete process.env[key] } else { process.env[key] = value }
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

await test('strict private file, fields, origins, internal IDs and policy capture reject unsafe input', () => {
  const original = process.env.ORCA_OPS_CONFIG
  const directory = mkdtempSync(join(tmpdir(), 'orca-ops-config-'))
  try {
    const file = join(directory, 'synthetic.json'), link = join(directory, 'symlink.json')
    writeFileSync(file, JSON.stringify(input()), { mode: 0o600 })
    symlinkSync(file, link)
    process.env.ORCA_OPS_CONFIG = link
    assert.throws(readOrcadOpsConfig, code('OPS_STARTUP_PRIVATE_FILE'))
    process.env.ORCA_OPS_CONFIG = directory
    assert.throws(readOrcadOpsConfig, code('OPS_STARTUP_PRIVATE_FILE'))
    process.env.ORCA_OPS_CONFIG = file
    chmodSync(file, 0o640)
    assert.throws(readOrcadOpsConfig, code('OPS_STARTUP_PRIVATE_FILE'))
    chmodSync(file, 0o600)
    const captured = readOrcadOpsConfig()
    assert.ok(captured)
    writeFileSync(file, '{"token":"synthetic-private-marker",', { mode: 0o600 })
    assert.throws(readOrcadOpsConfig, code('OPS_STARTUP_CONFIG_FILE'))
    const source = input(), snapshot = captureOrcadOpsConfig(source)
    source.workspaceIds[0] = 'replacement'; source.lifecyclePolicy.operationDeadlineMs = 1
    assert.deepEqual(snapshot, captured)
    assert.ok(Object.isFrozen(snapshot.workspaceIds)); assert.ok(Object.isFrozen(snapshot.lifecyclePolicy))
    const malformed = [
      { ...input(), token: 'synthetic-private-marker' }, { ...input(), controllerConnected: true },
      ...['ftp://localhost', 'http://user:secret@localhost', 'http://localhost/path', 'http://localhost/?q=x', 'http://localhost/#x']
        .map(origin => ({ ...input(), origin })),
      { ...input(), workspaceIds: ['public-repo::/workspace'] },
      { ...input(), workspaceIds: ['AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'] },
      { ...input(), workspaceIds: [...input().workspaceIds, ...input().workspaceIds] },
      { ...input(), lifecyclePolicy: { operationDeadlineMs: 0, idleDurationMs: null } },
      { ...input(), lifecyclePolicy: { operationDeadlineMs: 1, idleDurationMs: -1 } },
      { ...input(), lifecyclePolicy: { ...input().lifecyclePolicy, quota: 1 } },
      { ...input(), pollIntervalMs: Number.MAX_SAFE_INTEGER + 1 }
    ]
    for (const value of malformed) { assert.throws(() => captureOrcadOpsConfig(value), code('OPS_STARTUP_CONFIG')) }
    assert.deepEqual(captureOrcadOpsConfig({ ...input(), workspaceIds: [] }).workspaceIds, [])
  } finally {
    if (original === undefined) { delete process.env.ORCA_OPS_CONFIG } else { process.env.ORCA_OPS_CONFIG = original }
    rmSync(directory, { recursive: true, force: true })
  }
})

await test('Ops preparation failure preserves RPC-first Catalog cleanup and the original failure', async () => {
  const order: string[] = []
  await assert.rejects(startOrcadWithLifecycle(async register => {
    register(() => stopOrcadRuntimeWithDurableCatalog({
      stopRpc: async () => { order.push('rpc-http'); throw new Error('synthetic-stop-failure') },
      stopAgentControlAdapter: () => { order.push('adapter') }, stopDaemon: async () => { order.push('daemon') },
      uninstallObservedStatusIdentity: () => { order.push('identity') },
      uninstallHookStatusRepublish: () => { order.push('hook') }, stopAgentHookServer: () => { order.push('agent-hook') },
      stopDurableCatalog: async () => { order.push('catalog-pool') }
    }))
    await prepareOrcadOps(captureOrcadOpsConfig(input()), undefined)
    return {}
  }, async () => { order.push('host') }), code('OPS_STARTUP_CATALOG_REQUIRED'))
  assert.deepEqual(order, ['rpc-http', 'adapter', 'daemon', 'identity', 'hook', 'agent-hook', 'catalog-pool', 'host'])
})
