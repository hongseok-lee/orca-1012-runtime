import { createHash } from 'node:crypto'
import { DurableDatabaseError } from '../../db/connection.ts'
import type { JsonValue } from './types.ts'

// Stable protected JSON input hashing; nothing is written to infrastructure logs.
// No application quota, summarization, transcript-derived proof, or I/O occurs.
export function canonicalInput(value: JsonValue): string {
  const ancestors = new Set<object>()
  function encode(item: JsonValue): string {
    if (item === null) {
      return 'null'
    }
    if (typeof item === 'string' || typeof item === 'boolean') {
      return JSON.stringify(item)
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      return JSON.stringify(item)
    }
    if (typeof item !== 'object' || ancestors.has(item)) {
      throw new DurableDatabaseError('COMMAND_INPUT_INVALID')
    }
    ancestors.add(item)
    let encoded: string
    if (Array.isArray(item)) {
      // Sparse arrays and undefined must not silently hash as null.
      const values: string[] = []
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i))
        if (!descriptor || !('value' in descriptor)) {
          throw new DurableDatabaseError('COMMAND_INPUT_INVALID')
        }
        values.push(encode(descriptor.value))
      }
      encoded = `[${values.join(',')}]`
    } else {
      const prototype: unknown = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new DurableDatabaseError('COMMAND_INPUT_INVALID')
      }
      encoded = `{${Object.keys(item)
        .sort()
        .map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(item, key)
          if (!descriptor || !('value' in descriptor)) {
            throw new DurableDatabaseError('COMMAND_INPUT_INVALID')
          }
          return `${JSON.stringify(key)}:${encode(descriptor.value)}`
        })
        .join(',')}}`
    }
    ancestors.delete(item)
    return encoded
  }
  return encode(value)
}
export function inputDigest(value: JsonValue): string {
  return createHash('sha256').update(canonicalInput(value)).digest('hex')
}
