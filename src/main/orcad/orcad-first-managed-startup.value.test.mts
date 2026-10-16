import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { logicalId } from '../../shared/durable-runtime/identity.ts'
import { createDurablePool } from '../durable-runtime/db/connection.ts'
import { captureOrcadControllerConfig, OrcadControllerConfigurationError } from './orcad-controller-config.ts'
import { ownOrcadController } from './orcad-controller.ts'
import { captureOrcadFirstManagedCallbacks, prepareOrcadFirstManagedInitial } from './orcad-first-managed-initial.ts'
import { firstManagedStartupFixture } from './orcad-first-managed-startup-fixtures.mts'

if (process.env.ORCA_FIRST_MANAGED_STARTUP_APPROVED !== 'root-first-verification') {
  throw new Error('Root startup source review and first focused verification assignment required')
}
function unusedPool() {
  const pool = createDurablePool({ max: 1 })
  let connects = 0, ends = 0
  const end = pool.end.bind(pool)
  Object.defineProperty(pool, 'connect', { value() { connects++; throw new Error('Unexpected fixture PG access') } })
  Object.defineProperty(pool, 'end', { value() { ends++; return end() } })
  return { pool, get connects() { return connects }, get ends() { return ends } }
}
function safe(error: unknown): boolean {
  return error instanceof OrcadControllerConfigurationError && error.code === error.message && /^CONTROLLER_[A-Z0-9_]+$/u.test(error.message)
}

