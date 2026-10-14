import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { PoolConfig } from 'pg'
import { createDurablePool, withDurableTransaction } from '../durable-runtime/db/connection.ts'
import type { CatalogRegistration } from '../durable-runtime/catalog/register.ts'

export type MissingStartupBoundary = 'catalog-head' | 'ui-head' | 'ui-state' | 'dataset'

/** Each name denotes a distinct, newly prepared schema-only DB, never the successful fixture DB. */
export function missingStartupDatabase(base: string, boundary: MissingStartupBoundary): string {
  const database = `${base}_missing_${boundary.replaceAll('-', '_')}`
  assert.match(database, /^orca_p116_startup_[a-z0-9_]+$/)
  assert.ok(database.length <= 63, 'Use a shorter owned validation DB prefix')
  return database
}

/** Fixture preparation only. Root prepares exact 001–014 once in each fresh DB before this call. */
export async function prepareMissingStartupFixture(
  base: PoolConfig & { database: string },
  boundary: MissingStartupBoundary,
  registration: Pick<CatalogRegistration, 'repo' | 'group' | 'ui'>
): Promise<PoolConfig & { database: string }> {
  const pg = { ...base, database: missingStartupDatabase(base.database, boundary) }
  const pool = createDurablePool(pg)
  try {
    await withDurableTransaction(pool, async tx => {
      const migrations = (await tx.query<{ version: string }>(
        'SELECT version FROM durable_runtime.schema_migrations ORDER BY version')).rows
      assert.equal(migrations.length, 14, 'A new schema 001–014-only DB is required')
      assert.deepEqual(migrations.map(row => Number(row.version.slice(0, 3))),
        Array.from({ length: 14 }, (_, index) => index + 1))
      const initial = (await tx.query<{ dataset_name: string }>(
        'SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows
      assert.deepEqual(initial.map(row => row.dataset_name), ['orca-1012-dev-v1'])
      for (const table of ['catalog_heads', 'catalog_project_groups', 'catalog_repositories',
        'catalog_ui_state', 'catalog_workspace_metadata', 'catalog_tab_metadata', 'workspaces']) {
        const count = await tx.query<{ count: string }>(`SELECT count(*)::text AS count FROM durable_runtime.${table}`)
        assert.equal(count.rows[0].count, '0', 'Fixture DB must be newly prepared, without Catalog rows')
      }
      if (boundary === 'dataset') {
        // Discover every actual FK referencing dataset_metadata before touching its initial seed.
        const references = await tx.query<{ schema: string; relation: string }>(
          `SELECT DISTINCT n.nspname AS schema,c.relname AS relation
           FROM pg_catalog.pg_constraint f
           JOIN pg_catalog.pg_class c ON c.oid=f.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
           WHERE f.contype='f' AND f.confrelid='durable_runtime.dataset_metadata'::regclass`)
        assert.ok(references.rows.length > 0, 'Actual dataset FK metadata must be present')
        for (const row of references.rows) {
          assert.equal(row.schema, 'durable_runtime')
          const relation = `"${row.relation.replaceAll('"', '""')}"`
          const count = await tx.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM durable_runtime.${relation}`)
          assert.equal(count.rows[0].count, '0', 'No dataset FK references may exist')
        }
        const triggers = await tx.query(
          `SELECT tgname FROM pg_catalog.pg_trigger
           WHERE tgrelid='durable_runtime.dataset_metadata'::regclass AND NOT tgisinternal`)
        assert.equal(triggers.rows.length, 0, 'The accepted dataset table has no retention trigger')
        const deleted = await tx.query(
          'DELETE FROM durable_runtime.dataset_metadata WHERE dataset_name=$1 RETURNING dataset_name',
          ['orca-1012-dev-v1'])
        assert.equal(deleted.rowCount, 1)
        return
      }
      assert.ok(registration.group)
      await tx.query('INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)',
        [registration.group.id, JSON.stringify(registration.group)])
      await tx.query('INSERT INTO durable_runtime.catalog_repositories(id,project_group_id,payload) VALUES($1,$2,$3)',
        [registration.repo.id, registration.group.id, JSON.stringify(registration.repo)])
      for (const scope of ['catalog', 'ui:host']) {
        if ((boundary === 'catalog-head' && scope === 'catalog') ||
            (boundary === 'ui-head' && scope === 'ui:host')) { continue }
        await tx.query('INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES($1,$2)',
          [scope, randomUUID()])
      }
      if (boundary !== 'ui-state') {
        await tx.query("INSERT INTO durable_runtime.catalog_ui_state(scope,payload) VALUES('host',$1)",
          [JSON.stringify(registration.ui)])
      }
    })
    return pg
  } finally { await pool.end() }
}
