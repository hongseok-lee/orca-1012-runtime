SET LOCAL search_path = durable_runtime, pg_catalog;
ALTER TABLE attempts ADD CONSTRAINT attempt_producer_binding_unique UNIQUE(id,runtime_unit_id,execution_epoch,pod_uid);
CREATE TABLE runtime_event_producers (
  producer_id uuid NOT NULL,
  incarnation text NOT NULL CHECK(incarnation<>''),
  agent_id uuid NOT NULL REFERENCES agents,
  runtime_unit_id uuid NOT NULL REFERENCES runtime_units,
  attempt_id uuid NOT NULL,
  pod_uid text NOT NULL CHECK(pod_uid<>''),
  execution_epoch bigint NOT NULL CHECK(execution_epoch>=0),
  committed_through bigint NOT NULL DEFAULT 0 CHECK(committed_through>=0),
  processed_through bigint NOT NULL DEFAULT 0 CHECK(processed_through>=0),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(producer_id,incarnation),
  UNIQUE(producer_id,incarnation,agent_id),
  FOREIGN KEY(attempt_id,runtime_unit_id,execution_epoch,pod_uid)
    REFERENCES attempts(id,runtime_unit_id,execution_epoch,pod_uid),
  CHECK(processed_through<=committed_through)
);
CREATE FUNCTION keep_runtime_event_producer() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM durable_runtime.runtime_members m JOIN durable_runtime.sessions s ON s.id=m.session_id
       WHERE m.runtime_unit_id=NEW.runtime_unit_id AND s.agent_id=NEW.agent_id) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Producer Agent must belong to the Runtime Unit';
    END IF;
  ELSIF (NEW.producer_id,NEW.incarnation,NEW.agent_id,NEW.runtime_unit_id,NEW.attempt_id,NEW.pod_uid,NEW.execution_epoch,NEW.created_at)
     IS DISTINCT FROM (OLD.producer_id,OLD.incarnation,OLD.agent_id,OLD.runtime_unit_id,OLD.attempt_id,OLD.pod_uid,OLD.execution_epoch,OLD.created_at)
     OR NEW.committed_through<OLD.committed_through OR NEW.processed_through<OLD.processed_through OR NEW.revision<OLD.revision THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Producer original binding or watermark cannot regress';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_event_producer_guard BEFORE INSERT OR UPDATE ON runtime_event_producers
  FOR EACH ROW EXECUTE FUNCTION keep_runtime_event_producer();
CREATE TRIGGER retain_runtime_event_producer BEFORE DELETE ON runtime_event_producers
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
ALTER TABLE runtime_event_queue ADD CONSTRAINT queue_producer_pair_fk
  FOREIGN KEY(producer_id,incarnation) REFERENCES runtime_event_producers;
ALTER TABLE runtime_event_queue ADD CONSTRAINT queue_producer_agent_fk
  FOREIGN KEY(producer_id,incarnation,agent_id) REFERENCES runtime_event_producers(producer_id,incarnation,agent_id);
ALTER TABLE runtime_event_queue ADD COLUMN claim_owner text;
ALTER TABLE runtime_event_queue ADD COLUMN claim_controller_term bigint;
ALTER TABLE runtime_event_queue ADD COLUMN claim_token uuid;
ALTER TABLE runtime_event_queue ADD COLUMN claim_expires_at timestamptz;
-- Existing records remain unknown, not stamped with a fabricated historical XID.
ALTER TABLE runtime_event_queue ADD COLUMN enqueue_transaction_id xid8;
ALTER TABLE runtime_event_queue ADD CHECK(
  (state='PROCESSING' AND nullif(claim_owner,'') IS NOT NULL AND claim_controller_term>=0
    AND claim_controller_term IS NOT NULL AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
  OR (state<>'PROCESSING' AND claim_owner IS NULL AND claim_controller_term IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL));
CREATE FUNCTION guard_runtime_event_claim_history() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN NEW.enqueue_transaction_id:=pg_current_xact_id();
  ELSIF NEW.enqueue_transaction_id IS DISTINCT FROM OLD.enqueue_transaction_id
     OR NEW.attempt_count<OLD.attempt_count OR NEW.retry_count<OLD.retry_count THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Queue original transaction and attempt budget are retained';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_event_claim_history_guard BEFORE INSERT OR UPDATE ON runtime_event_queue
  FOR EACH ROW EXECUTE FUNCTION guard_runtime_event_claim_history();
CREATE FUNCTION guard_runtime_event_target_registration() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
DECLARE enqueue_xid xid8;
BEGIN
  SELECT enqueue_transaction_id INTO enqueue_xid FROM durable_runtime.runtime_event_queue WHERE event_id=NEW.event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='Queue event missing';
  END IF;
  IF enqueue_xid IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Targets must be registered in original enqueue transaction';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_event_target_registration BEFORE INSERT ON runtime_event_targets
  FOR EACH ROW EXECUTE FUNCTION guard_runtime_event_target_registration();
