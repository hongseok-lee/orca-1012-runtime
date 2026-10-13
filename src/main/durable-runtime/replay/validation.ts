import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import type { JsonValue } from '../db/atomic.ts'
import { OPS_REPLAY_STREAM } from './types.ts'

export function reject(code: string): never {
  throw new DurableDatabaseError(code)
}
export function stream(value: string): string {
  if (value !== OPS_REPLAY_STREAM) {
    reject('REPLAY_STREAM')
  }
  return value
}
export function decimal(value: string): string {
  try {
    return counter('replay', value)
  } catch {
    return reject('REPLAY_CURSOR')
  }
}
export function uuid(value: string): string {
  try {
    return logicalId('replay-ref', value)
  } catch {
    return reject('REPLAY_SOURCE_METADATA')
  }
}
export function pageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    reject('REPLAY_PAGE_SIZE')
  }
  return value
}
export function object(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    reject('REPLAY_SOURCE_METADATA')
  }
  return value
}
export function text(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || !value) {
    reject('REPLAY_SOURCE_METADATA')
  }
  return value
}
export function date(value: string | Date): Date {
  const parsed = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    reject('REPLAY_SOURCE_METADATA')
  }
  return parsed
}
export function reason(value: JsonValue | undefined): string {
  const code = text(value)
  if (!/^[A-Z0-9][A-Z0-9_]{0,63}$/.test(code)) {
    reject('REPLAY_SOURCE_METADATA')
  }
  return code
}
export function target(value: JsonValue): Record<string, JsonValue> {
  const source = object(value)
  const result: Record<string, JsonValue> = {}
  for (const key of ['runtimeUnitId', 'operationId', 'eventId', 'agentId']) {
    if (source[key] !== undefined) {
      result[key] = uuid(text(source[key]))
    }
  }
  if (source.sessionIds !== undefined) {
    if (!Array.isArray(source.sessionIds)) {
      reject('REPLAY_SOURCE_METADATA')
    }
    result.sessionIds = [...new Set(source.sessionIds.map((item) => uuid(text(item))))].sort()
  }
  if (Object.keys(result).length === 0) {
    reject('REPLAY_SOURCE_METADATA')
  }
  return result
}
