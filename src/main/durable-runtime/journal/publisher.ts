import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { EventId } from "../../../shared/durable-runtime/identity.ts";
import type { JsonValue } from "../db/atomic.ts";
import { DurableDatabaseError, withDurableTransaction } from "../db/connection.ts";

export type OutboxClaim = {
  id: EventId;
  event: JsonValue;
  aggregateId: string;
  owner: string;
  token: string;
  claimExpiresAt: Date;
  attemptCount: string;
};
export async function claimOutbox(
  pool: Pool,
  input: { owner: string; limit: number; leaseMs: number },
): Promise<OutboxClaim[]> {
  if (
    !input.owner ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    !Number.isSafeInteger(input.leaseMs) ||
    input.leaseMs < 1
  ) {
    throw new DurableDatabaseError("OUTBOX_CLAIM_INPUT");
  }
  const token = randomUUID();
  return withDurableTransaction(pool, async (tx) => {
    const result = await tx.query(
      `WITH candidates AS (
      SELECT id FROM durable_runtime.outbox_events WHERE state='PENDING' OR (state='CLAIMED' AND claim_expires_at<=clock_timestamp())
      ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
      UPDATE durable_runtime.outbox_events o SET state='CLAIMED',claim_owner=$2,claim_token=$3,
      claim_expires_at=clock_timestamp()+$4::bigint*interval '1 millisecond',attempt_count=attempt_count+1,last_attempt_at=clock_timestamp()
      FROM candidates c WHERE o.id=c.id RETURNING o.id,o.event,o.aggregate_id,o.claim_expires_at,o.attempt_count`,
      [input.limit, input.owner, token, input.leaseMs],
    );
    return result.rows.map((row) => ({
      id: row.id,
      event: row.event,
      aggregateId: row.aggregate_id,
      owner: input.owner,
      token,
      claimExpiresAt: row.claim_expires_at,
      attemptCount: row.attempt_count,
    }));
  });
}
export async function markOutboxPublished(pool: Pool, claim: OutboxClaim): Promise<boolean> {
  return withDurableTransaction(pool, async (tx) => {
    const result = await tx.query(
      "UPDATE durable_runtime.outbox_events SET state='PUBLISHED',published_at=clock_timestamp(),claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL WHERE id=$1 AND state='CLAIMED' AND claim_owner=$2 AND claim_token=$3 AND claim_expires_at>clock_timestamp()",
      [claim.id, claim.owner, claim.token],
    );
    return result.rowCount === 1;
  });
}
export async function recordOutboxFailure(
  pool: Pool,
  claim: OutboxClaim,
  code: string,
): Promise<boolean> {
  if (!/^[A-Z0-9_]{1,64}$/.test(code)) {
    throw new DurableDatabaseError("OUTBOX_ERROR_CODE");
  }
  return withDurableTransaction(pool, async (tx) => {
    const result = await tx.query(
      "UPDATE durable_runtime.outbox_events SET state='PENDING',claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL,last_error_code=$4 WHERE id=$1 AND state='CLAIMED' AND claim_owner=$2 AND claim_token=$3 AND claim_expires_at>clock_timestamp()",
      [claim.id, claim.owner, claim.token, code],
    );
    return result.rowCount === 1;
  });
}
// Claims commit before this callback; no DB connection/row lock crosses I/O.
// A crash after publish but before marking re-delivers the same ID. Subscribers
// dedup by canonical event ID; this is at-least-once, not exactly-once delivery.
export async function publishOutboxClaim(
  pool: Pool,
  claim: OutboxClaim,
  publish: (event: { id: EventId; event: JsonValue }) => Promise<void>,
): Promise<boolean> {
  try {
    await publish({ id: claim.id, event: claim.event });
  } catch {
    await recordOutboxFailure(pool, claim, "PUBLISH_FAILED");
    return false;
  }
  return markOutboxPublished(pool, claim);
}
