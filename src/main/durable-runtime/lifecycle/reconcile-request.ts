import type { JsonValue } from '../db/atomic.ts'
import { canonicalInput } from '../runtime/gateway/input.ts'
import type { GatewayContext } from '../runtime/gateway/types.ts'

// Snapshot an already authorized context. This preserves values/nominal types;
// it neither authenticates a caller nor exports a string-to-proof constructor.
export function snapshotGatewayContext(context: GatewayContext): GatewayContext {
  return Object.freeze({
    runtimeUnitId: context.runtimeUnitId,
    operationId: context.operationId,
    controller: Object.freeze({ ...context.controller })
  })
}
export function snapshotCommandInput(input: JsonValue): JsonValue {
  const copied: JsonValue = JSON.parse(canonicalInput(input))
  function freeze(value: JsonValue): void {
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) { freeze(child) }
      Object.freeze(value)
    }
  }
  freeze(copied)
  return copied
}
