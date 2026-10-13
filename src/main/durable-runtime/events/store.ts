import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { counter, logicalId } from "../../../shared/durable-runtime/identity.ts";
import type { SessionId, Sequence } from "../../../shared/durable-runtime/identity.ts";
import { runDurableMutation } from "../db/atomic.ts";
import type { JsonValue } from "../db/atomic.ts";
import { DurableDatabaseError, safeDatabaseError, withDurableTransaction } from "../db/connection.ts";
import type { DurableTransaction } from "../db/connection.ts";
import { lockAggregates } from "../db/locks.ts";
import { appendAudit, appendSessionEvent, enqueueOutbox } from "../journal/store.ts";
import {
  EVENT_RETRY_POLICY, type ClaimResult, type ConsumerAuthority, type ConsumerOptions,
  type EnqueueEvent, type EventClaim, type EventHandler, type EventProducer,
  type EventRecord, type ProcessResult, type ProducerStream,
} from "./types.ts";

const d = "durable_runtime.";
type ProducerRow = {
  producer_id: string; incarnation: string; agent_id: string; runtime_unit_id: string;
  attempt_id: string; pod_uid: string; execution_epoch: string;
  committed_through: string; processed_through: string;
};
type QueueRow = {
  event_id: string; producer_id: string; incarnation: string; producer_seq: string;
  agent_id: string; payload: JsonValue; state: string; attempt_count: string;
  claim_owner: string | null; claim_controller_term: string | null;
  claim_token: string | null; claim_live: boolean; retry_due: boolean;
  claim_expires_at: Date | null; last_error: string | null;
};
type Head = { producer: ProducerRow; queue: QueueRow | null; targets: SessionId[] };

