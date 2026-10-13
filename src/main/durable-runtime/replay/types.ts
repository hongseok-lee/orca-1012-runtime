import type { JsonValue } from '../db/atomic.ts'
import type { OutboxClaim } from '../journal/publisher.ts'

export const OPS_REPLAY_STREAM = 'orca-1012-dev-v1:ops'
export type ReplayCursor = { streamId: string; epoch: string; offset: string }
export type ReplayEvent = {
  cursor: ReplayCursor
  sourceEventId: string
  occurredAt: Date
  publishedAt: Date
  payload: JsonValue
}
export type ReplayPage =
  | {
      status: 'PAGE'
      events: ReplayEvent[]
      nextCursor: ReplayCursor
      highWatermark: ReplayCursor
      minimumOffset: string
      scanned: number
    }
  | {
      status: 'RESET_REQUIRED'
      currentEpoch: string
      minimumOffset: string
      latestOffset: string
      streamId: string
    }
export type ReplayRead = {
  streamId: string
  epoch: string
  afterOffset: string
  optionalUnitFilter?: string
  limit: number
}
export type PublicationResult =
  | { status: 'PUBLISHED' | 'REPLAYED'; cursor: ReplayCursor }
  | { status: 'UNSUPPORTED_SOURCE'; sourceEventId: string; sourceKind: string | null }
  | { status: 'NOT_PUBLISHED_HERE'; sourceEventId: string }
export type PublicationInput = { claim: OutboxClaim; streamId?: string }
