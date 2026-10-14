import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { EventId } from '../../../shared/durable-runtime/identity.ts'
import type { JsonValue } from '../db/atomic.ts'
import { DurableDatabaseError, safeDatabaseError, withDurableTransaction } from '../db/connection.ts'
import type { OutboxClaim } from '../journal/publisher.ts'

export type OpsReplayClaimInput = { owner: string; limit: number; leaseMs: number }
export type OpsReplayClaimIdentity = Readonly<{ sourceEventId: EventId; owner: string; token: string }>
export function opsReplayErrorCode(error: unknown): string {
  const code = safeDatabaseError(error).code
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'DB_FAILURE'
}
// Rows seen before COMMIT are NOT reported as successfully committed claims.
// Preserve only identities when COMMIT/rollback acknowledgement is uncertain.
export class OpsReplayClaimFailure extends DurableDatabaseError {
  readonly owner: string
  readonly token: string
  readonly observedSourceEventIds: readonly EventId[]
  constructor(code: string, owner: string, token: string, ids: readonly EventId[]) {
    super(code)
    this.owner = owner
    this.token = token
    this.observedSourceEventIds = Object.freeze([...ids])
  }
}
export async function claimOpsReplayOutbox(pool: Pool, input: OpsReplayClaimInput): Promise<OutboxClaim[]> {
  const fixed = Object.freeze({ owner: input.owner, limit: input.limit, leaseMs: input.leaseMs })
  if (typeof fixed.owner !== 'string' || !fixed.owner ||
    !Number.isSafeInteger(fixed.limit) || fixed.limit < 1 || fixed.limit > 100 ||
    !Number.isSafeInteger(fixed.leaseMs) || fixed.leaseMs < 1) {
    throw new DurableDatabaseError('OUTBOX_CLAIM_INPUT')
  }
  const token = randomUUID()
  let observed: readonly EventId[] = []
  try {
    return await withDurableTransaction(pool, async tx => {
      const result = await tx.query<{ id: string; event: JsonValue; aggregate_id: string;
        claim_expires_at: Date; attempt_count: string }>(
        `WITH candidates AS (
          SELECT id FROM durable_runtime.outbox_events
          WHERE (state='PENDING' OR (state='CLAIMED' AND claim_expires_at<=clock_timestamp()))
            AND (event->>'kind' IN ('NOTIFICATION_OPENED','NOTIFICATION_OBSERVED','NOTIFICATION_READ',
              'NOTIFICATION_RESOLVED','RUNTIME_EVENT_FAILED')
              OR (event->>'kind'='RUNTIME_EVENT_OUTCOME' AND event->>'outcome' IN ('DONE','FAILED')))
          ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
        UPDATE durable_runtime.outbox_events o SET state='CLAIMED',claim_owner=$2,claim_token=$3,
          claim_expires_at=clock_timestamp()+$4::bigint*interval '1 millisecond',
          attempt_count=attempt_count+1,last_attempt_at=clock_timestamp()
        FROM candidates c WHERE o.id=c.id
        RETURNING o.id,o.event,o.aggregate_id,o.claim_expires_at,o.attempt_count`,
        [fixed.limit, fixed.owner, token, fixed.leaseMs])
      const claims = result.rows.map(row => ({ id: logicalId('event', row.id), event: row.event,
        aggregateId: row.aggregate_id, owner: fixed.owner, token,
        claimExpiresAt: new Date(row.claim_expires_at.getTime()), attemptCount: row.attempt_count }))
      observed = claims.map(claim => claim.id)
      return claims
    })
  } catch (error) {
    throw new OpsReplayClaimFailure(opsReplayErrorCode(error), fixed.owner, token, observed)
  }
}
