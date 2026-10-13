// Explicit isolated verification setup, never an application startup hook.
import assert from 'node:assert/strict'
import path from 'node:path'
import { createDurablePool, safeDatabaseError } from '../db/connection.ts'
import { applyMigrations, readMigrations } from '../db/migrate.ts'

assert.equal(process.cwd(), '/tmp/orca-p104-execution')
const database = process.env.PGDATABASE ?? ''
assert.match(database, /^orca_p104_[a-z0-9_]+$/)
const admin = createDurablePool({ database: 'postgres', max: 1 })
try {
  const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])
  if (!existing.rowCount) {
    await admin.query(`CREATE DATABASE "${database}"`)
  }
} catch (error) {
  throw safeDatabaseError(error)
} finally {
  await admin.end()
}
const pool = createDurablePool({ database, max: 1 })
try {
  const migrations = await readMigrations(path.resolve('src/main/durable-runtime/db/migrations'))
  const applied = await applyMigrations(pool, migrations)
  console.log(
    JSON.stringify({
      database,
      applied: applied.map(({ version, checksum }) => ({ version, checksum }))
    })
  )
} finally {
  await pool.end()
}
