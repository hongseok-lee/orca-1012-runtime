import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
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
