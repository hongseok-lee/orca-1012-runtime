import type { Pool } from 'pg'
import type { CapturedCatalogReadConfig } from './config.ts'
import { catalogReadFailure, type CatalogReadError } from './config.ts'

type Listener = {
  sessionId: string
  changed: () => void
  failed: (error: CatalogReadError) => void
  last: string | null
}
type Head = {
  public_session_id: string
  session_id: string | null
  journal_epoch: string | null
  next_event_seq: string | null
  session_fence: string | null
  workspace_revision: string | null
  deleted_at: string | null
  catalog: string
}
const shared = new WeakMap<Pool, Map<string, Map<number, SharedSessionHeadHints>>>()

/** Ephemeral change hints only. The RR history reader owns all authorization and content. */
export class SharedSessionHeadHints {
  private readonly listeners = new Set<Listener>()
  private readonly query: Pool['query']
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null

  private constructor(pool: Pool, private readonly dataset: string, private readonly interval: number) {
    this.query = pool.query.bind(pool)
  }

  static for(config: CapturedCatalogReadConfig): SharedSessionHeadHints {
    let datasets = shared.get(config.pool)
    if (!datasets) { datasets = new Map(); shared.set(config.pool, datasets) }
    let intervals = datasets.get(config.datasetName)
    if (!intervals) { intervals = new Map(); datasets.set(config.datasetName, intervals) }
    let hints = intervals.get(config.pollIntervalMs)
    if (!hints) {
      hints = new SharedSessionHeadHints(config.pool, config.datasetName, config.pollIntervalMs)
      intervals.set(config.pollIntervalMs, hints)
    }
    return hints
  }

  listen(sessionId: string, changed: () => void, failed: (error: CatalogReadError) => void): () => void {
    const listener: Listener = { sessionId, changed, failed, last: null }
    this.listeners.add(listener)
    this.schedule()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && this.timer !== null) {
        clearTimeout(this.timer)
        this.timer = null
      }
    }
  }

  /** Deterministic drain of the same poll, also usable by an internal verification barrier. */
  flush(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
    if (this.running) { return this.running }
    if (!this.listeners.size) { return Promise.resolve() }
    const listeners = [...this.listeners]
    const sessions = [...new Set(listeners.map(listener => listener.sessionId))].sort()
    const run = async (): Promise<void> => {
      try {
        const result = await this.query<Head>(`WITH heads AS (
          SELECT COALESCE(jsonb_agg(jsonb_build_array(scope,dataset_name,publication_epoch,revision::text)
            ORDER BY scope),'[]'::jsonb)::text AS signature
          FROM durable_runtime.catalog_heads WHERE dataset_name=$1 OR scope='catalog'
        ) SELECT wanted.public_session_id,a.session_id::text,s.journal_epoch::text,
          s.next_event_seq::text,s.session_fence::text,w.revision::text AS workspace_revision,
          w.deleted_at::text,heads.signature AS catalog
        FROM unnest($2::text[]) AS wanted(public_session_id) CROSS JOIN heads
        LEFT JOIN durable_runtime.structured_session_aliases a ON a.public_session_id=wanted.public_session_id
        LEFT JOIN durable_runtime.sessions s ON s.id=a.session_id
        LEFT JOIN durable_runtime.workspaces w ON w.id=s.workspace_id AND w.dataset_name=$1
        ORDER BY wanted.public_session_id`, [this.dataset, sessions])
        const signatures = new Map(result.rows.map(row => [row.public_session_id, JSON.stringify(row)]))
        for (const listener of listeners) {
          if (!this.listeners.has(listener)) { continue }
          const signature = signatures.get(listener.sessionId) ?? 'missing'
          // An unknown first baseline is a hint: a commit between snapshot and attach is not lost.
          if (signature !== listener.last) {
            listener.last = signature
            try { listener.changed() } catch (error) { this.fail(listener, error) }
          }
        }
      } catch (error) {
        for (const listener of listeners) { this.fail(listener, error) }
      }
    }
    this.running = run().finally(() => { this.running = null; this.schedule() })
    return this.running
  }

  private fail(listener: Listener, error: unknown): void {
    if (!this.listeners.has(listener)) { return }
    try { listener.failed(catalogReadFailure(error)) } catch { /* A sibling owns its own transport. */ }
  }

  private schedule(): void {
    if (!this.listeners.size || this.timer !== null || this.running) { return }
    this.timer = setTimeout(() => { this.timer = null; void this.flush() }, this.interval)
    this.timer.unref?.()
  }
}
