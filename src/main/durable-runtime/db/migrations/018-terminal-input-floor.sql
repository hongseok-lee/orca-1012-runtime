SET LOCAL search_path = durable_runtime, pg_catalog;

ALTER TABLE tabs ADD UNIQUE(terminal_handle,session_id);

CREATE TABLE terminal_input_floors (
  terminal_handle text PRIMARY KEY CHECK(terminal_handle<>''),
  session_id uuid NOT NULL,
  floor_generation bigint NOT NULL CHECK(floor_generation>=0),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  principal_id text NOT NULL CHECK(principal_id<>''),
  paired_device_id text NOT NULL CHECK(paired_device_id<>''),
  connection_id text NOT NULL CHECK(connection_id<>''),
  mode text NOT NULL CHECK(mode IN ('AGENT_CHAT_COMPAT','RAW_TERMINAL')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(terminal_handle,session_id) REFERENCES tabs(terminal_handle,session_id)
);

CREATE FUNCTION guard_terminal_input_floor() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.terminal_handle,NEW.session_id) IS DISTINCT FROM (OLD.terminal_handle,OLD.session_id)
     OR NEW.floor_generation<OLD.floor_generation OR NEW.revision<OLD.revision THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Terminal floor original handle and Session are immutable; generation and revision cannot decrease';
  END IF;
  IF (NEW.principal_id,NEW.paired_device_id,NEW.mode)
       IS DISTINCT FROM (OLD.principal_id,OLD.paired_device_id,OLD.mode)
     AND NEW.floor_generation<=OLD.floor_generation THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Terminal floor owner, device or mode transition requires a new generation';
  END IF;
  IF NEW.connection_id IS DISTINCT FROM OLD.connection_id
     AND NEW.floor_generation=OLD.floor_generation AND NEW.revision<=OLD.revision THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Same-floor connection reattach requires an advancing revision';
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER terminal_input_floor_guard BEFORE UPDATE ON terminal_input_floors
  FOR EACH ROW EXECUTE FUNCTION guard_terminal_input_floor();
CREATE TRIGGER retain_terminal_input_floor BEFORE DELETE ON terminal_input_floors
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

-- legacy_drafts remains the original draft store, including unsupported history.
-- Reattach writes only the floor binding; it never clears/copies draft contents.