await test('first managed startup: exact private selection, real composer callbacks and original owner cleanup', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'orca-first-managed-startup-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  await t.test('default config shape stays inert and both explicit options remain independently strict', async () => {
    const f = firstManagedStartupFixture(`${dir}`), observer = unusedPool()
    try {
      const base = { datasetName: f.config.datasetName, inventory: f.config.inventory, policy: f.config.policy }
      const captured = captureOrcadControllerConfig(base)
      assert.equal(Object.hasOwn(captured, 'firstManagedInitial'), false)
      assert.equal(prepareOrcadFirstManagedInitial(captured, observer.pool, Buffer.alloc(0)), null)
      const mutable = { ...base, structuredOutput: { claimDurationMs: 1000 }, firstManagedInitial: { configFile: f.configFile } }
      const both = captureOrcadControllerConfig(mutable)
      mutable.firstManagedInitial.configFile = '/changed-after-capture'
      assert.equal(both.firstManagedInitial?.configFile, f.configFile)
      assert.equal(both.structuredOutput?.claimDurationMs, 1000); assert.ok(Object.isFrozen(both.firstManagedInitial))
      for (const firstManagedInitial of [null, undefined, {}, [], { configFile: '../relative' },
        { configFile: `${dir}/a/../b` }, { configFile: f.configFile, callback: true }]) {
        assert.throws(() => captureOrcadControllerConfig({ ...base, firstManagedInitial }), safe)
      }
      let getterCalls = 0
      const accessor = Object.defineProperty({}, 'configFile', { enumerable: true, get() { getterCalls++; return f.configFile } })
      assert.throws(() => captureOrcadControllerConfig({ ...base, firstManagedInitial: accessor }), safe)
      assert.equal(getterCalls, 0); assert.equal(observer.connects, 0)
    } finally { await observer.pool.end() }
  })

  await t.test('real composer selects only the exact original target and wrappers preserve close/abort/host checks', async () => {
    const f = firstManagedStartupFixture(dir), observer = unusedPool()
    try {
      // Token files intentionally do not exist: construction must not read them
      // or acquire a hold/claim. The actual accepted profile is read and checked.
      const dispatch = prepareOrcadFirstManagedInitial(captureOrcadControllerConfig(f.config), observer.pool, f.f.wire.configuration.ca)
      assert.ok(dispatch)
      let closing = false, hostChecks = 0, sameHost = true
      const callbacks = captureOrcadFirstManagedCallbacks(dispatch, { isClosing() { return closing }, assertCurrentHost() {
        hostChecks++; if (!sameHost) { throw new Error('fixture original host changed') }
      } })
      const selected = callbacks.planStep(f.operation, f.unit)
      assert.equal(selected?.step, 'ENSURE_ATTEMPT'); assert.equal(selected?.executorId, f.value.executorId)
      assert.equal(callbacks.planStep({ ...f.operation, id: logicalId('operation', randomUUID()) }, f.unit), null)
      assert.equal(callbacks.planStep(f.operation, { ...f.unit, id: logicalId('runtime-unit', randomUUID()) }), null)
      const snapshot = dispatch.snapshot()
      assert.equal(snapshot.phase, 'IDLE'); assert.equal(snapshot.gate, 'CLOSED'); assert.equal(snapshot.providerReady, false)
      for (const secret of [dir, f.f.issued, f.f.reviewerToken, f.value.ownerTokenFile, f.value.podTokenFile, f.value.acceptedProfileFile]) {
        assert.equal(JSON.stringify(snapshot).includes(secret), false)
      }
      const aborted = new AbortController(); aborted.abort()
      // Invalid arguments are intentional: the aborted owner boundary must
      // reject before reaching the real composer, without forged identities.
      assert.throws(() => Reflect.apply(callbacks.executeCommitted, callbacks, [null, aborted.signal, null]), safe)
      assert.throws(() => Reflect.apply(callbacks.lookupOriginal, callbacks, [null, aborted.signal, null]), safe)
      closing = true; assert.throws(() => callbacks.planStep(f.operation, f.unit), safe)
      closing = false; sameHost = false
      assert.throws(() => callbacks.planStep(f.operation, f.unit), /fixture original host changed/u)
      assert.equal(hostChecks, 4); assert.equal(observer.connects, 0)
      assert.equal(f.f.wire.api.requests.length, 0); assert.equal(f.f.wire.opened.length, 0)
      await f.f.wire.assertCleanup()
    } finally { await observer.pool.end() }
  })

  await t.test('private target rejects raw overrides, scope drift, bad profile/CA and duplicate keys without token or PG reads', async () => {
    const f = firstManagedStartupFixture(dir), observer = unusedPool()
    const config = captureOrcadControllerConfig(f.config)
    const prepare = () => prepareOrcadFirstManagedInitial(config, observer.pool, f.f.wire.configuration.ca)
    try {
      for (const value of [
        { ...f.value, rawToken: 'fixture-private-secret' }, { ...f.value, pool: {} }, { ...f.value, callback: true },
        { ...f.value, policy: { ...f.value.policy, namespace: 'another-namespace' } },
        { ...f.value, collector: { ...f.value.collector, dataset: 'another-dataset' } },
        { ...f.value, collector: { ...f.value.collector, apiOrigin: 'https://override.invalid' } },
        { ...f.value, collector: { ...f.value.collector, ca: 'raw-ca' } },
        { ...f.value, collector: { ...f.value.collector, readReviewerBearer: 'raw-token' } },
        { ...f.value, expectedProfileDigest: '0'.repeat(64) }, { ...f.value, ownerTokenFile: '../relative' }
      ]) {
        writeFileSync(f.configFile, JSON.stringify(value)); assert.throws(prepare, safe)
      }
      writeFileSync(f.configFile, JSON.stringify(f.value))
      assert.throws(() => prepareOrcadFirstManagedInitial(config, observer.pool, Buffer.from('different-captured-ca')), safe)
      writeFileSync(f.configFile, JSON.stringify(f.value).replace('"policyRevision":"0"', '"policyRevision":"0","policyRevision":"1"'))
      assert.throws(prepare, error => safe(error) && error instanceof OrcadControllerConfigurationError && error.code === 'CONTROLLER_STARTUP_DUPLICATE_KEY')
      writeFileSync(f.configFile, JSON.stringify(f.value)); chmodSync(f.configFile, 0o644); assert.throws(prepare, safe); chmodSync(f.configFile, 0o600)
      const link = `${dir}/first-managed-link.json`; symlinkSync(f.configFile, link)
      assert.throws(() => prepareOrcadFirstManagedInitial(captureOrcadControllerConfig({ ...f.config,
        firstManagedInitial: { configFile: link } }), observer.pool, f.f.wire.configuration.ca), safe)
      chmodSync(f.acceptedProfileFile, 0o644); assert.throws(prepare, safe); chmodSync(f.acceptedProfileFile, 0o600)
      assert.equal(observer.connects, 0); assert.equal(f.f.wire.api.requests.length, 0)
    } finally { await observer.pool.end() }
  })

  for (const mode of ['close-before-startup', 'missing-target-file'] as const) {
    await t.test(`${mode} preserves original stop ownership and never starts another worker`, async () => {
      const f = firstManagedStartupFixture(dir), observer = unusedPool()
      let stops = 0
      const owner = ownOrcadController({ readConfig: { pool: observer.pool, datasetName: f.config.datasetName,
        hostId: 'local', readHostIdentity: () => 'local', repositoryIds: ['fixture-startup-repo'], projectGroupIds: [], workspacePublicIds: [] },
      async stop() { stops++; await observer.pool.end() } })
      try {
        const config = captureOrcadControllerConfig(mode === 'missing-target-file' ? { ...f.config,
          firstManagedInitial: { configFile: `${dir}/absent-target.json` } } : f.config)
        if (mode === 'missing-target-file') {
          writeFileSync(config.inventory.caFile, f.f.wire.configuration.ca, { mode: 0o600 })
          await assert.rejects(owner.startController(config), safe)
          assert.equal(owner.controllerSnapshot().lastFailure?.stage, 'START')
        } else {
          const starting = owner.startController(config), stop = owner.stop()
          assert.equal(stop, owner.stop()); await Promise.all([starting, stop])
        }
        const stop = owner.stop(); assert.equal(stop, owner.stop()); await stop
        assert.equal(stops, 1); assert.equal(observer.ends, 1); assert.equal(observer.connects, 0)
        assert.equal(owner.controllerSnapshot().worker, null)
        assert.equal(Object.hasOwn(owner.controllerSnapshot(), 'firstManagedInitial'), false)
        assert.throws(() => owner.startController(config), safe)
      } finally { await owner.stop() }
    })
  }
})
