SET LOCAL search_path = durable_runtime, pg_catalog;

CREATE TABLE structured_session_aliases (
  public_session_id text PRIMARY KEY
    CHECK(public_session_id COLLATE "C" ~ '^[A-Za-z0-9_-]{8,128}$'),
  session_id uuid NOT NULL UNIQUE,
  workspace_id uuid NOT NULL,
  provider text NOT NULL CHECK(provider IN ('claude','codex')),
  execution_host_id text NOT NULL CHECK(execution_host_id<>''),
  location jsonb NOT NULL CHECK(jsonb_typeof(location)='object'),
  original_create jsonb NOT NULL CHECK(jsonb_typeof(original_create)='object'),
  created_by text NOT NULL CHECK(created_by<>''),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(session_id,workspace_id) REFERENCES sessions(id,workspace_id)
);

CREATE TABLE structured_submissions (
  input_id uuid PRIMARY KEY,
  message_id uuid NOT NULL,
  session_id uuid NOT NULL,
  principal_id text NOT NULL CHECK(principal_id<>''),
  client_message_id text NOT NULL CHECK(client_message_id<>''),
  wire_payload_fingerprint text NOT NULL CHECK(wire_payload_fingerprint ~ '^[0-9a-f]{64}$'),
  wire_fence bigint NOT NULL CHECK(wire_fence>0),
  journal_epoch bigint NOT NULL CHECK(journal_epoch>=0),
  journal_sequence bigint NOT NULL CHECK(journal_sequence>0),
  submitted_at timestamptz NOT NULL,
  FOREIGN KEY(input_id,message_id,session_id) REFERENCES input_components(id,message_id,session_id),
  FOREIGN KEY(session_id,journal_epoch,journal_sequence) REFERENCES session_events(session_id,journal_epoch,seq),
  UNIQUE(session_id,principal_id,client_message_id)
);

CREATE TRIGGER keep_structured_session_alias BEFORE UPDATE OR DELETE ON structured_session_aliases
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER keep_structured_submission BEFORE UPDATE OR DELETE ON structured_submissions
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
