SET LOCAL search_path = durable_runtime, pg_catalog;
ALTER TABLE rpc_receipts ADD COLUMN intake_at timestamptz;
-- A transactional row timestamp is not a measured WAL flush/COMMIT instant.
ALTER TABLE outbox_events ADD COLUMN created_at timestamptz;
ALTER TABLE outbox_events ADD COLUMN state text NOT NULL DEFAULT 'PENDING';
ALTER TABLE outbox_events ADD COLUMN claim_owner text;
ALTER TABLE outbox_events ADD COLUMN claim_token uuid;
ALTER TABLE outbox_events ADD COLUMN claim_expires_at timestamptz;
ALTER TABLE outbox_events ADD COLUMN attempt_count bigint NOT NULL DEFAULT 0;
ALTER TABLE outbox_events ADD COLUMN last_error_code text;
ALTER TABLE outbox_events ADD COLUMN last_attempt_at timestamptz;
UPDATE outbox_events SET state='PUBLISHED' WHERE published_at IS NOT NULL;
ALTER TABLE outbox_events ADD CHECK(state IN ('PENDING','CLAIMED','PUBLISHED'));
ALTER TABLE outbox_events ADD CHECK(attempt_count>=0);
ALTER TABLE outbox_events ADD CHECK((state='PUBLISHED')=(published_at IS NOT NULL));
ALTER TABLE outbox_events ADD CHECK(
  (state='CLAIMED' AND nullif(claim_owner,'') IS NOT NULL AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
  OR (state<>'CLAIMED' AND claim_owner IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL));
CREATE INDEX outbox_unpublished ON outbox_events(state,claim_expires_at) WHERE state<>'PUBLISHED';
CREATE FUNCTION keep_original_outbox() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.id,NEW.aggregate_id,NEW.aggregate_kind,NEW.revision,NEW.event,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.aggregate_id,OLD.aggregate_kind,OLD.revision,OLD.event,OLD.created_at)
    OR NEW.attempt_count<OLD.attempt_count OR (OLD.state='PUBLISHED' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Original or published outbox event is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER keep_outbox_event BEFORE UPDATE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION keep_original_outbox();
CREATE TRIGGER retain_outbox_event BEFORE DELETE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
