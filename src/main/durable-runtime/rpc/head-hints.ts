import type { Pool } from 'pg'
import type { CatalogChangeHints } from '../catalog/subscribe.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import { CatalogReadError, catalogReadFailure } from './config.ts'

type Head = { scope: string; dataset_name: string; publication_epoch: string; revision: string }
// Ephemeral hint ownership only; never a Catalog/projection/event authority.
const hintsByPool = new WeakMap<Pool, Map<string, SharedCatalogHeadHints>>()
export class SharedCatalogHeadHints {
  private readonly listeners = new Set<{ changed: () => void; failed: (error: CatalogReadError) => void }>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private generation = 0
  private last: string | null = null
  private constructor(private readonly pool: Pool, private readonly dataset: string, private readonly interval: number) {}
  static for(config: CapturedCatalogReadConfig): SharedCatalogHeadHints {
    let map = hintsByPool.get(config.pool)
    if (!map) { map = new Map(); hintsByPool.set(config.pool, map) }
    let hint = map.get(config.datasetName)
    if (!hint) { hint = new SharedCatalogHeadHints(config.pool, config.datasetName, config.pollIntervalMs); map.set(config.datasetName, hint) }
    if (hint.interval !== config.pollIntervalMs) { throw new CatalogReadError('CATALOG_SHARED_POLL_CONFIG_CONFLICT') }
    return hint
  }
  forSubscriber(failed: (error: CatalogReadError) => void): CatalogChangeHints {
    return { listen: changed => {
      const listener = { changed, failed }
      this.listeners.add(listener)
      this.schedule()
      return () => {
        this.listeners.delete(listener)
        if (this.listeners.size === 0) {
          this.generation++; this.last = null
          if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
        }
      }
    } }
  }
  private schedule(): void {
    if (!this.listeners.size || this.timer !== null || this.running) { return }
    this.timer = setTimeout(() => { this.timer = null; void this.poll() }, this.interval)
    this.timer.unref?.()
  }
  private async poll(): Promise<void> {
    if (this.running || !this.listeners.size) { return }
    this.running = true
    const generation = this.generation
    try {
      const result = await this.pool.query<Head>(`SELECT scope,dataset_name,publication_epoch,revision FROM durable_runtime.catalog_heads
        WHERE dataset_name=$1 OR scope='catalog' ORDER BY scope`, [this.dataset])
      if (generation !== this.generation || !this.listeners.size) { return }
      const global = result.rows.find(row => row.scope === 'catalog')
      if (!global || global.dataset_name !== this.dataset) { throw new CatalogReadError('CATALOG_DATASET_MISMATCH') }
      const signature = JSON.stringify(result.rows.map(row => [row.scope, row.publication_epoch, row.revision]))
      // Unknown first baseline is a hint too: a commit after the initial snapshot
      // must not be lost merely because the first poll adopted its newer head.
      if (signature !== this.last) {
        this.last = signature
        for (const listener of [...this.listeners]) {
          if (!this.listeners.has(listener)) { continue }
          try { listener.changed() } catch (error) {
            try { listener.failed(catalogReadFailure(error)) } catch { /* A closed transport must not strand sibling listeners. */ }
          }
        }
      }
    } catch (error) {
      if (generation === this.generation) {
        const failure = catalogReadFailure(error)
        for (const listener of [...this.listeners]) {
          if (this.listeners.has(listener)) {
            try { listener.failed(failure) } catch { /* The subscriber owns transport cleanup. */ }
          }
        }
      }
    } finally { this.running = false; this.schedule() }
  }
}
