import { randomUUID } from "node:crypto";
import type {
  EventId,
  Sequence,
  SessionId,
  RowRevision,
} from "../../../shared/durable-runtime/identity.ts";
import { logicalId, counter } from "../../../shared/durable-runtime/identity.ts";
import { DurableDatabaseError, type DurableTransaction } from "../db/connection.ts";
import type { JsonValue } from "../db/atomic.ts";
import { lockAggregates } from "../db/locks.ts";

export type JournalSource =
  | { kind: "NATIVE"; sourceKind: string; provider: string; lineage: string; nativeId: string }
  | {
      kind: "PRODUCER";
      sourceKind: string;
      producerId: string;
      incarnation: string;
      producerSeq: Sequence<"producer">;
    };
export type JournalEvent = {
  eventId: EventId;
  sessionId: SessionId;
  journalEpoch: string;
  sequence: Sequence<"journal">;
  recordedAt: Date;
};
function sourceKey(session: SessionId, source: JournalSource): string {
  const tuple =
    source.kind === "NATIVE"
      ? [
          "v1",
          session,
          "native",
          source.sourceKind,
          source.provider,
          source.lineage,
          source.nativeId,
        ]
      : [
          "v1",
          session,
          "producer",
          source.sourceKind,
          source.producerId,
          source.incarnation,
          source.producerSeq,
        ];
  if (tuple.some((part) => typeof part !== "string" || !part))
    throw new DurableDatabaseError("JOURNAL_SOURCE");
  if (source.kind === "PRODUCER") {
    logicalId("producer", source.producerId);
    if (counter("sequence:producer", source.producerSeq) === "0")
      throw new DurableDatabaseError("JOURNAL_SOURCE");
  }
  return JSON.stringify(tuple);
}

// Caller locks all affected Sessions before Runtime Units/common resources.
// This row lock serializes epoch/sequence allocation and INSERT in the same tx.
export async function appendSessionEvent(
  tx: DurableTransaction,
  input: { sessionId: SessionId; source: JournalSource; body: JsonValue },
): Promise<JournalEvent> {
  const key = sourceKey(input.sessionId, input.source);
  await lockAggregates(tx, { sessionIds: [input.sessionId] });
  const existing = await tx.query(
    "SELECT event_id,journal_epoch,seq,committed_at,body=$2::jsonb AS matches FROM durable_runtime.session_events WHERE source_key=$1",
    [key, JSON.stringify(input.body)],
  );
  if (existing.rowCount) {
    const row = existing.rows[0];
    if (!row.matches) throw new DurableDatabaseError("JOURNAL_SOURCE_CONFLICT");
    return {
      eventId: logicalId("event", row.event_id),
      sessionId: input.sessionId,
      journalEpoch: row.journal_epoch,
      sequence: counter("sequence:journal", row.seq),
      recordedAt: row.committed_at,
    };
  }
  const allocation = await tx.query(
    "UPDATE durable_runtime.sessions SET next_event_seq=next_event_seq+1 WHERE id=$1 RETURNING journal_epoch,next_event_seq-1 AS seq",
    [input.sessionId],
  );
  const eventId = logicalId("event", randomUUID());
  const row = allocation.rows[0];
  const inserted = await tx.query(
    "INSERT INTO durable_runtime.session_events(session_id,journal_epoch,seq,event_id,source_key,body) VALUES($1,$2,$3,$4,$5,$6) RETURNING committed_at",
    [input.sessionId, row.journal_epoch, row.seq, eventId, key, JSON.stringify(input.body)],
  );
  return {
    eventId,
    sessionId: input.sessionId,
    journalEpoch: row.journal_epoch,
    sequence: counter("sequence:journal", row.seq),
    recordedAt: inserted.rows[0].committed_at,
  };
}

export async function enqueueOutbox(
  tx: DurableTransaction,
  input: {
    eventId: EventId;
    aggregateId: string;
    aggregateKind: string;
    revision: RowRevision<string>;
    event: JsonValue;
  },
): Promise<void> {
  await tx.query(
    "INSERT INTO durable_runtime.outbox_events(id,aggregate_id,aggregate_kind,revision,event,created_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()) ON CONFLICT(id) DO NOTHING",
    [
      input.eventId,
      input.aggregateId,
      input.aggregateKind,
      input.revision,
      JSON.stringify(input.event),
    ],
  );
  const row = await tx.query(
    "SELECT id FROM durable_runtime.outbox_events WHERE id=$1 AND aggregate_id=$2 AND aggregate_kind=$3 AND revision=$4 AND event=$5::jsonb",
    [
      input.eventId,
      input.aggregateId,
      input.aggregateKind,
      input.revision,
      JSON.stringify(input.event),
    ],
  );
  if (row.rowCount !== 1) throw new DurableDatabaseError("OUTBOX_IDENTITY_CONFLICT");
}

export type AuditTransition = {
  actorId: string;
  pairedDeviceId?: string;
  runtimeUnitId?: string;
  sessionId?: SessionId;
  operationId?: string;
  attemptId?: string;
  podUid?: string;
  nodeUid?: string;
  resourceProfileRevision?: string;
  kind: string;
  reasonCode?: string;
  previousState?: JsonValue;
  nextState?: JsonValue;
  occurredAt: Date;
  receivedAt: Date;
  producerId: string;
  producerSeq: Sequence<"producer">;
  evidenceRefs: readonly string[];
};
export async function appendAudit(tx: DurableTransaction, input: AuditTransition): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO durable_runtime.runtime_audit_events(id,actor_id,paired_device_id,runtime_unit_id,session_id,operation_id,attempt_id,pod_uid,node_uid,resource_profile_revision,kind,reason_code,previous_state,next_state,occurred_at,received_at,producer_id,producer_seq,evidence_refs,payload)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'{}')`,
    [
      id,
      input.actorId,
      input.pairedDeviceId ?? null,
      input.runtimeUnitId ?? null,
      input.sessionId ?? null,
      input.operationId ?? null,
      input.attemptId ?? null,
      input.podUid ?? null,
      input.nodeUid ?? null,
      input.resourceProfileRevision ?? null,
      input.kind,
      input.reasonCode ?? null,
      input.previousState === undefined ? null : JSON.stringify(input.previousState),
      input.nextState === undefined ? null : JSON.stringify(input.nextState),
      input.occurredAt,
      input.receivedAt,
      input.producerId,
      input.producerSeq,
      JSON.stringify(input.evidenceRefs),
    ],
  );
  return id;
}
