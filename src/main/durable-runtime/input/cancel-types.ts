import type { JsonValue } from '../db/atomic.ts'
import type {
  MessageId,
  DeliveryAttemptId,
  RuntimeUnitId,
  AttemptId,
  ExecutionEpoch
} from '../../../shared/durable-runtime/identity.ts'
import type { InputAuthority } from './types.ts'

export type CancelInputRequest = {
  readonly authority: InputAuthority
  readonly method: string
  readonly operationKey: string
  readonly targetMessageId: MessageId
  readonly originalPayload: JsonValue
}
export type FixedDeliveryTarget = {
  readonly deliveryAttemptId: DeliveryAttemptId
  readonly runtimeUnitId: RuntimeUnitId
  readonly attemptId: AttemptId
  readonly executionEpoch: ExecutionEpoch
  readonly providerTurnRef: string | null
}
export type CancelInterruptStatus =
  | 'NOT_REQUIRED'
  | 'REQUESTED'
  | 'CONFIRMED'
  | 'UNKNOWN'
  | 'ALREADY_SETTLED'

/** Transaction input only; the target is resolved internally from immutable observations. */
export type ObservedTurnCancelRequest = {
  readonly authority: InputAuthority
  readonly provider: 'claude' | 'codex'
  readonly nativeTurnId: string
  readonly method: string
  readonly operationKey: string
  readonly originalPayload: JsonValue
}
