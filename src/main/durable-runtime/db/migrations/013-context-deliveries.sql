SET LOCAL search_path = durable_runtime, pg_catalog;
CREATE TABLE provider_context_deliveries (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions,
  context_revision bigint NOT NULL CHECK(context_revision>=0),
  context_hash text NOT NULL CHECK(context_hash ~ '^[0-9a-f]{64}$'),
  provider_binding_revision bigint NOT NULL CHECK(provider_binding_revision>=0),
  runtime_unit_id uuid NOT NULL REFERENCES runtime_units,
  attempt_id uuid NOT NULL,
  pod_uid text NOT NULL CHECK(pod_uid<>''),
  execution_epoch bigint NOT NULL CHECK(execution_epoch>=0),
  provider text NOT NULL CHECK(provider<>''),
  native_session_ref text NOT NULL CHECK(native_session_ref<>''),
  native_turn_id text CHECK(native_turn_id IS NULL OR native_turn_id<>''),
  evidence_ref text NOT NULL CHECK(evidence_ref<>''),
  source text NOT NULL CHECK(source<>''),
  observed_at timestamptz NOT NULL,
  FOREIGN KEY(attempt_id,runtime_unit_id,execution_epoch,pod_uid)
    REFERENCES attempts(id,runtime_unit_id,execution_epoch,pod_uid),
  UNIQUE(session_id,provider_binding_revision,attempt_id,context_revision,context_hash,evidence_ref)
);
CREATE TRIGGER keep_provider_context_delivery BEFORE UPDATE OR DELETE ON provider_context_deliveries
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER keep_session_context_original BEFORE UPDATE OR DELETE ON session_context_records
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION guard_session_context_revision() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF NEW.context_revision<OLD.context_revision THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Session context revision cannot decrease';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_context_revision_guard BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION guard_session_context_revision();
