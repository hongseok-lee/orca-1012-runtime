SET LOCAL search_path = durable_runtime, pg_catalog;
ALTER TABLE operations ADD COLUMN cancel_intent_id uuid UNIQUE REFERENCES cancel_intents(operation_id),
  ADD CHECK(cancel_intent_id IS NULL OR kind='INPUT_CANCEL');
CREATE FUNCTION retain_cancel_operation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cancel_intent_id IS DISTINCT FROM OLD.cancel_intent_id THEN
    RAISE EXCEPTION 'immutable cancel operation identity';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cancel_operation_identity_guard BEFORE UPDATE ON operations
  FOR EACH ROW EXECUTE FUNCTION retain_cancel_operation_identity();
