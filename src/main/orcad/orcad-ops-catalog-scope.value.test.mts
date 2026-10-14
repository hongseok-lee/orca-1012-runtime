import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureOrcadOpsConfig, OrcadOpsConfigurationError } from './orcad-ops-config.ts'

// Source delivery only. Root reads these callbacks before assigning first execution.
if (process.env.ORCA_OPS_CATALOG_SCOPE_APPROVED !== 'root-ready') {
  throw new Error('Root Ops Catalog scope first execution assignment required')
}
const input = () => ({ origin: 'http://localhost:16768', namespaceId: 'synthetic-catalog-scope',
  workspaceIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
  lifecyclePolicy: { operationDeadlineMs: 120000, idleDurationMs: null }, pollIntervalMs: 1000 })
const invalid = (error: unknown) => error instanceof OrcadOpsConfigurationError && error.code === 'OPS_STARTUP_CONFIG'

test('private workspaceScope defaults to explicit, accepts catalog and rejects malformed or accessor options', () => {
  assert.equal(captureOrcadOpsConfig(input()).workspaceScope, 'explicit')
  assert.equal(captureOrcadOpsConfig({ ...input(), workspaceScope: 'explicit' }).workspaceScope, 'explicit')
  assert.equal(captureOrcadOpsConfig({ ...input(), workspaceScope: 'catalog' }).workspaceScope, 'catalog')
  for (const workspaceScope of [undefined, null, true, '', 'CATALOG', 'unknown', {}]) {
    assert.throws(() => captureOrcadOpsConfig({ ...input(), workspaceScope }), invalid)
  }
  let getterCalls = 0
  const accessor = Object.defineProperty(input(), 'workspaceScope', { enumerable: true,
    get() { getterCalls++; return 'catalog' } })
  assert.throws(() => captureOrcadOpsConfig(accessor), invalid)
  assert.equal(getterCalls, 0)
  assert.throws(() => captureOrcadOpsConfig({ ...input(), extraScope: 'catalog' }), invalid)
  assert.throws(() => captureOrcadOpsConfig(Object.assign(Object.create(null), input())), invalid)
  assert.throws(() => captureOrcadOpsConfig(Object.assign(Object.create({ foreign: true }), input())), invalid)
  const required = input()
  Reflect.deleteProperty(required, 'origin')
  assert.throws(() => captureOrcadOpsConfig(required), invalid)
  assert.throws(() => captureOrcadOpsConfig({ ...input(), workspaceScope: 'catalog', workspaceIds: ['not-a-uuid'] }), invalid)
})

test('captured private mode, workspace IDs and policy are detached from later caller mutation', () => {
  const mutable = { ...input(), workspaceScope: 'catalog' }
  const captured = captureOrcadOpsConfig(mutable)
  mutable.workspaceScope = 'explicit'
  mutable.workspaceIds[0] = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  mutable.namespaceId = 'replacement'
  mutable.lifecyclePolicy.operationDeadlineMs = 1
  assert.equal(captured.workspaceScope, 'catalog')
  assert.equal(captured.namespaceId, 'synthetic-catalog-scope')
  assert.deepEqual(captured.workspaceIds, ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'])
  assert.equal(captured.lifecyclePolicy.operationDeadlineMs, 120000)
  assert.ok(Object.isFrozen(captured))
  assert.ok(Object.isFrozen(captured.workspaceIds))
  assert.ok(Object.isFrozen(captured.lifecyclePolicy))
})
