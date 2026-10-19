SET LOCAL search_path = durable_runtime, pg_catalog;
-- ACK/resume use this same all-frame prefix, not the sparse notification sequence.
CREATE TABLE agent_control_cursors (
  control_id uuid PRIMARY KEY, pod_uid text NOT NULL, last_seq bigint NOT NULL DEFAULT 0 CHECK(last_seq>=0)
);
CREATE TABLE agent_control_frames (
  control_id uuid NOT NULL REFERENCES agent_control_cursors, seq bigint NOT NULL CHECK(seq>0),
  body jsonb NOT NULL, PRIMARY KEY(control_id,seq)
);
CREATE TRIGGER retain_agent_control_frames BEFORE UPDATE OR DELETE ON agent_control_frames
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE agent_control_resyncs (
  control_id uuid NOT NULL REFERENCES agent_control_cursors, through_seq bigint NOT NULL CHECK(through_seq>0),
  missing_kind text NOT NULL CHECK(missing_kind='UNKNOWN'), snapshot jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(control_id,through_seq)
);
CREATE TRIGGER retain_agent_control_resyncs BEFORE UPDATE OR DELETE ON agent_control_resyncs
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
