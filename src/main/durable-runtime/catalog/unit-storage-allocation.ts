import { posix } from 'node:path'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { CatalogError } from './errors.ts'

/** A configured leaf supplies deployment policy, never a shared writer domain
 * for unrelated runtime units. The durable unit ID makes retries/restarts use
 * the same sibling leaf while keeping each unit's protected HOME/checkout apart. */
export function catalogUnitStorageDirectory(templateDirectory: string, unitId: string): string {
  logicalId('runtime-unit', unitId)
  if (!templateDirectory.startsWith('/') || templateDirectory === '/' ||
      templateDirectory.includes('\\') || posix.normalize(templateDirectory) !== templateDirectory ||
      templateDirectory.endsWith('/') || Array.from(templateDirectory).some(char =>
        char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new CatalogError('CATALOG_STORAGE_CONFIGURATION')
  }
  const directory = posix.join(posix.dirname(templateDirectory), unitId)
  if (directory === templateDirectory) {
    throw new CatalogError('CATALOG_STORAGE_ALLOCATION_COLLISION')
  }
  return directory
}

export type CatalogUnitStorageAllocation = Readonly<{
  kind: 'RUNTIME_UNIT_LEAF'
  unitId: string
  leafId: string
  templateCanonicalDirectory: string
}>

/** Revalidate stored server allocation before borrowing a deployment template.
 * This only selects policy. Directory identity and writer grants still require
 * the existing authenticated collector and transactional storage checks. */
export function readCatalogUnitStorageAllocation(
  launchRequest: unknown, unitId: string, canonicalDirectory: string
): CatalogUnitStorageAllocation | null {
  if (!launchRequest || typeof launchRequest !== 'object' || Array.isArray(launchRequest)) {
    return null
  }
  const server = Reflect.get(launchRequest, 'server')
  if (!server || typeof server !== 'object' || Array.isArray(server)) { return null }
  const allocation = Reflect.get(server, 'storageAllocation')
  if (allocation === undefined) { return null }
  if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation) ||
      allocation.kind !== 'RUNTIME_UNIT_LEAF' || allocation.unitId !== unitId ||
      allocation.leafId !== unitId || typeof allocation.templateCanonicalDirectory !== 'string' ||
      catalogUnitStorageDirectory(allocation.templateCanonicalDirectory, unitId) !== canonicalDirectory) {
    throw new CatalogError('CATALOG_STORAGE_ALLOCATION_INVALID')
  }
  const mapping = Reflect.get(server, 'storagePathMapping')
  if (!mapping || typeof mapping !== 'object' || mapping.canonicalDirectory !== canonicalDirectory) {
    throw new CatalogError('CATALOG_STORAGE_ALLOCATION_INVALID')
  }
  return Object.freeze({ kind: 'RUNTIME_UNIT_LEAF', unitId, leafId: unitId,
    templateCanonicalDirectory: allocation.templateCanonicalDirectory })
}
