import { catalogUnitStorageDirectory, readCatalogUnitStorageAllocation } from '../catalog/unit-storage-allocation.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import type { Repo } from '../../../shared/repo-types.ts'
import type { CatalogWorkspace } from '../catalog/read.ts'
import { prepareCatalogCall } from '../catalog/request.ts'
import { captureCatalogReadContext } from './context.ts'
import { prepareCatalogWorktreeLaunch, prepareCatalogTerminalLaunch } from './launch-preparation.ts'
import { captureCatalogLaunchConfig } from './launch-config.ts'
import { captureDurableCatalogReadConfig } from './config.ts'
import { DurableCatalogReadAdapter } from './public.ts'
import { CATALOG_PUBLIC_CREATION_METHODS } from './creation.ts'
import { fixtureConfig, fixtureRuntime, fixtureContext } from './fixture-support.mts'

// Written only. Root determines the first callback allocation after source review.
if (process.env.ORCA_P116_CREATION_APPROVED !== 'root-source-reviewed') { throw new Error('Root creation source review required') }
const launch = () => ({ policy: { operationDeadlineMs: 30000, idleDurationMs: null }, repositories: [{ repositoryId: 'synthetic-create',
  worktreeRoot: '/synthetic/create/worktrees', agentHomeRoot: '/synthetic/create/homes',
  storage: { backendId: 'synthetic-backend', exportId: 'synthetic-export', canonicalDirectory: '/synthetic/create' } }] })

await test('private launch is detached plain data; invalid scope/path/policy/accessor and unset/disposed public boundaries do no IO', async () => {
  let checkouts = 0, getterCalls = 0
  const pool = { connect: () => { checkouts++; throw new Error('Unexpected Pool access') } } as unknown as Pool
  const config = { ...fixtureConfig(pool), repositoryIds: ['synthetic-create'], launch: launch() }
  const captured = captureDurableCatalogReadConfig(config)
  config.launch.repositories[0].agentHomeRoot = '/synthetic/replaced'
  config.launch.policy.operationDeadlineMs = 1
  assert.equal(captured.launch!.repositories[0].agentHomeRoot, '/synthetic/create/homes')
  assert.equal(captured.launch!.policy.operationDeadlineMs, 30000)
  for (const mutate of [
    (value: ReturnType<typeof launch>) => { value.repositories.push({ ...value.repositories[0] }) },
    (value: ReturnType<typeof launch>) => { value.repositories[0].repositoryId = 'outside' },
    (value: ReturnType<typeof launch>) => { value.repositories[0].agentHomeRoot = '../homes' },
    (value: ReturnType<typeof launch>) => { value.repositories[0].agentHomeRoot = '/synthetic/create/../escape' },
    (value: ReturnType<typeof launch>) => { value.repositories[0].worktreeRoot = '/synthetic//create' },
    (value: ReturnType<typeof launch>) => { value.repositories[0].storage.canonicalDirectory = '/elsewhere' },
    (value: ReturnType<typeof launch>) => { value.policy.operationDeadlineMs = 0 }
  ]) { const input = launch(); mutate(input); assert.throws(() => captureCatalogLaunchConfig(input, ['synthetic-create'])) }
  const accessor = { ...fixtureConfig(pool), repositoryIds: ['synthetic-create'] }
  Object.defineProperty(accessor, 'launch', { enumerable: true, get() { getterCalls++; return launch() } })
  assert.throws(() => captureDurableCatalogReadConfig(accessor))
  assert.equal(getterCalls, 0)
  const owner = fixtureRuntime(), unset = new DurableCatalogReadAdapter(fixtureConfig(pool))
  const enabled = new DurableCatalogReadAdapter({ ...fixtureConfig(pool), repositoryIds: ['synthetic-create'], launch: launch() })
  try {
    for (const method of CATALOG_PUBLIC_CREATION_METHODS) {
      await assert.rejects(unset.create(method, {}, fixtureContext(owner.runtime)), /CATALOG_METHOD_NOT_CONNECTED/)
      for (const fingerprint of [undefined, 'forged']) {
        await assert.rejects(enabled.create(method, {}, fixtureContext(owner.runtime, { authenticatedCallerFingerprint: fingerprint })), /CATALOG_AUTHENTICATED_CALLER_REQUIRED/)
      }
    }
    enabled.dispose()
    await assert.rejects(enabled.create('worktree.create', {}, fixtureContext(owner.runtime)), /CATALOG_ADAPTER_DISPOSED/)
    assert.equal(checkouts, 0); assert.deepEqual(owner.unexpected, []); assert.equal(owner.cleanups.size, 0)
  } finally { unset.dispose(); enabled.dispose() }
})

