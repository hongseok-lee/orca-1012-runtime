import type { Pool } from 'pg'
import type { DurableTransactionResult } from '../db/connection.ts'
import type { CommandId, ExecutionToken, GatewayContext } from '../runtime/gateway/types.ts'
import type { DeliveryAttemptId, EventId, MessageId, SessionId } from '../../../shared/durable-runtime/identity.ts'

/** Internal HA selector. Values alone are not authenticated controller authority. */
export type InputOwnerLossRequest = Readonly<{
  context: GatewayContext
  commandId: CommandId
  executionToken: ExecutionToken
  messageId: MessageId
  deliveryAttemptId: DeliveryAttemptId
}>
export type InputOwnerLossRecord = Readonly<{
  disposition: 'UNKNOWN_RECORDED' | 'ALREADY_UNKNOWN' | 'NOT_APPLICABLE'
  sessionId: SessionId
  commandId: CommandId
  messageId: MessageId
  deliveryAttemptId: DeliveryAttemptId
  eventId: EventId | null
}>
export type InputOwnerLossResult = DurableTransactionResult<InputOwnerLossRecord>
export type ReconcileInputAfterOwnerLoss = (pool: Pool, request: InputOwnerLossRequest) => Promise<InputOwnerLossResult>
