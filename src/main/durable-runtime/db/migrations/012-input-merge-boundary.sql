SET LOCAL search_path = durable_runtime, pg_catalog;
ALTER TABLE messages ADD COLUMN input_kind text NOT NULL DEFAULT 'GENERAL';
ALTER TABLE messages ADD COLUMN merge_closed boolean NOT NULL DEFAULT false;
UPDATE messages SET merge_closed=true WHERE sealed_revision IS NOT NULL;
ALTER TABLE messages ADD CHECK(input_kind IN ('GENERAL','COMMAND','QUESTION_RESPONSE','APPROVAL_RESPONSE'));
ALTER TABLE messages ADD CHECK(input_kind='GENERAL' OR merge_closed);
ALTER TABLE messages ADD CHECK(sealed_revision IS NULL OR merge_closed);
CREATE FUNCTION guard_message_merge_boundary() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.input_kind<>'GENERAL' OR NEW.sealed_revision IS NOT NULL THEN
      NEW.merge_closed:=true;
    END IF;
  ELSIF NEW.input_kind IS DISTINCT FROM OLD.input_kind
     OR (OLD.merge_closed AND NOT NEW.merge_closed)
     OR NEW.revision<OLD.revision THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Message kind boundary and revision cannot regress';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER message_merge_boundary_guard BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION guard_message_merge_boundary();
