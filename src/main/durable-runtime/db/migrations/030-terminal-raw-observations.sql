SET LOCAL search_path = durable_runtime, pg_catalog;

-- Evidence, never a queue: REQUESTED/UNKNOWN rows are not dispatchable after
-- restart. Retain the original scope even if a logical handle gets a new PTY.
CREATE TABLE terminal_raw_observations (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id),
  terminal_handle text NOT NULL,
  principal_id text NOT NULL,
  connection_id text NOT NULL,
  request_key text NOT NULL,
  attempt_id uuid NOT NULL REFERENCES attempts(id),
  pty_incarnation_id uuid NOT NULL,
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK(state IN ('REQUESTED','WRITTEN','UNKNOWN','REJECTED')),
  bytes_written integer NOT NULL DEFAULT 0 CHECK(bytes_written>=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  UNIQUE(terminal_handle,principal_id,connection_id,request_key),
  CHECK((state='REQUESTED')=(settled_at IS NULL)),
  CHECK(state='WRITTEN' OR bytes_written=0)
);
CREATE FUNCTION retain_terminal_raw_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.session_id,NEW.terminal_handle,NEW.principal_id,NEW.connection_id,NEW.request_key,
    NEW.attempt_id,NEW.pty_incarnation_id,NEW.payload_hash,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.session_id,OLD.terminal_handle,OLD.principal_id,OLD.connection_id,OLD.request_key,
    OLD.attempt_id,OLD.pty_incarnation_id,OLD.payload_hash,OLD.created_at)
    OR OLD.state<>'REQUESTED' OR NEW.state='REQUESTED' THEN
    RAISE EXCEPTION 'immutable terminal raw observation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER terminal_raw_observation_guard BEFORE UPDATE ON terminal_raw_observations
  FOR EACH ROW EXECUTE FUNCTION retain_terminal_raw_observation();
CREATE TRIGGER retain_terminal_raw_observations BEFORE DELETE ON terminal_raw_observations
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
