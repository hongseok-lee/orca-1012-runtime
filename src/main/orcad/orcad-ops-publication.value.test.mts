import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDurablePool } from '../durable-runtime/db/connection.ts'
import { OPS_REPLAY_STREAM } from '../durable-runtime/replay/types.ts'
import { captureOrcadOpsConfig, OrcadOpsConfigurationError } from './orcad-ops-config.ts'
import { ownOrcadOpsPublication } from './orcad-ops-publication.ts'
import { prepareOrcadOps, prepareOrcadStartup } from './orcad-ops.ts'
import { stopOrcadRuntimeWithDurableCatalog } from './orcad-durable-catalog-cleanup.ts'

if (process.env.ORCA_OPS_PUBLICATION_STARTUP_APPROVED !== 'root-ready') {
  throw new Error('Root publication startup source review and first execution assignment required')
}
const configured = () => captureOrcadOpsConfig({ origin: 'http://localhost:16768', namespaceId: 'synthetic-publication',
  workspaceIds: [], lifecyclePolicy: { operationDeadlineMs: 120000, idleDurationMs: null }, pollIntervalMs: 1000 })
const unavailable = (error: unknown): boolean => error instanceof OrcadOpsConfigurationError &&
  error.message === 'OPS_STARTUP_UNAVAILABLE' && error.code === error.message

await test('unset and invalid Ops allocate no publisher; unstarted and failed-start owners close the original Pool once', async () => {
  assert.deepEqual(await prepareOrcadStartup({ catalog: null, ops: null }, owner => assert.equal(owner, null)), {})
  // These real Pools never connect. Only Catalog ownership is a fixture adapter; no worker/publisher is stubbed.
  for (const boundary of ['invalid-ops', 'worker-config-rejection']) {
    const pool = createDurablePool({ max: 1 }), order: string[] = []
    let connects = 0, ends = 0
    Object.defineProperty(pool, 'connect', { value: () => { connects++; throw new Error('unexpected fixture connection') } })
    const owner = ownOrcadOpsPublication({ readConfig: { pool, datasetName: 'orca-1012-dev-v1', hostId: 'local',
      readHostIdentity: () => 'local', repositoryIds: ['synthetic-repo'], projectGroupIds: [], workspacePublicIds: [] },
    stop: async () => { ends++; order.push('pool'); await pool.end() } })
    try {
      assert.equal(owner.readConfig.pool, pool)
      assert.equal(owner.lastResult, null); assert.equal(owner.lastFailure, null)
      await (boundary === 'invalid-ops'
        ? assert.rejects(prepareOrcadOps({ ...configured(), pollIntervalMs: 0 }, owner.readConfig),
          error => error instanceof OrcadOpsConfigurationError && error.code === 'OPS_STARTUP_CONFIG')
        // The original worker rejects this interval before creating a timer or connecting; no alternate implementation.
        : assert.rejects(owner.startPublication({ streamId: OPS_REPLAY_STREAM, pollIntervalMs: 2147483648 }), unavailable))
      await stopOrcadRuntimeWithDurableCatalog({ stopRpc: async () => { order.push('rpc') },
        stopAgentControlAdapter: () => {}, stopDaemon: async () => {}, uninstallObservedStatusIdentity: () => {},
        uninstallHookStatusRepublish: () => {}, stopAgentHookServer: () => {}, stopDurableCatalog: () => {
          const first = owner.stop(), second = owner.stop()
          assert.equal(first, second)
          return first
        } })
      assert.deepEqual(order, ['rpc', 'pool']); assert.equal(ends, 1); assert.equal(connects, 0)
      assert.equal(owner.lastResult, null); assert.equal(owner.lastFailure, null)
    } finally { await owner.stop() }
    assert.equal(ends, 1)
  }
})
