import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { getDefaultUIState } from '../../shared/constants.ts'
import type { CatalogAuthority } from '../durable-runtime/catalog/authority.ts'
import { registerCatalogProject } from '../durable-runtime/catalog/register.ts'
import { parseCatalogUi } from '../durable-runtime/catalog/ui.ts'
import { createDurablePool } from '../durable-runtime/db/connection.ts'
import { observeNotification } from '../durable-runtime/notifications/index.ts'
import { fixture, source, gate, receipt } from '../durable-runtime/replay/test-support.mts'
import { readReplayPage } from '../durable-runtime/replay/read.ts'
import { OPS_REPLAY_STREAM } from '../durable-runtime/replay/types.ts'
import { captureOrcadDurableCatalogConfig, type OrcadDurableCatalog } from './orcad-durable-catalog.ts'
import { captureOrcadOpsConfig } from './orcad-ops-config.ts'
import { prepareOrcadStartup } from './orcad-ops.ts'
import { stopOrcadRuntimeWithDurableCatalog } from './orcad-durable-catalog-cleanup.ts'

// Root supplies a fresh, owned 001–019 schema-only DB and the first execution assignment. No migration/dev access here.
if (process.env.ORCA_OPS_PUBLICATION_STARTUP_APPROVED !== 'root-ready' ||
    !/^orca_p125_startup_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? '')) {
  throw new Error('Root publication startup assignment and fresh owned schema-only DB required')
}
const pg = { host: process.env.PGHOST!, port: Number(process.env.PGPORT ?? '5432'),
  database: process.env.PGDATABASE!, user: process.env.PGUSER!, max: 2 }

async function enteredWithin(entered: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([entered, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('startup publication did not reach the actual PG insert')), 5000)
    })])
  } finally { clearTimeout(timer) }
}

