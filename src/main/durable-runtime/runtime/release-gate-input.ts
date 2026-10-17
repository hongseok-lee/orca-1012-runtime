import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import type { ReleaseGateInput } from './port.ts'

function fields(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new DurableDatabaseError('RELEASE_GATE_INPUT')
  }
  const keys = Reflect.ownKeys(value), result: Record<string, unknown> = {}
  if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key))) {
    throw new DurableDatabaseError('RELEASE_GATE_INPUT')
  }
  for (const key of expected) {
    const d = Object.getOwnPropertyDescriptor(value, key)
    if (!d || !('value' in d)) { throw new DurableDatabaseError('RELEASE_GATE_INPUT') }
    result[key] = d.value
  }
  return result
}

/** Internal Port/ledger input only. Neither branch is an effect permit. The
 * original manifest branch stays distinct from a first NEW cold execution;
 * revision zero or a synthetic manifest never stands in for that distinction. */
export function captureReleaseGateInput(value: unknown): ReleaseGateInput {
  const initial = value !== null && typeof value === 'object' && Object.hasOwn(value, 'coldStart')
  const raw = fields(value, initial ? ['attemptId', 'coldStart'] : ['attemptId', 'manifestDecisionRevision'])
  if (typeof raw.attemptId !== 'string') { throw new DurableDatabaseError('RELEASE_GATE_INPUT') }
  const attemptId = logicalId('attempt', raw.attemptId)
  if (!initial) {
    if (typeof raw.manifestDecisionRevision !== 'string') { throw new DurableDatabaseError('RELEASE_GATE_INPUT') }
    return Object.freeze({ attemptId, manifestDecisionRevision: counter('row:manifest-decision', raw.manifestDecisionRevision) })
  }
  const cold = fields(raw.coldStart, ['kind', 'planDigest'])
  if (cold.kind !== 'INITIAL_NEW' || typeof cold.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(cold.planDigest)) {
    throw new DurableDatabaseError('RELEASE_GATE_INPUT')
  }
  return Object.freeze({ attemptId, coldStart: Object.freeze({ kind: 'INITIAL_NEW', planDigest: cold.planDigest }) })
}
