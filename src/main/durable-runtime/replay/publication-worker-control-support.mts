import type { Pool, QueryResult } from 'pg'
import type { notificationRow } from './publication-worker-fixture.mts'

export function controlGate() {
  let signal!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { signal = resolve })
  const wait = new Promise<void>(resolve => { release = resolve })
  return { entered, wait, signal, release }
}
type Row = ReturnType<typeof notificationRow> & {
  state?: string; claim_owner?: string; claim_token?: string; claim_live?: boolean;
  claim_expires_at?: Date; attempt_count?: string
}
type Query = (sql: string, values: readonly unknown[], execute: () => QueryResult) => Promise<QueryResult>
/** SQL simulation exclusively for lifecycle control; never PG or guard evidence. */
export function controlPool(rows: Row[] = [], query?: Query, connecting?: ReturnType<typeof controlGate>) {
  const stats: { connects: number; active: number; maximumActive: number; endCalls: number;
    publicationStarts: number; claimCalls: number; claims: (readonly unknown[])[]; commits: number } = {
    connects: 0, active: 0, maximumActive: 0, endCalls: 0, publicationStarts: 0, claimCalls: 0, claims: [], commits: 0 }
  let offset = '0'
  const poolLike = {
    async connect() {
      stats.connects++; stats.active++; stats.maximumActive = Math.max(stats.maximumActive, stats.active)
      if (connecting) { connecting.signal(); await connecting.wait }
      let released = false
      return {
        async query(sql: string, values: readonly unknown[] = []) {
          function execute(): QueryResult {
            let found: Record<string, unknown>[] = []
            if (sql.includes('WITH candidates AS')) {
              stats.claimCalls++; stats.claims = [...stats.claims, [...values]]
              for (const row of rows) {
                row.state = 'CLAIMED'; row.claim_owner = String(values[1]); row.claim_token = String(values[2])
                row.claim_live = true; row.claim_expires_at = new Date(Date.now() + Number(values[3]))
                row.attempt_count = '1'
              }
              found = rows
            } else if (sql.includes('FROM durable_runtime.outbox_events WHERE id=$1 FOR UPDATE')) {
              stats.publicationStarts++; found = rows.filter(row => row.id === values[0])
            } else if (sql.startsWith('SELECT epoch,published_offset')) {
              found = [{ epoch: '0', published_offset: offset }]
            } else if (sql.startsWith('UPDATE durable_runtime.replay_stream_heads')) {
              offset = String(values[1])
            } else if (sql.startsWith('UPDATE durable_runtime.outbox_events')) {
              found = [{ changed: true }]
            } else if (sql === 'COMMIT') { stats.commits++ }
            return { command: 'SIMULATED_CONTROL_ONLY', rowCount: found.length, oid: 0, rows: found, fields: [] }
          }
          return query ? query(sql, values, execute) : execute()
        },
        release() { if (!released) { released = true; stats.active-- } }
      }
    },
    async end() { stats.endCalls++ }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture-only SQL simulator; never actual PG/authority evidence or a production dependency injection API.
  return { pool: poolLike as unknown as Pool, stats }
}
