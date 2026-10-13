import type {
  AgentId,
  AttemptId,
  ControllerTerm,
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
export type MessageRow = {
  id: MessageId;
  session_id: SessionId;
  seq: Sequence<"message">;
  revision: MessageRevision;
  sealed_revision: MessageRevision | null;
  sealed_payload_hash: string | null;
  intake_status: string;
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
