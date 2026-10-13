import type { Pool } from "pg";
import type {
  AgentId, AttemptId, ControllerTerm, EventId, ExecutionEpoch, OperationId, ProducerId,
  RuntimeUnitId, Sequence, SessionId,
} from "../../../shared/durable-runtime/identity.ts";
import type { JsonValue, MutationOutcome } from "../db/atomic.ts";
import type { DurableTransaction } from "../db/connection.ts";
import type { Incarnation, PodUid, VerifiedWorkloadIdentity } from "../runtime/runtime-evidence.ts";

// Authentication is supplied by the workload boundary. This module exports no
// factory that can turn an unverified string into a verified workload identity.
export interface EventProducer {
  readonly workload: VerifiedWorkloadIdentity;
  readonly agentId: AgentId;
  readonly runtimeUnitId: RuntimeUnitId;
}
export interface ProducerStream {
  readonly producerId: ProducerId;
  readonly incarnation: Incarnation;
}
export interface EnqueueEvent {
  readonly eventId: EventId;
  readonly sequence: Sequence<"producer">;
  readonly payload: JsonValue;
  readonly targetSessionIds: readonly SessionId[];
}
// Internal controller callers only. No HTTP/RPC endpoint is installed here.
// Every mutation compares these values to the locked live PG lease and DB time.
export interface ConsumerAuthority {
  readonly scope: string;
  readonly owner: string;
  readonly term: ControllerTerm;
}
export interface EventRecord extends ProducerStream {
  readonly eventId: EventId;
  readonly sequence: Sequence<"producer">;
  readonly agentId: AgentId;
  readonly runtimeUnitId: RuntimeUnitId;
  // Original immutable PG producer binding, not the current Unit's execution.
  readonly attemptId: AttemptId;
  readonly podUid: PodUid;
  readonly executionEpoch: ExecutionEpoch;
  readonly payload: JsonValue;
  readonly targetSessionIds: readonly SessionId[];
  readonly attemptCount: number;
}
export interface EventClaim extends EventRecord {
  readonly token: string;
  readonly authority: ConsumerAuthority;
  readonly expiresAt: Date;
}
export type ClaimResult =
  | { readonly status: "CLAIMED"; readonly claim: EventClaim }
  | { readonly status: "WAITING"; readonly reason: "GAP" | "CLAIM" | "RETRY" }
  | { readonly status: "FAILED"; readonly eventId: EventId };
export interface ConsumerOptions {
  readonly claimDurationMs: number;
  // Declare all affected operations up front, before the controller lease.
  readonly operationIds?: readonly OperationId[];
}
export type ProcessResult =
  | { readonly status: "DONE" | "UNCERTAIN"; readonly commit: MutationOutcome }
  | { readonly status: "RETRY" | "FAILED"; readonly eventId: EventId }
  | { readonly status: "STALE" };
export type EventHandler = (tx: DurableTransaction, event: EventRecord) => Promise<void>;
export type QueuePool = Pool;

// Root's initial versioned policy; these retries are DB-consumer attempts,
// never six executions of a provider prompt or external command.
export const EVENT_RETRY_POLICY = Object.freeze({
  revision: "p1-12-backoff-v1",
  maximumAttempts: 6,
  retryDelaysMs: Object.freeze([1000, 2000, 4000, 8000, 16000]),
});
