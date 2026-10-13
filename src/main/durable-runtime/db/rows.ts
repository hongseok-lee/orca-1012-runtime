import type {
  AgentId,
  AttemptId,
  ControllerTerm,
  ContextRevision,
  LogicalId,
  ExecutionEpoch,
  IntentRevision,
  MessageId,
  MessageRevision,
  OperationId,
  ProfileRevision,
  RowRevision,
  RuntimeUnitId,
  Sequence,
  SessionFence,
  SessionId,
  StepRevision,
  StorageBindingId,
  StorageEpoch,
  WorkspaceId,
} from "../../../shared/durable-runtime/identity.ts";

export type SessionRow = {
  id: SessionId;
  agent_id: AgentId;
  workspace_id: WorkspaceId;
  session_fence: SessionFence;
  lifecycle: "OPEN" | "CLOSING" | "CLOSED";
  revision: RowRevision<"session">;
  next_input_seq: Sequence<"input">;
  next_message_seq: Sequence<"message">;
  next_event_seq: Sequence<"journal">;
  context_revision: ContextRevision;
  provider_binding_revision: string;
};
export type RuntimeUnitRow = {
  id: RuntimeUnitId;
  intent_revision: IntentRevision;
  execution_epoch: ExecutionEpoch;
  active_attempt_id: AttemptId | null;
  revision: RowRevision<"runtime-unit">;
  desired_mode: "RUNNING" | "SUSPENDED" | "DELETED";
  phase: string;
};
export type OperationRow = {
  id: OperationId;
  runtime_unit_id: RuntimeUnitId;
  intent_revision: IntentRevision;
  execution_epoch: ExecutionEpoch;
  controller_term: ControllerTerm;
  step_revision: StepRevision;
  revision: RowRevision<"operation">;
  step: string;
};
export type MessageInputKind = "GENERAL" | "COMMAND" | "QUESTION_RESPONSE" | "APPROVAL_RESPONSE";
export type MessageRow = {
  id: MessageId;
  session_id: SessionId;
  seq: Sequence<"message">;
  revision: MessageRevision;
  sealed_revision: MessageRevision | null;
  sealed_payload_hash: string | null;
  intake_status: string;
  input_kind: MessageInputKind;
  merge_closed: boolean;
};
export type StorageBindingRow = {
  id: StorageBindingId;
  backend_id: string;
  export_id: string;
  canonical_directory: string;
  epoch: StorageEpoch;
  revision: RowRevision<"storage-binding">;
  identity_proof_ref: string | null;
};
export type AttemptRow = {
  id: AttemptId;
  runtime_unit_id: RuntimeUnitId;
  execution_epoch: ExecutionEpoch;
  pod_uid: string | null;
  resource_profile_revision: ProfileRevision;
  mode: "COLD" | "RESTORE";
};

// Upload UUID is reserved by the authenticated server; this additive projection
// does not change the common identity constructor or public RPC ID contract.
export type AttachmentUploadRow = {
  id: string;
  principal_id: string;
  target_connection_id: string | null;
  expected_base64_length: string;
  received_base64_length: string;
  state: "OPEN" | "COMMITTED" | "ABORTED";
  revision: RowRevision<"attachment-upload">;
  created_at: Date;
  updated_at: Date;
};
export type AttachmentBlobRow = {
  content_hash: string;
  content_bytes: Uint8Array;
  byte_length: string;
  media_type: string;
  created_at: Date;
};
export type AttachmentUploadChunkRow = {
  upload_id: string;
  chunk_offset: string;
  content_base64: string;
  content_hash: string;
  char_length: string;
};
export type AttachmentAliasRow = {
  alias_path: string;
  upload_id: string;
  principal_id: string;
  content_hash: string;
  created_at: Date;
};

