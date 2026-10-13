import { types as utilTypes } from 'node:util'

export type JsonSnapshot =
  | null | boolean | number | string
  | readonly JsonSnapshot[]
  | { readonly [key: string]: JsonSnapshot }

export class StructuredPreparationError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'StructuredPreparationError'
  }
}

/** Synchronous data-descriptor copy. No getter, toJSON, Date, sparse array or quota. */
export function snapshotStructuredJson(value: unknown): JsonSnapshot {
  const ancestors = new Set<object>()
  function copy(item: unknown): JsonSnapshot {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') {
      return item
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      return item
    }
    if (typeof item !== 'object' || ancestors.has(item)) {
      throw new StructuredPreparationError('STRUCTURED_NON_JSON')
    }
    if (utilTypes.isProxy(item)) {
      throw new StructuredPreparationError('STRUCTURED_NON_JSON')
    }
    const array = Array.isArray(item)
    const prototype: unknown = Object.getPrototypeOf(item)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new StructuredPreparationError('STRUCTURED_NON_JSON')
    }
    ancestors.add(item)
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item)
      const keys = Reflect.ownKeys(descriptors)
      if (keys.some((key) => typeof key !== 'string')) {
        throw new StructuredPreparationError('STRUCTURED_NON_JSON')
      }
      if (array) {
        const length = descriptors.length?.value as unknown
        if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
          throw new StructuredPreparationError('STRUCTURED_NON_JSON')
        }
        if (keys.length !== length + 1) {
          throw new StructuredPreparationError('STRUCTURED_NON_JSON')
        }
        const result: JsonSnapshot[] = []
        for (let i = 0; i < length; i++) {
          const descriptor = descriptors[String(i)]
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            throw new StructuredPreparationError('STRUCTURED_NON_JSON')
          }
          result.push(copy(descriptor.value))
        }
        return Object.freeze(result)
      }
      const result: { [key: string]: JsonSnapshot } = Object.create(null)
      for (const key of keys) {
        const descriptor = descriptors[key as string]
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new StructuredPreparationError('STRUCTURED_NON_JSON')
        }
        result[key as string] = copy(descriptor.value)
      }
      return Object.freeze(result)
    } finally {
      ancestors.delete(item)
    }
  }
  return copy(value)
}
