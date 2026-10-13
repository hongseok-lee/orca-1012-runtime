import type { JsonValue } from '../db/atomic.ts'
import { CatalogError } from './errors.ts'

export type Immutable<T> = T extends readonly (infer Item)[]
  ? readonly Immutable<Item>[]
  : T extends object ? { readonly [Key in keyof T]: Immutable<T[Key]> } : T

/** Capture JSON without invoking getters, toJSON, or an asynchronous producer. */
export function captureCatalogJson(input: unknown): JsonValue {
  const visiting = new Set<object>()
  function copy(value: unknown): JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value !== 'object' || value === null || visiting.has(value)) {
      throw new CatalogError('CATALOG_JSON')
    }
    const prototype = Object.getPrototypeOf(value)
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      throw new CatalogError('CATALOG_JSON')
    }
    visiting.add(value)
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value)
      if (Object.getOwnPropertySymbols(value).length) throw new CatalogError('CATALOG_JSON')
      if (Array.isArray(value)) {
        const result: JsonValue[] = []
        for (let index = 0; index < value.length; index++) {
          const item = descriptors[String(index)]
          if (!item || !('value' in item)) throw new CatalogError('CATALOG_JSON')
          result.push(copy(item.value))
        }
        if (Object.keys(value).some(key => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) {
          throw new CatalogError('CATALOG_JSON')
        }
        return Object.freeze(result) as JsonValue[]
      }
      const result: Record<string, JsonValue> = Object.create(null)
      for (const key of Object.keys(value)) {
        const item = descriptors[key]
        if (!item || !('value' in item)) throw new CatalogError('CATALOG_JSON')
        result[key] = copy(item.value)
      }
      return Object.freeze(result)
    } finally {
      visiting.delete(value)
    }
  }
  return copy(input)
}

/** Schema results are detached too; optional undefined object fields stay absent. */
export function captureCatalogParsed<T>(input: T): Immutable<T> {
  const visiting = new Set<object>()
  function clean(value: unknown): unknown {
    if (value !== null && typeof value === 'object') {
      if (visiting.has(value)) throw new CatalogError('CATALOG_JSON')
      const prototype = Object.getPrototypeOf(value)
      if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        throw new CatalogError('CATALOG_JSON')
      }
      visiting.add(value)
      try {
        if (Array.isArray(value)) return value.map(clean)
        const result: Record<string, unknown> = Object.create(null)
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
          if (!descriptor.enumerable) continue
          if (!('value' in descriptor)) throw new CatalogError('CATALOG_JSON')
          if (descriptor.value !== undefined) result[key] = clean(descriptor.value)
        }
        return result
      } finally {
        visiting.delete(value)
      }
    }
    return value
  }
  return captureCatalogJson(clean(input)) as Immutable<T>
}

/** Object.freeze(Date) does not freeze its internal time. Store the captured scalar. */
export function captureCatalogInstant(input: Date): number {
  if (!(input instanceof Date)) throw new CatalogError('CATALOG_TIME')
  const epochMs = Date.prototype.getTime.call(input)
  if (!Number.isFinite(epochMs)) throw new CatalogError('CATALOG_TIME')
  return epochMs
}
