import type {
  AgentId, AttemptId, ControllerTerm, ExecutionEpoch, IntentRevision, MessageId,
  MessageRevision, OperationId, ProfileRevision, RowRevision, RuntimeUnitId,
  Sequence, SessionFence, SessionId, StepRevision, StorageBindingId, StorageEpoch, WorkspaceId
} from '../../../shared/durable-runtime/identity.ts'

export interface SessionRow {
  id: SessionId; agent_id: AgentId; workspace_id: WorkspaceId; session_fence: SessionFence;
  lifecycle: 'OPEN'|'CLOSING'|'CLOSED'; revision: RowRevision<'session'>;
  next_input_seq: Sequence<'input'>; next_message_seq: Sequence<'message'>; next_event_seq: Sequence<'journal'>
}
export interface RuntimeUnitRow {
  id: RuntimeUnitId; intent_revision: IntentRevision; execution_epoch: ExecutionEpoch;
  active_attempt_id: AttemptId|null; revision: RowRevision<'runtime-unit'>;
  desired_mode: 'RUNNING'|'SUSPENDED'|'DELETED'; phase: string
}
export interface OperationRow {
  id: OperationId; runtime_unit_id: RuntimeUnitId; intent_revision: IntentRevision;
  execution_epoch: ExecutionEpoch; controller_term: ControllerTerm;
  step_revision: StepRevision; revision: RowRevision<'operation'>; step: string
}
export interface MessageRow {
  id: MessageId; session_id: SessionId; seq: Sequence<'message'>; revision: MessageRevision;
  sealed_revision: MessageRevision|null; sealed_payload_hash: string|null; intake_status: string
}
export interface StorageBindingRow {
  id: StorageBindingId; backend_id: string; export_id: string; canonical_directory: string;
  epoch: StorageEpoch; revision: RowRevision<'storage-binding'>; identity_proof_ref: string|null
}
export interface AttemptRow {
  id: AttemptId; runtime_unit_id: RuntimeUnitId; execution_epoch: ExecutionEpoch;
  pod_uid: string|null; resource_profile_revision: ProfileRevision; mode: 'COLD'|'RESTORE'
}
