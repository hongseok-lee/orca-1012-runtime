// Explicit operator verifier only. Application imports never apply migrations.
import assert from 'node:assert/strict'
import path from 'node:path'
import { createDurablePool, safeDatabaseError } from '../db/connection.ts'
import { applyMigrations, readMigrations } from '../db/migrate.ts'

assert.equal(
  process.cwd(),
  process.env.ORCA_INPUT_COMPOSITION_EXECUTION_ROOT,
  'Owned verifier execution root is required'
)
const database = process.env.PGDATABASE ?? ''
assert.match(database, /^orca_p117_intake_[a-z0-9_]+$/)
const migrations = await readMigrations(path.resolve('src/main/durable-runtime/db/migrations'))
assert.equal(migrations.length, 12, 'Exact predecessor migrations001–012 are required')
assert.equal(migrations.at(-1)?.version, '012-input-merge-boundary.sql')
const admin = createDurablePool({ database: 'postgres', max: 1 })
try {
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])
  if (!exists.rowCount) {
    await admin.query(`CREATE DATABASE "${database}"`)
  }
} catch (error) {
  throw safeDatabaseError(error)
} finally {
  await admin.end()
}
const pool = createDurablePool({ database, max: 1 })
try {
  const applied = await applyMigrations(pool, migrations)
  console.log(
    JSON.stringify({ applied: applied.map(({ version, checksum }) => ({ version, checksum })) })
  )
} finally {
  await pool.end()
}
