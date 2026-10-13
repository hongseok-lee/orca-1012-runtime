export class CatalogError extends Error {
  constructor(readonly code: string) {
    super(`Catalog operation failed (${code})`)
    this.name = 'CatalogError'
  }
}