await test('서로 다른 local/canonical 좌표의 생성 준비는 서버 mapping을 고정하고 local 범위 밖 경로를 거절합니다', () => {
  let checkouts = 0
  const pool = { connect: () => { checkouts++; throw new Error('Unexpected Pool access') } } as unknown as Pool
  const owner = fixtureRuntime(), localDirectory = '/synthetic/create', canonicalDirectory = '/synthetic/authority/catalog'
  const input = () => {
    const base = launch(), repository = base.repositories[0]
    return { ...fixtureConfig(pool), repositoryIds: ['synthetic-create'], launch: { ...base, repositories: [{ ...repository,
      storage: { ...repository.storage, localDirectory, canonicalDirectory } }] } }
  }
  const mutable = input(), config = captureDurableCatalogReadConfig(mutable)
  const context = captureCatalogReadContext(config, fixtureContext(owner.runtime))
  const fallback = captureDurableCatalogReadConfig({ ...fixtureConfig(pool), repositoryIds: ['synthetic-create'], launch: launch() })
  assert.equal(fallback.launch!.repositories[0].storage.localDirectory, '/synthetic/create')
  mutable.launch.repositories[0].storage.localDirectory = '/synthetic/replaced'
  mutable.launch.repositories[0].storage.canonicalDirectory = '/synthetic/replaced-canonical'
  mutable.launch.repositories[0].agentHomeRoot = '/synthetic/replaced-homes'
  assert.equal(config.launch!.repositories[0].storage.localDirectory, localDirectory)
  assert.equal(config.launch!.repositories[0].storage.canonicalDirectory, canonicalDirectory)
  function checkMapping(prepared: ReturnType<typeof prepareCatalogWorktreeLaunch>) {
    const server = prepared.launchRequest.server
    assert.ok(server && typeof server === 'object' && 'storagePathMapping' in server && 'agentHomePath' in server)
    const mapping = server.storagePathMapping
    assert.ok(mapping && typeof mapping === 'object' && 'localDirectory' in mapping && 'canonicalDirectory' in mapping)
    assert.equal(mapping.localDirectory, localDirectory); assert.equal(mapping.canonicalDirectory, catalogUnitStorageDirectory(canonicalDirectory, prepared.unit.id))
    assert.equal(server.agentHomePath, `${localDirectory}/homes/${prepared.agent.id}`)
    assert.ok(Object.isFrozen(prepared.launchRequest)); assert.ok(Object.isFrozen(server)); assert.ok(Object.isFrozen(mapping))
    assert.equal(Reflect.set(mapping, 'localDirectory', '/synthetic/changed'), false)
    assert.equal(prepared.storage.backendId, 'synthetic-backend'); assert.equal(prepared.storage.exportId, 'synthetic-export')
    assert.equal(prepared.storage.canonicalDirectory, catalogUnitStorageDirectory(canonicalDirectory, prepared.unit.id))
    assert.equal(readCatalogUnitStorageAllocation(prepared.launchRequest, prepared.unit.id, prepared.storage.canonicalDirectory)?.leafId, prepared.unit.id)
  }
  for (const kind of ['folder', 'git'] as const) {
    const repo: Repo = { id: 'synthetic-create', path: `${localDirectory}/repo`, displayName: 'Synthetic', kind,
      badgeColor: '#ffffff', addedAt: 1, executionHostId: 'local' }
    const request = { repo: 'id:synthetic-create', name: `mapped-${kind}`, clientMutationId: `synthetic-mapping:${kind}`,
      startupCommand: 'synthetic retained command', startupEnv: { SYNTHETIC_FIELD: 'retained' }, activate: false }
    const call = prepareCatalogCall('worktree.create', request, context)
    const prepared = prepareCatalogWorktreeLaunch(config, call, repo, [])
    assert.equal(prepared.workspace.reservedPath, kind === 'folder' ? repo.path : `${localDirectory}/worktrees/mapped-git`)
    checkMapping(prepared)
    const independent = prepareCatalogWorktreeLaunch(config, call, repo, [])
    assert.notEqual(independent.unit.id, prepared.unit.id)
    assert.notEqual(independent.storage.canonicalDirectory, prepared.storage.canonicalDirectory)
    assert.equal(JSON.stringify(prepared.launchRequest.params), JSON.stringify(request))
    const workspace: CatalogWorkspace = { workspace_id: prepared.workspace.id, public_id: prepared.workspace.publicId,
      kind: prepared.workspace.kind, repo_id: repo.id, project_group_id: null, reserved_path: prepared.workspace.reservedPath,
      name: prepared.workspace.reservedName, payload: { ...prepared.workspace.payload }, create_request: {},
      runtime_unit_id: prepared.unit.id, provisioning_operation_id: null, created_at: new Date(0), updated_at: new Date(0),
      workspace_revision: '1', provisioning_state: 'PENDING', deleted_at: null }
    const unit = { unitId: prepared.unit.id, bindingId: prepared.storage.id, backendId: prepared.storage.backendId,
      exportId: prepared.storage.exportId, canonicalDirectory: prepared.storage.canonicalDirectory }
    const terminalRequest = { worktree: `id:${workspace.public_id}`, launchAgent: 'codex',
      launchToken: 'synthetic-mapping-token', envToDelete: ['SYNTHETIC_REMOVE'], clientMutationId: `synthetic-terminal:${kind}` }
    const terminalCall = prepareCatalogCall('session.tabs.createTerminal', terminalRequest, context)
    const terminal = prepareCatalogTerminalLaunch(config, terminalCall, repo, workspace, unit, 1)
    checkMapping(terminal)
    assert.equal(terminal.unit.id, prepared.unit.id); assert.equal(terminal.unit.create, false)
    assert.equal(terminal.storage.id, prepared.storage.id); assert.equal(terminal.storage.createUnverified, false)
    assert.equal(JSON.stringify(terminal.launchRequest.params), JSON.stringify(terminalRequest))
    for (const mismatch of [{ backendId: 'other' }, { exportId: 'other' }, { canonicalDirectory: localDirectory }]) {
      assert.throws(() => prepareCatalogTerminalLaunch(config, terminalCall, repo, workspace, { ...unit, ...mismatch }, 1), /CATALOG_STORAGE_CONFIGURATION/)
    }
    for (const outside of ['/synthetic/outside/repo', '/synthetic/create-other/repo']) {
      if (kind === 'folder') {
        assert.throws(() => prepareCatalogWorktreeLaunch(config, call, { ...repo, path: outside }, []), /CATALOG_LAUNCH_CONFIGURATION/)
      }
      assert.throws(() => prepareCatalogTerminalLaunch(config, terminalCall, repo, { ...workspace, reserved_path: outside }, unit, 1), /CATALOG_STORAGE_CONFIGURATION/)
    }
  }
  for (const outside of ['/synthetic/outside', '/synthetic/create-other']) {
    for (const field of ['agentHomeRoot', 'worktreeRoot'] as const) {
      const bad = input(); bad.launch.repositories[0][field] = outside
      assert.throws(() => captureDurableCatalogReadConfig(bad), /CATALOG_LAUNCH_CONFIGURATION/)
    }
  }
  for (const invalid of ['relative/path', '/synthetic/../escape', '/synthetic//create', '/synthetic/create/']) {
    for (const field of ['localDirectory', 'canonicalDirectory'] as const) {
      const bad = input(); bad.launch.repositories[0].storage[field] = invalid
      assert.throws(() => captureDurableCatalogReadConfig(bad), /CATALOG_LAUNCH_CONFIGURATION/)
    }
  }
  assert.equal(checkouts, 0); assert.deepEqual(owner.unexpected, []); assert.equal(owner.cleanups.size, 0)
})
