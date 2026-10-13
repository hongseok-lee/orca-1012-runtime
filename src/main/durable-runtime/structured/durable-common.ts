import { inputPayloadHash } from '../input/canonical.ts'
import type { JsonValue, ReceiptIdentity } from '../db/atomic.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import type { PreparedStructuredWire } from './wire.ts'
import { prepareStructuredWire } from './wire.ts'
import { resolveStructuredAuthority, type ResolvedStructuredAuthority } from './authority.ts'
import { snapshotStructuredJson, type JsonSnapshot } from './snapshot.ts'
import type { DurableStructuredCall } from './durable-types.ts'

export function prepareDurableStructuredCall(call: DurableStructuredCall, method: 'agentSession.create' | 'agentSession.send') {
  const wire = prepareStructuredWire(method, call.params, call.capabilities)
  if (!wire.ok) {
    throw new DurableDatabaseError(wire.refusal.code)
  }
  const authority = resolveStructuredAuthority(wire.value, call.authentication, call.targetAccess)
  if (!wire.value.mutation) {
    throw new DurableDatabaseError('STRUCTURED_MUTATION_REQUIRED')
  }
  return Object.freeze({ wire: wire.value, authority })
}

/** Public scope stays public across retries; no internal UUID/config/fence enters the hash. */
export function structuredReceiptIdentity(
  wire: PreparedStructuredWire,
  authority: ResolvedStructuredAuthority,
  semantic: JsonValue
): ReceiptIdentity {
  const mutation = wire.mutation
  if (!mutation) {
    throw new DurableDatabaseError('STRUCTURED_MUTATION_REQUIRED')
  }
  return Object.freeze({ key: Object.freeze({
    principalId: authority.principal,
    sessionScope: JSON.stringify(['structured-session', mutation.publicSessionId]),
    method: wire.method,
    operationKey: mutation.operationKey
  }), payloadHash: inputPayloadHash(semantic) })
}

/** Copies JSON data, not an authentication or execution proof. */
export function capturedJson<T>(value: T): T {
  return snapshotStructuredJson(value) as unknown as T
}
export function jsonValue(value: JsonSnapshot): JsonValue {
  // SAFETY: the validated snapshot contains JSON only; SQL serializers do not mutate it.
  return value as JsonValue
}
export function requireHeldStructuredSession(tx: DurableTransaction, sessionId: string): void {
  if (!tx.isLockHeld(1, sessionId)) {
    throw new DurableDatabaseError('STRUCTURED_SESSION_LOCK_REQUIRED')
  }
}
