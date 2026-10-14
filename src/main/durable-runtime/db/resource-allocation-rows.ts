import type {
  AttemptId, Counter, ExecutionEpoch, IncidentId, IntentRevision, OperationId,
  ProfileRevision, RecoveryEpisodeId, RowRevision, RuntimeUnitId,
} from "../../../shared/durable-runtime/identity.ts";
import type { EvidenceJson } from "../resources/evidence/types.ts";

export type ResourcePolicyVersionRow = {
  policy_revision: Counter<"resource-policy-revision">;
  policy: Readonly<Record<string, EvidenceJson>>;
  policy_digest: string;
  created_at: Date;
};
export type ResourceBudgetScopeRow = {
  scope: string;
  dataset_name: string;
  budget_domain_id: string;
  memory_limit_bytes: Counter<"memory-bytes">;
  cpu_limit_millicores: Counter<"cpu-millicores">;
  configuration: Readonly<Record<string, EvidenceJson>>;
  evidence_ref: string;
  revision: RowRevision<"resource-budget-scope">;
};
export type ResourceUnitStateRow = {
  runtime_unit_id: RuntimeUnitId;
  budget_scope: string;
  approved_profile_revision: ProfileRevision;
  desired_profile_revision: ProfileRevision | null;
  policy_revision: Counter<"resource-policy-revision">;
  current_episode_id: RecoveryEpisodeId | null;
  revision: RowRevision<"resource-unit-state">;
  breaker: "CLOSED" | "OPEN";
  breaker_reason: string | null;
  last_oom_at: Date | null;
  accounted_memory_bytes: Counter<"memory-bytes">;
  accounted_cpu_millicores: Counter<"cpu-millicores">;
  accounting_evidence_ref: string;
};
export type ResourceOperationPlanRow = {
  operation_id: OperationId;
  runtime_unit_id: RuntimeUnitId;
  kind: "GROW" | "REPLACE" | "DOWNSIZE" | "ROLLBACK";
  incident_id: IncidentId | null;
  episode_id: RecoveryEpisodeId | null;
  attempt_id: AttemptId;
  execution_epoch: ExecutionEpoch;
  policy_revision: Counter<"resource-policy-revision">;
  previous_profile_revision: ProfileRevision;
  target_profile_revision: ProfileRevision;
  intent_revision: IntentRevision;
  workload_profile_key: string;
  target_pod_shape: Readonly<Record<string, EvidenceJson>>;
  spec_digest: string;
  facts: Readonly<Record<string, EvidenceJson>>;
  facts_digest: string;
  created_at: Date;
  downsize_original_operation_id: OperationId | null;
  observation_window_ref: string | null;
};
export type ResourceGrowthLedgerRow = {
  operation_id: OperationId;
  runtime_unit_id: RuntimeUnitId;
  episode_id: RecoveryEpisodeId;
  charge_kind: "GROW" | "REPLACE";
  charged_at: Date;
};
export type ResourceReservationAccountingRow = {
  operation_id: OperationId;
  runtime_unit_id: RuntimeUnitId;
  resource_profile_revision: ProfileRevision;
  budget_scope: string;
  steady_memory_bytes: Counter<"memory-bytes">;
  steady_cpu_millicores: Counter<"cpu-millicores">;
  overlap_memory_bytes: Counter<"memory-bytes">;
  overlap_cpu_millicores: Counter<"cpu-millicores">;
  protected_memory_bytes: Counter<"memory-bytes">;
  protected_cpu_millicores: Counter<"cpu-millicores">;
  additional_memory_charge_bytes: Counter<"memory-bytes">;
  additional_cpu_charge_millicores: Counter<"cpu-millicores">;
  facts: Readonly<Record<string, EvidenceJson>>;
  facts_digest: string;
  spec_digest: string;
  created_at: Date;
};
