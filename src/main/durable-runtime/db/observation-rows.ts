import type {
  AttemptId, ExecutionEpoch, LogicalId, OperationId, ProducerId,
  RowRevision, RuntimeUnitId, Sequence,
} from "../../../shared/durable-runtime/identity.ts";
import type { PodUid } from "../runtime/runtime-evidence.ts";

export type ObservationEpisodeRow = {
  id: LogicalId<"observation-episode">;
  runtime_unit_id: RuntimeUnitId;
  attempt_id: AttemptId;
  execution_epoch: ExecutionEpoch;
  pod_uid: PodUid;
  start_watermark: Sequence<"observation"> | null;
  started_at: Date;
  deadline_at: Date;
  resolved_at: Date | null;
  state: "OPEN" | "FENCING" | "BLOCKED" | "RESOLVED";
  revision: RowRevision<"observation-episode">;
  start_source_ref: string;
  start_producer_id: ProducerId | null;
  fence_operation_id: OperationId | null;
  reason: string | null;
};

// Challenge IDs correlate requests; they are not authentication or fresh proof.
export type ObservationChallengeRow = {
  id: string;
  episode_id: LogicalId<"observation-episode">;
  runtime_unit_id: RuntimeUnitId;
  attempt_id: AttemptId;
  pod_uid: PodUid;
  execution_epoch: ExecutionEpoch;
  issued_at: Date;
  request_source_ref: string;
  expected_producer_id: ProducerId | null;
  expected_watermark: Sequence<"observation"> | null;
  consumed_at: Date | null;
  superseded_at: Date | null;
  superseded_by: string | null;
};
