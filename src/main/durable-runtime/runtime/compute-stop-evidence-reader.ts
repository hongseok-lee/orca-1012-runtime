import type { PoolClient, QueryResultRow } from 'pg'
import { DurableTransaction } from '../db/connection.ts'
import { readExecutionTarget } from './execution-target-records.ts'
import type { ComputeStopBudget } from './compute-stop-evidence-budget.ts'
import type { CapturedStopConfiguration } from './compute-stop-evidence-input.ts'
import { ComputeStopEvidenceError } from './compute-stop-evidence-types.ts'
import type { ComputeStopEvidenceInput } from './compute-stop-evidence-types.ts'

class StopReadTransaction extends DurableTransaction {
  private readonly originalQuery: PoolClient['query']
  constructor(client: PoolClient, private readonly budget: ComputeStopBudget) {
    super(client)
    this.originalQuery = client.query.bind(client)
  }
  override query<Row extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []) {
    return this.budget.wait(() => this.originalQuery<Row>(sql, [...values]))
  }
}

function discardLateClient(client: PoolClient): void {
  try { client.release(true) } catch { /* No late connection may enter SQL or Cloud. */ }
}

/** A private read-only checkout; no borrowed caller transaction or active-attempt filter. */
export async function readCommittedStopTarget(config: CapturedStopConfiguration,
  input: ComputeStopEvidenceInput, budget: ComputeStopBudget) {
  const client = await budget.wait(() => config.connect(), discardLateClient)
  const originalRelease = client.release.bind(client)
  let released = false
  const release = (destroy: boolean): void => {
    if (released) { return }
    released = true
    originalRelease(destroy)
  }
  const destroy = (): void => release(true)
  let tx: StopReadTransaction | undefined
  let begun = false
  budget.signal.addEventListener('abort', destroy, { once: true })
  try {
    budget.check()
    tx = new StopReadTransaction(client, budget)
    begun = true
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const dataset = await tx.query<{ dataset_name: string }>('SELECT dataset_name FROM durable_runtime.dataset_metadata')
    if (dataset.rows.length !== 1 || dataset.rows[0].dataset_name !== config.datasetName) {
      throw new ComputeStopEvidenceError('DATASET_MISMATCH')
    }
    const target = await readExecutionTarget(tx, input.key)
    if (!target) { throw new ComputeStopEvidenceError('TARGET_NOT_FOUND') }
    await tx.query('COMMIT')
    begun = false
    budget.check()
    release(false)
    budget.check()
    return target
  } catch (error) {
    if (begun && tx && !released) {
      try { await tx.query('ROLLBACK'); begun = false } catch { release(true) }
    }
    if (!released) { release(begun) }
    budget.check()
    throw error instanceof ComputeStopEvidenceError ? error : new ComputeStopEvidenceError('DB_READ_FAILED')
  } finally {
    tx?.close()
    budget.signal.removeEventListener('abort', destroy)
    if (!released) { release(true) }
  }
}
