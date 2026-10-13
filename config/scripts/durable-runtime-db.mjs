import { fileURLToPath } from 'node:url'
import { createDurablePool, safeDatabaseError } from '../../src/main/durable-runtime/db/connection.ts'
import { applyMigrations, readMigrations } from '../../src/main/durable-runtime/db/migrate.ts'

const command = process.argv[2]
if (command !== 'migrate' && command !== 'manifest') {
  console.error('Usage: node config/scripts/durable-runtime-db.mjs manifest|migrate')
  process.exitCode = 2
} else {
  const directory = fileURLToPath(new URL('../../src/main/durable-runtime/db/migrations/', import.meta.url))
  const migrations = await readMigrations(directory)
  if (command === 'manifest') {
    console.log(JSON.stringify(migrations.map(({version,checksum})=>({version,checksum})),null,2))
  } else {
    // Standard PG environment or injected Pool configuration; credentials are never echoed.
    const pool = createDurablePool({ application_name:'orca-durable-runtime-migrate' })
    try {
      const applied = await applyMigrations(pool,migrations)
      console.log(JSON.stringify({dataset:'orca-1012-dev-v1',applied},null,2))
    } catch(error) {
      console.error(safeDatabaseError(error).message)
      process.exitCode=1
    } finally { await pool.end() }
  }
}
