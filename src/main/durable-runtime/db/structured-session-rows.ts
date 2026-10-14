import type {
  InputId, MessageId, SessionFence, SessionId, Sequence, WorkspaceId,
} from "../../../shared/durable-runtime/identity.ts";
import type { EvidenceJson } from "../resources/evidence/types.ts";

export type StructuredSessionAliasRow = {
  // Public wire IDs follow isAgentSessionId; they are not internal UUIDs.
  public_session_id: string;
  session_id: SessionId;
  workspace_id: WorkspaceId;
  provider: "claude" | "codex";
  execution_host_id: string;
  location: Readonly<Record<string, EvidenceJson>>;
  original_create: Readonly<Record<string, EvidenceJson>>;
  created_by: string;
  created_at: Date;
};

export type StructuredSubmissionRow = {
  input_id: InputId;
  message_id: MessageId;
  session_id: SessionId;
  principal_id: string;
  client_message_id: string;
  wire_payload_fingerprint: string;
  wire_fence: SessionFence;
  // The existing journal store returns its BIGINT epoch as a decimal string.
  journal_epoch: string;
  journal_sequence: Sequence<"journal">;
  submitted_at: Date;
};