function reject(code: string): never { throw new DurableDatabaseError(code); }
function json(value: JsonValue): string {
  function normalize(item: JsonValue): JsonValue {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype) {
      const result: { [key: string]: JsonValue } = Object.create(null);
      for (const key of Object.keys(item).sort()) result[key] = normalize(item[key]);
      return result;
    }
    return reject("EVENT_JSON");
  }
  return JSON.stringify(normalize(value));
}
function streamValues(stream: ProducerStream): string[] {
  logicalId("producer", stream.producerId);
  if (typeof stream.incarnation !== "string" || !stream.incarnation) reject("EVENT_STREAM");
  return [stream.producerId, stream.incarnation];
}
function targetIds(ids: readonly SessionId[]): SessionId[] {
  for (const id of ids) logicalId("session", id);
  const result = [...new Set(ids)].sort();
  if (result.length !== ids.length) reject("EVENT_TARGET_DUPLICATE");
  return result;
}
function milliseconds(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) reject("EVENT_DEADLINE");
  return value;
}
function validateAuthority(authority: ConsumerAuthority): void {
  counter("controller-term", authority.term);
  if (!authority.scope || !authority.owner) reject("EVENT_AUTHORITY");
}
async function producer(tx: DurableTransaction, stream: ProducerStream, locked: boolean): Promise<ProducerRow> {
  const key = JSON.stringify(streamValues(stream));
  if (locked) tx.advanceLock(6, key);
  const result = await tx.query<ProducerRow>(
    `SELECT * FROM ${d}runtime_event_producers WHERE producer_id=$1 AND incarnation=$2${locked ? " FOR UPDATE" : ""}`,
    streamValues(stream),
  );
  if (!result.rows[0]) reject("EVENT_PRODUCER_MISSING");
  if (locked) tx.markLockAcquired(6, key);
  return result.rows[0];
}
async function targets(tx: DurableTransaction, eventId: string): Promise<SessionId[]> {
  const rows = await tx.query<{ session_id: string }>(
    `SELECT session_id FROM ${d}runtime_event_targets WHERE event_id=$1 ORDER BY session_id`, [eventId],
  );
  return rows.rows.map(row => logicalId("session", row.session_id));
}
function sameTargets(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
async function lease(tx: DurableTransaction, authority: ConsumerAuthority): Promise<void> {
  validateAuthority(authority);
  tx.advanceLock(5, authority.scope);
  const row = await tx.query(
    `SELECT owner,term,expires_at>clock_timestamp() AS live FROM ${d}controller_leases WHERE scope=$1 FOR UPDATE`,
    [authority.scope],
  );
  if (!row.rows[0] || row.rows[0].owner !== authority.owner || row.rows[0].term !== authority.term || !row.rows[0].live)
    reject("EVENT_STALE_AUTHORITY");
  tx.markLockAcquired(5, authority.scope);
}
async function liveLease(tx: DurableTransaction, authority: ConsumerAuthority): Promise<void> {
  const valid = await tx.query(
    `SELECT scope FROM ${d}controller_leases WHERE scope=$1 AND owner=$2 AND term=$3 AND expires_at>clock_timestamp()`,
    [authority.scope, authority.owner, authority.term],
  );
  if (valid.rowCount !== 1) reject("EVENT_STALE_AUTHORITY");
}

/** Register only a binding already verified by the upstream workload boundary.
 * Attempts may be historical; old-epoch events are not current-state proofs. */
export async function registerEventProducer(pool: Pool, input: EventProducer): Promise<void> {
  const w = input.workload;
  const stream = { producerId: w.producerId, incarnation: w.incarnation };
  streamValues(stream);
  logicalId("agent", input.agentId); logicalId("runtime-unit", input.runtimeUnitId);
  logicalId("attempt", w.attemptId); counter("execution-epoch", w.executionEpoch);
  if (!w.podUid || !w.principalRef || !w.authenticationEvidenceRef) reject("EVENT_BINDING");
  await withDurableTransaction(pool, async tx => {
    const binding = await tx.query(
      `SELECT a.id FROM ${d}attempts a WHERE a.id=$1 AND a.runtime_unit_id=$2 AND a.execution_epoch=$3 AND a.pod_uid=$4 AND a.incarnation=$5
       AND EXISTS(SELECT 1 FROM ${d}runtime_members m JOIN ${d}sessions s ON s.id=m.session_id WHERE m.runtime_unit_id=a.runtime_unit_id AND s.agent_id=$6)`,
      [w.attemptId, input.runtimeUnitId, w.executionEpoch, w.podUid, w.incarnation, input.agentId],
    );
    if (binding.rowCount !== 1) reject("EVENT_BINDING");
    await tx.query(
      `INSERT INTO ${d}runtime_event_producers(producer_id,incarnation,agent_id,runtime_unit_id,attempt_id,pod_uid,execution_epoch)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(producer_id,incarnation) DO NOTHING`,
      [w.producerId, w.incarnation, input.agentId, input.runtimeUnitId, w.attemptId, w.podUid, w.executionEpoch],
    );
    const row = await producer(tx, stream, true);
    if (row.agent_id !== input.agentId || row.runtime_unit_id !== input.runtimeUnitId || row.attempt_id !== w.attemptId ||
      row.pod_uid !== w.podUid || row.execution_epoch !== w.executionEpoch) reject("EVENT_PRODUCER_CONFLICT");
  });
}

/** Returns only after the PG COMMIT reply. A lost reply throws; retransmit the
 * original identity instead of fabricating an ACK or a new event identity. */
export async function enqueueRuntimeEvent(pool: Pool, input: EventProducer, event: EnqueueEvent): Promise<{
  status: "COMMITTED" | "REPLAYED"; durablyCommittedThrough: Sequence<"producer">;
}> {
  logicalId("event", event.eventId);
  if (counter("sequence:producer", event.sequence) === "0") reject("EVENT_SEQUENCE");
  const originalPayload = json(event.payload);
  const ids = targetIds(event.targetSessionIds);
  const w = input.workload;
  const stream = { producerId: w.producerId, incarnation: w.incarnation };
  return withDurableTransaction(pool, async tx => {
    const p = await producer(tx, stream, true);
    if (!w.principalRef || !w.authenticationEvidenceRef || p.agent_id !== input.agentId ||
      p.runtime_unit_id !== input.runtimeUnitId || p.attempt_id !== w.attemptId || p.pod_uid !== w.podUid || p.execution_epoch !== w.executionEpoch)
      reject("EVENT_BINDING");
    const validTargets = await tx.query(
      `SELECT s.id FROM ${d}sessions s JOIN ${d}runtime_members m ON m.session_id=s.id
       WHERE s.id=ANY($1::uuid[]) AND s.agent_id=$2 AND m.runtime_unit_id=$3`, [ids, p.agent_id, p.runtime_unit_id],
    );
    if (validTargets.rowCount !== ids.length) reject("EVENT_TARGET_BINDING");
    const prior = await tx.query<QueueRow & { matches: boolean }>(
      `SELECT q.*,payload=$4::jsonb AS matches FROM ${d}runtime_event_queue q
       WHERE event_id=$1 OR (producer_id=$2 AND incarnation=$3 AND producer_seq=$5)`,
      [event.eventId, w.producerId, w.incarnation, originalPayload, event.sequence],
    );
    const replayed = prior.rowCount !== 0;
    if (replayed) {
      const row = prior.rows[0];
      if (prior.rowCount !== 1 || row.event_id !== event.eventId || row.producer_id !== w.producerId || row.incarnation !== w.incarnation ||
        row.producer_seq !== event.sequence || row.agent_id !== p.agent_id || !row.matches ||
        !sameTargets(await targets(tx, row.event_id), ids)) reject("EVENT_IDENTITY_CONFLICT");
    } else {
      await tx.query(
        `INSERT INTO ${d}runtime_event_queue(event_id,producer_id,incarnation,producer_seq,agent_id,payload,state)
         VALUES($1,$2,$3,$4,$5,$6,'PENDING')`,
        [event.eventId, w.producerId, w.incarnation, event.sequence, p.agent_id, originalPayload],
      );
      for (const session of ids) await tx.query(
        `INSERT INTO ${d}runtime_event_targets(event_id,session_id,agent_id) VALUES($1,$2,$3)`, [event.eventId, session, p.agent_id],
      );
    }
    // Find the first gap without generating rows up to an arbitrary sequence.
    const prefix = await tx.query<{ through: string }>(
      `SELECT coalesce(min($3::bigint+rn-1) FILTER(WHERE producer_seq<>$3::bigint+rn),max(producer_seq),$3::bigint) AS through
       FROM (SELECT producer_seq,row_number() OVER(ORDER BY producer_seq) AS rn FROM ${d}runtime_event_queue
             WHERE producer_id=$1 AND incarnation=$2 AND producer_seq>$3::bigint) suffix`,
      [w.producerId, w.incarnation, p.committed_through],
    );
    const through = counter("sequence:producer", prefix.rows[0].through);
    await tx.query(
      `UPDATE ${d}runtime_event_producers SET committed_through=$3,revision=revision+1 WHERE producer_id=$1 AND incarnation=$2`,
      [w.producerId, w.incarnation, through],
    );
    return { status: replayed ? "REPLAYED" : "COMMITTED", durablyCommittedThrough: through };
  });
}

async function lockHead(tx: DurableTransaction, stream: ProducerStream, authority: ConsumerAuthority, options: Pick<ConsumerOptions, "operationIds">): Promise<Head> {
  const before = await producer(tx, stream, false);
  const candidate = await tx.query<{ event_id: string }>(
    `SELECT event_id FROM ${d}runtime_event_queue WHERE producer_id=$1 AND incarnation=$2 AND producer_seq=$3::bigint+1`,
    [...streamValues(stream), before.processed_through],
  );
  const ids = candidate.rows[0] ? await targets(tx, candidate.rows[0].event_id) : [];
  await lockAggregates(tx, { sessionIds: ids, runtimeUnitIds: [logicalId("runtime-unit", before.runtime_unit_id)], operationIds: options.operationIds });
  await lease(tx, authority);
  const p = await producer(tx, stream, true);
  // Head movement between discovery and locks requires a fresh transaction,
  // never acquiring an undiscovered Session after the Runtime/lease locks.
  if (before.processed_through !== p.processed_through) reject("EVENT_HEAD_CHANGED");
  const q = await tx.query<QueueRow>(
    `SELECT q.*,claim_expires_at>clock_timestamp() AS claim_live,
       (next_retry_at IS NULL OR next_retry_at<=clock_timestamp()) AS retry_due
     FROM ${d}runtime_event_queue q WHERE producer_id=$1 AND incarnation=$2 AND producer_seq=$3::bigint+1 FOR UPDATE`,
    [...streamValues(stream), p.processed_through],
  );
  const row = q.rows[0] ?? null;
  if ((row?.event_id ?? null) !== (candidate.rows[0]?.event_id ?? null) ||
    (row && !sameTargets(ids, await targets(tx, row.event_id)))) reject("EVENT_HEAD_CHANGED");
  if (row) { tx.advanceLock(7, row.event_id); tx.markLockAcquired(7, row.event_id); }
  return { producer: p, queue: row, targets: ids };
}
function record(head: Head): EventRecord {
  const q = head.queue!;
  return {
    eventId: logicalId("event", q.event_id), producerId: logicalId("producer", q.producer_id),
    incarnation: head.producer.incarnation as ProducerStream["incarnation"],
    sequence: counter("sequence:producer", q.producer_seq), agentId: logicalId("agent", q.agent_id),
    runtimeUnitId: logicalId("runtime-unit", head.producer.runtime_unit_id), payload: q.payload,
    targetSessionIds: head.targets, attemptCount: Number(q.attempt_count),
  };
}
async function history(tx: DurableTransaction, head: Head, authority: ConsumerAuthority, stage: string, errorCode?: string): Promise<void> {
  await tx.query(
    `INSERT INTO ${d}runtime_event_attempt_history(id,event_id,attempt_number,stage,controller_term,occurred_at,error_code)
     VALUES($1,$2,$3,$4,$5,clock_timestamp(),$6)`,
    [randomUUID(), head.queue!.event_id, head.queue!.attempt_count, stage, authority.term, errorCode ?? null],
  );
}
async function advanceHead(tx: DurableTransaction, head: Head): Promise<void> {
  const p = head.producer;
  const q = head.queue!;
  const moved = await tx.query(
    `UPDATE ${d}runtime_event_producers SET processed_through=$3,revision=revision+1
     WHERE producer_id=$1 AND incarnation=$2 AND processed_through=$4 AND committed_through>=$3`,
    [p.producer_id, p.incarnation, q.producer_seq, p.processed_through],
  );
  if (moved.rowCount !== 1) reject("EVENT_HEAD_CONFLICT");
}
async function writeTerminalArtifacts(tx: DurableTransaction, head: Head, authority: ConsumerAuthority, outcome: "DONE" | "FAILED", errorCode?: string): Promise<void> {
  const event = record(head);
  const body: JsonValue = { kind: "RUNTIME_EVENT_OUTCOME", eventId: event.eventId, outcome, attempts: event.attemptCount,
    retryCount: Math.max(event.attemptCount - 1, 0), policyRevision: EVENT_RETRY_POLICY.revision, ...(errorCode ? { errorCode } : {}) };
  for (const session of event.targetSessionIds) {
    const journal = await appendSessionEvent(tx, { sessionId: session, source: {
      kind: "PRODUCER", sourceKind: `runtime-event:${outcome}`, producerId: event.producerId,
      incarnation: event.incarnation, producerSeq: event.sequence,
    }, body });
    await enqueueOutbox(tx, { eventId: journal.eventId, aggregateId: session, aggregateKind: "session",
      revision: counter("row:session", journal.sequence), event: body });
  }
  // A fresh audit producer identity separates the consumer's terminal decision
  // from source sequence/incarnation identity; source refs remain in nextState.
  const now = await tx.query<{ at: Date }>("SELECT clock_timestamp() AS at");
  await appendAudit(tx, {
    actorId: authority.owner, runtimeUnitId: event.runtimeUnitId, attemptId: head.producer.attempt_id,
    podUid: head.producer.pod_uid, kind: `RUNTIME_EVENT_${outcome}`, reasonCode: errorCode,
    nextState: { outcome, eventId: event.eventId, attempts: event.attemptCount,
      producerId: event.producerId, incarnation: event.incarnation, sequence: event.sequence },
    occurredAt: now.rows[0].at, receivedAt: now.rows[0].at, producerId: randomUUID(),
    producerSeq: counter("sequence:producer", "1"), evidenceRefs: [`runtime-event:${event.eventId}`],
  });
}

async function failureFinalizer(tx: DurableTransaction, head: Head, authority: ConsumerAuthority, errorCode: string): Promise<void> {
  const event = record(head);
  for (const session of head.targets) {
    const existing = await tx.query(
      `SELECT context_record_id FROM ${d}runtime_event_failure_contexts WHERE event_id=$1 AND session_id=$2`, [event.eventId, session],
    );
    if (existing.rowCount) continue;
    const revision = await tx.query<{ context_revision: string }>(
      `UPDATE ${d}sessions SET context_revision=context_revision+1,revision=revision+1 WHERE id=$1 RETURNING context_revision`, [session],
    );
    const contextId = randomUUID();
    const ref: JsonValue = {
      kind: "FAILED_RUNTIME_EVENT_HISTORY", originalEventRef: `runtime-event:${event.eventId}`, errorCode,
      attemptHistoryRef: `runtime-event:${event.eventId}:attempts`, attempts: event.attemptCount,
      retryCount: 5, executionDirective: "HISTORY_ONLY_DO_NOT_REEXECUTE", controlRecoveryConfirmed: false,
    };
    await tx.query(
      `INSERT INTO ${d}session_context_records(id,session_id,revision,kind,target_event_id,body_ref) VALUES($1,$2,$3,'RUNTIME_EVENT_FAILED',$4,$5)`,
      [contextId, session, revision.rows[0].context_revision, event.eventId, json(ref)],
    );
    await tx.query(
      `INSERT INTO ${d}runtime_event_failure_contexts(event_id,session_id,context_record_id) VALUES($1,$2,$3)`,
      [event.eventId, session, contextId],
    );
  }
  const notificationId = randomUUID();
  const incidentKey = `runtime-event-failed:${event.eventId}`;
  await tx.query(
    `INSERT INTO ${d}notifications(id,incident_key,target_ref,reason,state,first_seen_at,last_seen_at,retry_count)
     VALUES($1,$2,$3,$4,'OPEN',clock_timestamp(),clock_timestamp(),5) ON CONFLICT(incident_key) DO NOTHING`,
    [notificationId, incidentKey, json({ eventId: event.eventId, agentId: event.agentId, sessionIds: [...event.targetSessionIds] }), errorCode],
  );
  const notification = await tx.query<{ id: string; revision: string }>(`SELECT id,revision FROM ${d}notifications WHERE incident_key=$1`, [incidentKey]);
  await enqueueOutbox(tx, { eventId: logicalId("event", notification.rows[0].id), aggregateId: notification.rows[0].id,
    aggregateKind: "notification", revision: counter("row:notification", notification.rows[0].revision),
    event: { kind: "RUNTIME_EVENT_FAILED", eventId: event.eventId, incidentKey } });
  await writeTerminalArtifacts(tx, head, authority, "FAILED", errorCode);
  await liveLease(tx, authority);
  await tx.query(
    `UPDATE ${d}runtime_event_queue SET state='FAILED',last_error=$2,processed_at=NULL,terminal_at=clock_timestamp(),next_retry_at=NULL,
       claim_owner=NULL,claim_controller_term=NULL,claim_token=NULL,claim_expires_at=NULL WHERE event_id=$1`, [event.eventId, errorCode],
  );
  await advanceHead(tx, head);
}

export async function claimRuntimeEvent(pool: Pool, stream: ProducerStream, authority: ConsumerAuthority, options: ConsumerOptions): Promise<ClaimResult> {
  const duration = milliseconds(options.claimDurationMs);
  return withDurableTransaction(pool, async tx => {
    const head = await lockHead(tx, stream, authority, options);
    const q = head.queue;
    if (!q || BigInt(q.producer_seq) > BigInt(head.producer.committed_through)) return { status: "WAITING", reason: "GAP" };
    if (q.state === "PROCESSING") {
      if (q.claim_live && q.claim_owner === authority.owner && q.claim_controller_term === authority.term) return { status: "WAITING", reason: "CLAIM" };
      // This STARTED attempt is already charged; record uncertainty, never reset.
      const oldAuthority = { ...authority, term: counter("controller-term", q.claim_controller_term!) };
      await history(tx, head, oldAuthority, "UNCONFIRMED", "CLAIM_UNCONFIRMED");
      q.last_error = "CLAIM_UNCONFIRMED";
    } else if (q.state === "RETRY" && !q.retry_due) return { status: "WAITING", reason: "RETRY" };
    else if (q.state !== "PENDING" && q.state !== "RETRY") reject("EVENT_HEAD_TERMINAL_DRIFT");
    if (Number(q.attempt_count) >= EVENT_RETRY_POLICY.maximumAttempts) {
      await failureFinalizer(tx, head, authority, q.last_error ?? "ATTEMPTS_EXHAUSTED");
      return { status: "FAILED", eventId: logicalId("event", q.event_id) };
    }
    const token = randomUUID();
    const claimed = await tx.query<{ attempt_count: string; claim_expires_at: Date }>(
      `UPDATE ${d}runtime_event_queue SET state='PROCESSING',attempt_count=attempt_count+1,retry_count=greatest(attempt_count,0),
       next_retry_at=NULL,claim_owner=$2,claim_controller_term=$3,claim_token=$4,claim_expires_at=clock_timestamp()+$5::bigint*interval '1 millisecond'
       WHERE event_id=$1 RETURNING attempt_count,claim_expires_at`, [q.event_id, authority.owner, authority.term, token, duration],
    );
    q.attempt_count = claimed.rows[0].attempt_count;
    await history(tx, head, authority, "STARTED");
    await liveLease(tx, authority);
    return { status: "CLAIMED", claim: { ...record(head), token, authority: { ...authority }, expiresAt: claimed.rows[0].claim_expires_at } };
  });
}

async function claimedHead(tx: DurableTransaction, claim: EventClaim, options: Pick<ConsumerOptions, "operationIds">): Promise<Head> {
  const head = await lockHead(tx, claim, claim.authority, options);
  const q = head.queue;
  if (!q || q.event_id !== claim.eventId || q.state !== "PROCESSING" || q.claim_token !== claim.token ||
    q.claim_owner !== claim.authority.owner || q.claim_controller_term !== claim.authority.term || !q.claim_live ||
    Number(q.attempt_count) !== claim.attemptCount || !sameTargets(head.targets, claim.targetSessionIds)) reject("EVENT_STALE_CLAIM");
  return head;
}
/** DB-only handler. P1-03's guarded transaction prevents COMMIT/ROLLBACK/SET or
 * multi-statement escape. Side effects are separate durable operations/outbox. */
export async function processRuntimeEvent(pool: Pool, claim: EventClaim, handler: EventHandler, options: Pick<ConsumerOptions, "operationIds"> = {}): Promise<ProcessResult> {
  logicalId("event", claim.eventId); logicalId("claim", claim.token);
  const identity = {
    key: { principalId: claim.authority.owner, sessionScope: `runtime-event:${claim.eventId}`, method: "runtime-event.process", operationKey: claim.token },
    payloadHash: createHash("sha256").update(json({ eventId: claim.eventId, token: claim.token, attempt: claim.attemptCount,
      term: claim.authority.term, scope: claim.authority.scope })).digest("hex"),
    locks: { sessionIds: claim.targetSessionIds, runtimeUnitIds: [claim.runtimeUnitId], operationIds: options.operationIds },
  };
  try {
    const commit = await runDurableMutation(pool, identity, async tx => {
      const head = await claimedHead(tx, claim, options);
      await handler(tx, record(head));
      await liveLease(tx, claim.authority);
      const stillLive = await tx.query(`SELECT event_id FROM ${d}runtime_event_queue WHERE event_id=$1 AND claim_token=$2 AND claim_expires_at>clock_timestamp()`, [claim.eventId, claim.token]);
      if (stillLive.rowCount !== 1) reject("EVENT_STALE_CLAIM");
      await writeTerminalArtifacts(tx, head, claim.authority, "DONE");
      await history(tx, head, claim.authority, "SUCCEEDED");
      await tx.query(
        `UPDATE ${d}runtime_event_queue SET state='DONE',processed_at=clock_timestamp(),terminal_at=clock_timestamp(),next_retry_at=NULL,
         claim_owner=NULL,claim_controller_term=NULL,claim_token=NULL,claim_expires_at=NULL WHERE event_id=$1`, [claim.eventId],
      );
      await advanceHead(tx, head);
      return { eventId: claim.eventId, state: "DONE" };
    });
    return { status: commit.status === "UNCERTAIN" ? "UNCERTAIN" : "DONE", commit };
  } catch (error) {
    const safe = safeDatabaseError(error);
    if (["EVENT_STALE_AUTHORITY", "EVENT_STALE_CLAIM", "EVENT_HEAD_CHANGED"].includes(safe.code)) return { status: "STALE" };
    return recordRuntimeEventFailure(pool, claim, safe.code, options);
  }
}

/** A failed processing transaction has already rolled back. This independent
 * transaction records only sanitized error codes and the original attempt. */
export async function recordRuntimeEventFailure(pool: Pool, claim: EventClaim, errorCode: string, options: Pick<ConsumerOptions, "operationIds"> = {}): Promise<ProcessResult> {
  // Arbitrary messages, payload excerpts and credentials are never persisted.
  const code = /^[A-Z0-9][A-Z0-9_]{0,63}$/.test(errorCode) ? errorCode : "HANDLER_FAILURE";
  try {
    return await withDurableTransaction(pool, async tx => {
      const head = await claimedHead(tx, claim, options);
      await history(tx, head, claim.authority, "FAILED", code);
      if (claim.attemptCount >= EVENT_RETRY_POLICY.maximumAttempts) {
        await failureFinalizer(tx, head, claim.authority, code);
        return { status: "FAILED", eventId: claim.eventId };
      }
      const delay = milliseconds(EVENT_RETRY_POLICY.retryDelaysMs[claim.attemptCount - 1]);
      await tx.query(
        `UPDATE ${d}runtime_event_queue SET state='RETRY',last_error=$2,next_retry_at=clock_timestamp()+$3::bigint*interval '1 millisecond',
         claim_owner=NULL,claim_controller_term=NULL,claim_token=NULL,claim_expires_at=NULL WHERE event_id=$1`, [claim.eventId, code, delay],
      );
      await liveLease(tx, claim.authority);
      return { status: "RETRY", eventId: claim.eventId };
    });
  } catch (error) {
    const safe = safeDatabaseError(error);
    if (["EVENT_STALE_AUTHORITY", "EVENT_STALE_CLAIM", "EVENT_HEAD_CHANGED"].includes(safe.code)) return { status: "STALE" };
    throw safe;
  }
}

/** Manual recovery uses the same head/authority/locks and calls only the generic
 * finalizer. A sixth crashed attempt is not turned into a seventh handler run. */
export async function finalizeRuntimeEvent(pool: Pool, stream: ProducerStream, authority: ConsumerAuthority, options: Pick<ConsumerOptions, "operationIds"> = {}): Promise<ClaimResult> {
  return withDurableTransaction(pool, async tx => {
    const head = await lockHead(tx, stream, authority, options);
    const q = head.queue;
    if (!q || BigInt(q.producer_seq) > BigInt(head.producer.committed_through)) return { status: "WAITING", reason: "GAP" };
    if (Number(q.attempt_count) < EVENT_RETRY_POLICY.maximumAttempts) return { status: "WAITING", reason: "RETRY" };
    if (q.state === "PROCESSING") {
      if (q.claim_live && q.claim_owner === authority.owner && q.claim_controller_term === authority.term) return { status: "WAITING", reason: "CLAIM" };
      await history(tx, head, { ...authority, term: counter("controller-term", q.claim_controller_term!) }, "UNCONFIRMED", "CLAIM_UNCONFIRMED");
    } else if (q.state !== "RETRY") reject("EVENT_HEAD_TERMINAL_DRIFT");
    await failureFinalizer(tx, head, authority, q.last_error ?? "CLAIM_UNCONFIRMED");
    return { status: "FAILED", eventId: logicalId("event", q.event_id) };
  });
}
