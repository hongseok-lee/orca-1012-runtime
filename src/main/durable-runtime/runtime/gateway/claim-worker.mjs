// Isolated validation worker; no actual provider/substrate callback is supplied.
// Parent owns this exact process and private result/log paths. No raw token is
// sent over stdout/IPC or published in evidence metadata.
import { readFile, writeFile } from 'node:fs/promises'
import { createDurablePool } from '../../db/connection.ts'
import { runGatewayCommandMutation } from './mutation.ts'

if (!/^orca_p109_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? '')) {
  process.exit(2)
}
const pool = createDurablePool({ max: 1, application_name: 'p109-owned-claim-worker' })
try {
  const seed = JSON.parse(await readFile(process.argv[2], 'utf8'))
  seed.request.observation.occurredAt = new Date(seed.request.observation.occurredAt)
  seed.request.observation.receivedAt = new Date(seed.request.observation.receivedAt)
  const result = await runGatewayCommandMutation(pool, seed.request)
  await writeFile(seed.output, `${JSON.stringify(result)}\n`, { mode: 0o600 })
  if (
    result.mutation.status !== 'COMMITTED' ||
    result.mutation.receipt.response.disposition !== 'CLAIMED'
  ) {
    throw new Error('CLAIM_NOT_COMMITTED')
  }
  process.send?.('COMMIT_CONFIRMED')
  setInterval(() => {}, 1000)
} catch {
  process.send?.('CLAIM_FAILED')
  await pool.end()
  process.exitCode = 1
}
