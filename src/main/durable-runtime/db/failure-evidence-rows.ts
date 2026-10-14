import type {
  CounterTransition,
  EvidenceAlias,
  EvidenceJson,
  FailureClass,
  FailureObservationInput,
  PreparedFailureObservation,
} from "../resources/evidence/types.ts";
import type {
  AttemptId, ExecutionEpoch, LogicalId, RowRevision, RuntimeUnitId,
} from "../../../shared/durable-runtime/identity.ts";

export type FailureObservationRow = {
  id: FailureObservationInput["observationId"]; source_dedup_key: string;
  runtime_event_id: string | null; runtime_unit_id: RuntimeUnitId;
  attempt_id: AttemptId; pod_uid: FailureObservationInput["target"]["podUid"];
  execution_epoch: ExecutionEpoch; container_name: string | null;
  container_id: string | null; incarnation: string | null;
  termination_finished_at: string | null; counter_kind: CounterTransition["counter"] | null;
  counter_previous: string | null; counter_current: string | null;
  source_kind: FailureObservationInput["sourceKind"]; source_ref: string;
  schema_version: PreparedFailureObservation["schemaVersion"]; observed_at: Date;
  received_at: Date; evidence: EvidenceJson;
  evidence_digest: string;
};
export type FailureIncidentRow = {
  id: LogicalId<"incident">; runtime_unit_id: RuntimeUnitId;
  attempt_id: AttemptId; pod_uid: FailureObservationInput["target"]["podUid"];
  container_id: string; restart_identity: string;
  evidence_key: string; classification: FailureClass;
  evidence_refs: EvidenceJson; observed_at: Date;
  recovery_episode_id: string | null;
};
export type FailureIncidentObservationRow = {
  observation_id: FailureObservationInput["observationId"]; incident_id: LogicalId<"incident">;
  runtime_unit_id: RuntimeUnitId; attempt_id: AttemptId; };
export type FailureIncidentAliasRow = {
  alias_key: string; incident_id: LogicalId<"incident">;
  runtime_unit_id: RuntimeUnitId; attempt_id: AttemptId;
  alias_kind: EvidenceAlias["kind"]; alias_value: EvidenceAlias["value"]; };
export type FailureIncidentStateRow = {
  incident_id: LogicalId<"incident">; runtime_unit_id: RuntimeUnitId;
  attempt_id: AttemptId; execution_epoch: ExecutionEpoch;
  revision: RowRevision<"failure-incident-state">; collection_started_at: Date;
  deadline_at: Date; state: "COLLECTING" | "CLASSIFIED" | "BLOCKED";
  reason: string | null; classification_revision: RowRevision<"failure-classification">;
  evidence_ids: readonly FailureObservationInput["observationId"][]; };
