import { randomUUID } from 'node:crypto'
import type { JsonValue } from '../db/atomic.ts'
import { OPS_REPLAY_STREAM } from './types.ts'
import type { OpsReplayWorkerConfig } from './worker.ts'

export function workerConfig(owner: string): OpsReplayWorkerConfig {
  return { owner, streamId: OPS_REPLAY_STREAM, batchSize: 100, claimLeaseMs: 60000, pollIntervalMs: 25 }
}
// Synthetic trusted source metadata only. No provider/authentication assertion.
export function notificationRow(kind = 'NOTIFICATION_OPENED', id = randomUUID()): {
  id: string; aggregate_id: string; aggregate_kind: string; revision: string;
  event: Record<string, JsonValue>; created_at: Date
} {
  const notificationId = randomUUID()
  const at = '2026-10-14T00:00:00.000Z'
  return { id, aggregate_id: notificationId, aggregate_kind: 'notification', revision: '0',
    created_at: new Date(at), event: {
      kind, sourceEventId: id, notificationId, incidentKey: `publication-fixture:${id}`,
      targetRef: { runtimeUnitId: randomUUID() }, revision: '0', state: kind === 'NOTIFICATION_RESOLVED' ? 'RESOLVED' : 'OPEN',
      reasonCode: 'FIXTURE_FAILED', retryCount: '0', occurredAt: at, firstSeenAt: at,
      lastSeenAt: at, readAt: kind === 'NOTIFICATION_READ' ? at : null,
      resolvedAt: kind === 'NOTIFICATION_RESOLVED' ? at : null, actionRef: null
    } }
}
