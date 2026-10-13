import type { Pool } from 'pg'
import { captureCatalogAuthority, type CatalogAuthority } from './authority.ts'
import { readCatalogSnapshot, type CatalogSnapshot } from './read.ts'

/** Local commit hints only. A listener is not a transport or durable event log. */
export interface CatalogChangeHints {
  listen(onChange: () => void): () => void
}

export async function subscribeCatalogSnapshots(
  pool: Pool, authorityInput: CatalogAuthority, hints: CatalogChangeHints,
  observer: (snapshot: CatalogSnapshot) => Promise<void> | void,
  onError: (error: unknown) => void
): Promise<() => void> {
  const authority = captureCatalogAuthority(authorityInput)
  let stopped = false, pending = true, running = false, last = ''
  const signature = (snapshot: CatalogSnapshot) => JSON.stringify(snapshot.heads.map(row => [row.scope, row.publication_epoch, row.revision]))
  const drain = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      while (pending && !stopped) {
        pending = false
        let snapshot = await readCatalogSnapshot(pool, authority)
        // Listener already attached. Recheck the same durable snapshot boundary;
        // a raced publication is re-read rather than guessed from an event payload.
        const checked = await readCatalogSnapshot(pool, authority)
        if (signature(snapshot) !== signature(checked)) snapshot = checked
        if (!stopped && signature(snapshot) !== last) {
          await observer(snapshot)
          last = signature(snapshot)
        }
      }
    } finally { running = false }
  }
  // Attach before first Pool checkout/snapshot.
  let started = false
  const detach = hints.listen(() => { pending = true; if (started) void drain().catch(onError) })
  started = true
  try { await drain() } catch (error) { stopped = true; detach(); throw error }
  return () => { if (!stopped) { stopped = true; detach() } }
}