await test('actual startup worker publishes one notification with a canonical cursor, retains Catalog outbox and drains before Pool close', async () => {
  const observer = createDurablePool(pg), paused = gate(), order: string[] = []
  const owned: { catalog: OrcadDurableCatalog | null } = { catalog: null }
  let productPoolEnds = 0, publicationInserts = 0
  try {
    assert.equal((await observer.query('SELECT count(*)::text AS n FROM durable_runtime.schema_migrations')).rows[0].n, '19')
    for (const table of ['catalog_repositories', 'outbox_events', 'replay_events']) {
      assert.equal((await observer.query(`SELECT count(*)::text AS n FROM durable_runtime.${table}`)).rows[0].n, '0')
    }
    const repo = `synthetic-publication-repo:${randomUUID()}`
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Owned PG fixture authority only; no client authentication is synthesized.
    const authority = { principalId: 'synthetic-publication-owner', repositoryIds: [repo], projectGroupIds: [], workspacePublicIds: [] } as CatalogAuthority
    const registered = await registerCatalogProject(observer, authority, { mutationId: `synthetic-register:${randomUUID()}`,
      repo: { id: repo, displayName: repo, path: `/synthetic/publication/${repo}`, addedAt: 1,
        badgeColor: '#0ea5e9', kind: 'folder', projectGroupId: null, executionHostId: 'local' },
      group: null, ui: parseCatalogUi(getDefaultUIState()) })
    assert.equal(registered.status, 'COMMITTED')
    const unsupportedSql = "SELECT to_jsonb(o) AS value FROM durable_runtime.outbox_events o WHERE event->>'kind'='CATALOG_PROJECT_REGISTERED' ORDER BY id"
    const unsupported = (await observer.query(unsupportedSql)).rows
    assert.equal(unsupported.length, 1)
    const target = await fixture(observer), notification = source(target)
    receipt(await observeNotification(observer, notification))
    const startup = await prepareOrcadStartup({ catalog: captureOrcadDurableCatalogConfig({
      datasetName: 'orca-1012-dev-v1', hostId: 'local', repositoryIds: [repo], projectGroupIds: [], workspacePublicIds: [], pg
    }, process.env.PGPASSFILE!), ops: captureOrcadOpsConfig({ origin: 'http://localhost:16768',
      namespaceId: 'synthetic-publication', workspaceIds: [],
      lifecyclePolicy: { operationDeadlineMs: 120000, idleDurationMs: null }, pollIntervalMs: 10 }) }, catalog => {
      assert.ok(catalog); owned.catalog = catalog
      const pool = catalog.readConfig.pool, connect = pool.connect.bind(pool), end = pool.end.bind(pool)
      // Observe the exact startup-owned Pool, not a replacement Pool or fabricated publisher/SQL result.
      Object.defineProperty(pool, 'end', { value: async () => { productPoolEnds++; order.push('pool'); await end() } })
      Object.defineProperty(pool, 'connect', { value: async () => {
        const client = await connect()
        return new Proxy(client, { get(original, property) {
          if (property === 'query') {
            return async (...args: unknown[]) => {
              const result = await Reflect.apply(original.query, original, args)
              if (String(args[0]).startsWith('INSERT INTO durable_runtime.replay_events(')) {
                publicationInserts++; order.push('publication-in-flight'); paused.signal(); await paused.wait
              }
              return result
            }
          }
          const member = Reflect.get(original, property)
          return typeof member === 'function' ? member.bind(original) : member
        } })
      } })
    })
    assert.ok(owned.catalog); const owner = owned.catalog
    assert.equal(startup.durableCatalogRead?.pool, owner.readConfig.pool)
    assert.ok(startup.opsHttp); assert.equal(startup.opsHttp.streamId, OPS_REPLAY_STREAM)
    await enteredWithin(paused.entered)
    let stopped = false
    const stopping = stopOrcadRuntimeWithDurableCatalog({ stopRpc: async () => { order.push('rpc') },
      stopAgentControlAdapter: () => {}, stopDaemon: async () => {}, uninstallObservedStatusIdentity: () => {},
      uninstallHookStatusRepublish: () => {}, stopAgentHookServer: () => {}, stopDurableCatalog: () => {
        order.push('drain')
        const first = owner.stop(), second = owner.stop()
        assert.equal(first, second)
        return first
      } }).then(() => { stopped = true })
    await delay(20)
    assert.equal(stopped, false); assert.equal(productPoolEnds, 0)
    paused.release(); await stopping
    assert.equal(productPoolEnds, 1); assert.equal(publicationInserts, 1)
    assert.deepEqual(order, ['publication-in-flight', 'rpc', 'drain', 'pool'])
    const page = await readReplayPage(observer, { streamId: OPS_REPLAY_STREAM, epoch: '0', afterOffset: '0', limit: 10 })
    assert.equal(page.status, 'PAGE'); if (page.status !== 'PAGE') { throw new Error('expected canonical page') }
    assert.equal(page.events.length, 1); assert.equal(page.events[0].sourceEventId, notification.sourceEventId)
    assert.deepEqual(page.nextCursor, page.events[0].cursor); assert.deepEqual(page.highWatermark, page.nextCursor)
    const canonical = (await observer.query('SELECT stream_id,epoch,"offset" FROM durable_runtime.replay_events WHERE event_id=$1',
      [notification.sourceEventId])).rows
    assert.deepEqual(canonical, [{ stream_id: page.nextCursor.streamId, epoch: page.nextCursor.epoch, offset: page.nextCursor.offset }])
    assert.equal((await observer.query('SELECT state FROM durable_runtime.outbox_events WHERE id=$1', [notification.sourceEventId])).rows[0].state, 'PUBLISHED')
    assert.deepEqual((await observer.query(unsupportedSql)).rows, unsupported)
    const afterStop = source(target)
    receipt(await observeNotification(observer, afterStop))
    await delay(30)
    assert.equal((await observer.query('SELECT state FROM durable_runtime.outbox_events WHERE id=$1', [afterStop.sourceEventId])).rows[0].state, 'PENDING')
    assert.equal((await observer.query('SELECT count(*)::text AS n FROM durable_runtime.replay_events')).rows[0].n, '1')
    assert.equal(publicationInserts, 1); assert.equal(productPoolEnds, 1)
  } finally {
    paused.release()
    try { await owned.catalog?.stop() } finally { await observer.end() }
  }
})
