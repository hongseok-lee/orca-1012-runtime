import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { DurableDatabaseError, withDurableTransaction } from './connection.ts'

export interface Migration { version: string; checksum: string; sql: string }
export interface AppliedMigration { version: string; checksum: string; applied_at: Date }

export async function readMigrations(directory: string): Promise<Migration[]> {
  const files = (await readdir(directory)).filter((file) => /^\d{3}-[a-z-]+\.sql$/.test(file)).sort()
  const migrations: Migration[] = []
  for (const file of files) {
    const sql = await readFile(join(directory, file), 'utf8')
    migrations.push({ version: file, checksum: createHash('sha256').update(sql).digest('hex'), sql })
  }
  return migrations
}

// Explicit operator entry point; imports and existing Orca startup never apply DDL.
export async function applyMigrations(pool: Pool, migrations: readonly Migration[]): Promise<AppliedMigration[]> {
  if (!migrations.length || new Set(migrations.map((item) => item.version)).size !== migrations.length) {
    throw new DurableDatabaseError('MIGRATION_INPUT')
  }
  for (const migration of migrations) {
    if (!/^\d{3}-[a-z-]+\.sql$/.test(migration.version) || migration.checksum !== createHash('sha256').update(migration.sql).digest('hex')) {
      throw new DurableDatabaseError('MIGRATION_CHECKSUM')
    }
  }
  return withDurableTransaction(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('durable_runtime:migrations',0))")
    await tx.query('CREATE SCHEMA IF NOT EXISTS durable_runtime')
    await tx.query(`CREATE TABLE IF NOT EXISTS durable_runtime.schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL CHECK(checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`)
    const applied = await tx.query<AppliedMigration>('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')
    const byVersion = new Map(migrations.map((item) => [item.version, item]))
    for (const row of applied.rows) {
      if (byVersion.get(row.version)?.checksum !== row.checksum) throw new DurableDatabaseError('MIGRATION_HISTORY_CONFLICT')
    }
    const appliedVersions = new Set(applied.rows.map((row) => row.version))
    for (const migration of [...migrations].sort((a,b) => a.version.localeCompare(b.version, 'en'))) {
      if (appliedVersions.has(migration.version)) continue
      await tx.query(migration.sql)
      await tx.query('INSERT INTO durable_runtime.schema_migrations(version,checksum) VALUES($1,$2)', [migration.version,migration.checksum])
    }
    const result = await tx.query<AppliedMigration>('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')
    return result.rows
  })
}