export type RuntimeCommandRow = {
  id: string;
  operation_id: OperationId;
  runtime_unit_id: RuntimeUnitId;
  command_name: string;
  original_controller_term: ControllerTerm;
  step_revision: StepRevision;
  pod_target: "CREATE_WITHOUT_POD" | "EXISTING_POD";
  expected_pod_uid: string | null;
  execution_epoch: ExecutionEpoch;
  intent_revision: IntentRevision;
  input_hash: string;
  input: unknown;
  state: "ACCEPTED" | "EXECUTING" | "UNKNOWN" | "RESOLVED" | "REFUSED";
  owner_controller_term: ControllerTerm;
  executor_id: string | null;
  execution_token: string | null;
  revision: RowRevision<"runtime-command">;
  accepted_at: Date;
  claimed_at: Date | null;
  settled_at: Date | null;
  result: unknown | null;
  refusal_code: string | null;
  evidence_refs: readonly string[];
};
export type RuntimeCommandHistoryRow = {
  id: string;
  command_id: string;
  stage: string;
  controller_term: ControllerTerm;
  executor_id: string | null;
  execution_token: string | null;
  occurred_at: Date;
  evidence_refs: readonly string[];
};

export type RuntimeEventProducerRow = {
  producer_id: string;
  incarnation: string;
  agent_id: AgentId;
  runtime_unit_id: RuntimeUnitId;
  attempt_id: AttemptId;
  pod_uid: string;
  execution_epoch: ExecutionEpoch;
  committed_through: Sequence<"producer-committed">;
  processed_through: Sequence<"producer-processed">;
  revision: RowRevision<"event-producer">;
  created_at: Date;
};
export type RuntimeEventQueueRow = {
  event_id: string;
  producer_id: string;
  incarnation: string;
  producer_seq: Sequence<"producer">;
  agent_id: AgentId;
  payload: unknown;
  committed_at: Date;
  processed_at: Date | null;
  state: "PENDING" | "PROCESSING" | "RETRY" | "DONE" | "FAILED";
  attempt_count: string;
  retry_count: string;
  next_retry_at: Date | null;
  last_error: string | null;
  terminal_at: Date | null;
  claim_owner: string | null;
  claim_controller_term: ControllerTerm | null;
  claim_token: string | null;
  claim_expires_at: Date | null;
  enqueue_transaction_id: string | null;
};

export type ProviderContextDeliveryRow = {
  id: LogicalId<"provider-context-delivery">;
  session_id: SessionId;
  context_revision: ContextRevision;
  context_hash: string;
  provider_binding_revision: string;
  runtime_unit_id: RuntimeUnitId;
  attempt_id: AttemptId;
  pod_uid: string;
  execution_epoch: ExecutionEpoch;
  provider: string;
  native_session_ref: string;
  native_turn_id: string | null;
  evidence_ref: string;
  source: string;
  observed_at: Date;
};

export type CatalogHeadRow = {
  scope: string;
  dataset_name: "orca-1012-dev-v1";
  publication_epoch: string;
  revision: RowRevision<"catalog-head">;
};
export type CatalogProjectGroupRow = {
  id: string;
  payload: Record<string, unknown>;
  revision: RowRevision<"catalog-project-group">;
  deleted_at: Date | null;
};
export type CatalogRepositoryRow = {
  id: string;
  project_group_id: string | null;
  payload: Record<string, unknown>;
  revision: RowRevision<"catalog-repository">;
  deleted_at: Date | null;
};
export type CatalogWorkspaceMetadataRow = {
  workspace_id: WorkspaceId;
  kind: "GIT" | "REPO_FOLDER" | "FOLDER_WORKSPACE";
  repo_id: string | null;
  project_group_id: string | null;
  reserved_path: string;
  payload: Record<string, unknown>;
  create_request: Record<string, unknown>;
  runtime_unit_id: RuntimeUnitId | null;
  provisioning_operation_id: OperationId | null;
  created_at: Date;
  updated_at: Date;
};
export type CatalogTabMetadataRow = {
  tab_id: LogicalId<"tab">;
  public_tab_id: string;
  payload: Record<string, unknown>;
  launch_request: Record<string, unknown>;
  launch_token: string | null;
  binding_revision: RowRevision<"catalog-tab-binding">;
  updated_at: Date;
};
export type CatalogUiStateRow = {
  scope: "host";
  payload: Record<string, unknown>;
  revision: RowRevision<"catalog-ui">;
};
export type CatalogNameReservationRow = {
  namespace: string;
  normalized_name: string;
  workspace_id: WorkspaceId;
  generated: boolean;
  retired: boolean;
};
