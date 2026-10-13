import { DurableDatabaseError } from '../db/connection.ts'

export class CatalogError extends DurableDatabaseError {
  constructor(code: string) {
    super(code)
    this.name = 'CatalogError'
  }
}
