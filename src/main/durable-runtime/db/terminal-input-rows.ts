import type {
  Counter, RowRevision, SessionId,
} from "../../../shared/durable-runtime/identity.ts";
import type { EvidenceJson } from "../resources/evidence/types.ts";

export type TerminalInputFloorRow = {
  terminal_handle: string;
  session_id: SessionId;
  floor_generation: Counter<"terminal-floor-generation">;
  revision: RowRevision<"terminal-input-floor">;
  principal_id: string;
  paired_device_id: string;
  connection_id: string;
  mode: "AGENT_CHAT_COMPAT" | "RAW_TERMINAL";
  updated_at: Date;
};

// Projection of existing 004 history; the new draft codec is consumer-owned.
export type LegacyDraftRow = {
  terminal_handle: string;
  paired_device_id: string;
  floor_generation: Counter<"terminal-floor-generation">;
  draft_revision: RowRevision<"legacy-draft">;
  body: EvidenceJson;
  attachments: EvidenceJson;
  lifecycle: string;
  updated_at: Date;
};
