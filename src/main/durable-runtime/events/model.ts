import type { SessionId } from '../../../shared/durable-runtime/identity.ts'

import type { JsonValue } from '../db/atomic.ts'

import type { RuntimeEventProducerRow, RuntimeEventQueueRow } from '../db/rows.ts'

export const d = 'durable_runtime.'
export type ProducerRow = RuntimeEventProducerRow
export type QueueRow = Omit<RuntimeEventQueueRow, 'payload'> & {
  payload: JsonValue
  claim_live: boolean
  retry_due: boolean
}
export type Head = { producer: ProducerRow; queue: QueueRow | null; targets: SessionId[] }
