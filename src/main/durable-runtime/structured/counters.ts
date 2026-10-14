import { counter, type SessionFence } from '../../../shared/durable-runtime/identity.ts'
import { StructuredPreparationError } from './snapshot.ts'

/** Other epoch/term brands are deliberately not accepted as SessionFence. */
export function structuredFenceToDecimal(fence: number): SessionFence {
  if (!Number.isSafeInteger(fence) || fence <= 0) {
    throw new StructuredPreparationError('STRUCTURED_INVALID_FENCE')
  }
  return counter('session-fence', String(fence))
}

/** Exact wire conversion for an internal journal sequence or revision. */
export function structuredCounterToNumber(decimal: string, minimum: 0 | 1 = 0): number {
  if (typeof decimal !== 'string' || !/^(0|[1-9][0-9]*)$/.test(decimal)) {
    throw new StructuredPreparationError('STRUCTURED_UNREADABLE_COUNTER')
  }
  const value = BigInt(decimal)
  if (value < BigInt(minimum) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new StructuredPreparationError('STRUCTURED_UNREADABLE_COUNTER')
  }
  return Number(value)
}

export function structuredFenceToNumber(fence: SessionFence): number {
  return structuredCounterToNumber(fence, 1)
}
