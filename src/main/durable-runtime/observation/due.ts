import type { Pool } from 'pg'
import { DurableDatabaseError, withDurableTransaction } from '../db/connection.ts'
import type { ObservationEpisodeRow } from '../db/rows.ts'

// PG clock and persisted state only. Discovery is not a claim or execution right.
export async function listDueObservationEpisodes(pool: Pool, limit = 100): Promise<readonly ObservationEpisodeRow[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) { throw new DurableDatabaseError('OBSERVATION_DUE_LIMIT') }
  return withDurableTransaction(pool, async tx => (await tx.query<ObservationEpisodeRow>(`SELECT * FROM durable_runtime.observation_episodes
    WHERE state='OPEN' AND resolved_at IS NULL AND deadline_at<=clock_timestamp()
    ORDER BY deadline_at,id LIMIT $1`, [limit])).rows)
}
