SET LOCAL search_path = durable_runtime, pg_catalog;

-- The Pod-local control host that an attempt's provider runs under, recorded
-- in the same transaction that settles READY. A later backend process may
-- re-attach to exactly this control process (same pid, start ticks and
-- protected root inode); the row never authorizes a new process or writer.
CREATE TABLE agent_control_hosts (
  attempt_id uuid PRIMARY KEY REFERENCES attempts(id),
  runtime_unit_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES sessions(id),
  provider text NOT NULL CHECK (provider IN ('codex','claude')),
  pod_uid text NOT NULL CHECK (pod_uid <> ''),
  control_id uuid NOT NULL UNIQUE,
  control_pid integer NOT NULL CHECK (control_pid > 0),
  control_start_ticks text NOT NULL CHECK (control_start_ticks ~ '^[1-9][0-9]*$'),
  root_device text NOT NULL CHECK (root_device ~ '^[0-9]+$'),
  root_inode text NOT NULL CHECK (root_inode ~ '^[1-9][0-9]*$'),
  connection_instance_id text NOT NULL CHECK (connection_instance_id <> ''),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at))
);
CREATE TRIGGER retain_agent_control_hosts BEFORE UPDATE OR DELETE ON agent_control_hosts
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
