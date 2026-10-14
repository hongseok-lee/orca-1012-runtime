import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { captureOrcadDurableCatalogConfig, readOrcadDurableCatalogConfig,
  prepareOrcadDurableCatalog, OrcadDurableCatalogConfigurationError } from './orcad-durable-catalog.ts'

// New startup boundaries only. No execution is authorized merely by importing this file.
if (process.env.ORCA_P116_STARTUP_APPROVED !== 'root-ready') { throw new Error('Root startup fixture Ready required') }
const original = { config: process.env.ORCA_DURABLE_CATALOG_CONFIG,
  pgpass: process.env.PGPASSFILE, password: process.env.PGPASSWORD }
const root = mkdtempSync(join(tmpdir(), 'orca-startup-values-'))
const pgpass = join(root, 'synthetic-pgpass')
writeFileSync(pgpass, '', { mode: 0o600 }) // No credential content or PG connection in value fixtures.
function config() {
  return { datasetName: 'orca-1012-dev-v1', hostId: 'local', repositoryIds: ['synthetic-startup-repo'],
    projectGroupIds: [], workspacePublicIds: [],
    pg: { host: '127.0.0.1', port: 5432, database: 'synthetic-startup', user: 'synthetic', max: 2 } }
}
function restore(key: string, value: string | undefined) {
  if (value === undefined) { delete process.env[key] } else { process.env[key] = value }
}
const code = (expected: string) => (error: unknown): boolean =>
  error instanceof OrcadDurableCatalogConfigurationError && error.code === expected

await test('new opt-in startup value boundaries', async t => {
  try {
    delete process.env.PGPASSWORD
    process.env.PGPASSFILE = pgpass
    await t.test('unset opt-in retains the original startup and allocates no Pool', async () => {
      delete process.env.ORCA_DURABLE_CATALOG_CONFIG
      assert.equal(readOrcadDurableCatalogConfig(), null)
      let calls = 0
      assert.equal(await prepareOrcadDurableCatalog(null, () => { calls++; throw new Error('unexpected Pool') }), null)
      assert.equal(calls, 0)
    })
    await t.test('malformed JSON and unknown or credential configuration fields fail without echoing input', () => {
      const path = join(root, 'malformed.json')
      writeFileSync(path, '{"password":"synthetic-private-marker",', { mode: 0o600 })
      process.env.ORCA_DURABLE_CATALOG_CONFIG = path
      assert.throws(readOrcadDurableCatalogConfig, code('CATALOG_STARTUP_CONFIG_FILE'))
      for (const forbidden of ['password', 'connectionString', 'credential']) {
        const input = config()
        assert.throws(() => captureOrcadDurableCatalogConfig({ ...input,
          pg: { ...input.pg, [forbidden]: 'synthetic-private-marker' } }, pgpass), code('CATALOG_STARTUP_CONFIG'))
      }
      assert.throws(() => captureOrcadDurableCatalogConfig({ ...config(), unknown: true }, pgpass), code('CATALOG_STARTUP_CONFIG'))
    })
    await t.test('symlink and group-readable config files are explicitly rejected', () => {
      const path = join(root, 'private.json'), link = join(root, 'linked.json')
      writeFileSync(path, JSON.stringify(config()), { mode: 0o600 })
      symlinkSync(path, link)
      process.env.ORCA_DURABLE_CATALOG_CONFIG = link
      assert.throws(readOrcadDurableCatalogConfig, code('CATALOG_STARTUP_PRIVATE_FILE'))
      chmodSync(path, 0o640)
      process.env.ORCA_DURABLE_CATALOG_CONFIG = path
      assert.throws(readOrcadDurableCatalogConfig, code('CATALOG_STARTUP_PRIVATE_FILE'))
      chmodSync(path, 0o600)
      assert.equal(readOrcadDurableCatalogConfig()?.hostId, 'local')
    })
    await t.test('server arrays and PG options are detached before the first await', () => {
      const input = config(), captured = captureOrcadDurableCatalogConfig(input, pgpass)
      input.repositoryIds[0] = 'synthetic-replacement'; input.pg.host = 'synthetic-replacement'
      assert.deepEqual(captured.repositoryIds, ['synthetic-startup-repo'])
      assert.equal(captured.pg.host, '127.0.0.1'); assert.equal(captured.hostId, 'local')
      assert.ok(Object.isFrozen(captured)); assert.ok(Object.isFrozen(captured.repositoryIds)); assert.ok(Object.isFrozen(captured.pg))
    })
    await t.test('unsupported dataset or logical host and missing registration are configuration errors', () => {
      assert.throws(() => captureOrcadDurableCatalogConfig({ ...config(), datasetName: 'synthetic-other' }, pgpass), code('CATALOG_STARTUP_DATASET_UNSUPPORTED'))
      assert.throws(() => captureOrcadDurableCatalogConfig({ ...config(), hostId: 'runtime:synthetic' }, pgpass), code('CATALOG_STARTUP_HOST_UNSUPPORTED'))
      assert.throws(() => captureOrcadDurableCatalogConfig({ ...config(), repositoryIds: [] }, pgpass), code('CATALOG_STARTUP_REGISTRATION_REQUIRED'))
      for (const max of [0, 5, 1.5]) {
        const input = config()
        assert.throws(() => captureOrcadDurableCatalogConfig({ ...input, pg: { ...input.pg, max } }, pgpass), code('CATALOG_STARTUP_CONFIG'))
      }
    })
    await t.test('startup DB failure closes its owned Pool once and sanitizes the original error', async () => {
      let ends = 0
      const fake = { connect: async () => { throw Object.assign(new Error('synthetic-private-marker'), { code: '57P01' }) },
        end: async () => { ends++ } } as unknown as Pool
      await assert.rejects(prepareOrcadDurableCatalog(captureOrcadDurableCatalogConfig(config(), pgpass), () => fake),
        (error: unknown): boolean => error instanceof Error && error.message === 'Durable database operation failed (57P01)')
      assert.equal(ends, 1)
    })
  } finally {
    restore('ORCA_DURABLE_CATALOG_CONFIG', original.config)
    restore('PGPASSFILE', original.pgpass)
    restore('PGPASSWORD', original.password)
    rmSync(root, { recursive: true, force: true })
  }
})
