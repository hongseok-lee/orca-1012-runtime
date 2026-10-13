import { CatalogError } from './errors.ts'
import { prepareCatalogCall, type CatalogCallContext, type PreparedCatalogCall } from './request.ts'
import type { CatalogMethod, CatalogWireResults } from './wire.ts'

export type CatalogEntries = {
  readonly [Method in CatalogMethod]:
    (request: PreparedCatalogCall<Method>) => Promise<CatalogWireResults[Method]>
}

/**
 * Typed internal adapter. Entries are supplied by the Catalog SQL implementation;
 * missing prerequisites fail explicitly instead of returning an empty catalog,
 * a tombstone-only close, or a fabricated physical-stop result.
 */
export class CatalogCompatibilityFacade {
  private readonly entries: Readonly<Partial<CatalogEntries>>

  constructor(entries: Partial<CatalogEntries>) {
    this.entries = Object.freeze({ ...entries })
  }

  invoke<Method extends CatalogMethod>(
    method: Method, params: unknown, context: CatalogCallContext
  ): Promise<CatalogWireResults[Method]> {
    // No asynchronous step precedes preparation. Ports never see caller-owned
    // payloads, Date objects or mutable authority/capability collections.
    const request = prepareCatalogCall(method, params, context)
    const entry = this.entries[method] as
      ((request: PreparedCatalogCall<Method>) => Promise<CatalogWireResults[Method]>) | undefined
    if (!entry) throw new CatalogError('CATALOG_ENTRY_UNAVAILABLE')
    return entry(request)
  }
}
