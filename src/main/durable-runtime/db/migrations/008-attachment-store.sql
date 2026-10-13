SET LOCAL search_path = durable_runtime, pg_catalog;

CREATE TABLE attachment_blobs (
  content_hash text PRIMARY KEY CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  content_bytes bytea NOT NULL,
  byte_length bigint NOT NULL CHECK(byte_length>=0 AND byte_length=octet_length(content_bytes)),
  media_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(content_hash=encode(sha256(content_bytes),'hex'))
);
CREATE TRIGGER keep_attachment_blob BEFORE UPDATE OR DELETE ON attachment_blobs
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE attachment_uploads (
  id uuid PRIMARY KEY,
  principal_id text NOT NULL CHECK(principal_id<>''),
  target_connection_id text,
  expected_base64_length bigint NOT NULL CHECK(expected_base64_length>=0),
  received_base64_length bigint NOT NULL DEFAULT 0 CHECK(received_base64_length>=0),
  state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','COMMITTED','ABORTED')),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,principal_id),
  CHECK(received_base64_length<=expected_base64_length),
  CHECK(state<>'COMMITTED' OR received_base64_length=expected_base64_length)
);
CREATE FUNCTION keep_attachment_upload_identity() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.id,NEW.principal_id,NEW.target_connection_id,NEW.expected_base64_length,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.principal_id,OLD.target_connection_id,OLD.expected_base64_length,OLD.created_at)
     OR NEW.received_base64_length<OLD.received_base64_length OR NEW.revision<OLD.revision
     OR (OLD.state<>'OPEN' AND (NEW.state,NEW.received_base64_length) IS DISTINCT FROM (OLD.state,OLD.received_base64_length)) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Upload identity or terminal state is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER keep_attachment_upload BEFORE UPDATE ON attachment_uploads
  FOR EACH ROW EXECUTE FUNCTION keep_attachment_upload_identity();
CREATE TRIGGER retain_attachment_upload BEFORE DELETE ON attachment_uploads
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE attachment_upload_chunks (
  upload_id uuid NOT NULL REFERENCES attachment_uploads,
  chunk_offset bigint NOT NULL CHECK(chunk_offset>=0),
  content_base64 text NOT NULL,
  content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  char_length bigint NOT NULL CHECK(char_length>0 AND char_length=length(content_base64)),
  PRIMARY KEY(upload_id,chunk_offset),
  -- Chunk identity hashes the exact retained UTF-8 wire text, not decoded blob bytes.
  CHECK(content_hash=encode(sha256(convert_to(content_base64,'UTF8')),'hex'))
);
CREATE FUNCTION guard_attachment_chunk_insert() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
DECLARE upload_state text;
BEGIN
  SELECT state INTO upload_state FROM durable_runtime.attachment_uploads WHERE id=NEW.upload_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='Upload missing';
  END IF;
  IF upload_state<>'OPEN' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Upload is terminal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attachment_chunk_open BEFORE INSERT ON attachment_upload_chunks
  FOR EACH ROW EXECUTE FUNCTION guard_attachment_chunk_insert();
CREATE TRIGGER keep_attachment_chunk BEFORE UPDATE OR DELETE ON attachment_upload_chunks
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE attachment_aliases (
  alias_path text PRIMARY KEY CHECK(alias_path LIKE '/%' AND alias_path !~ '(^|/)\.\.?(/|$)' AND alias_path NOT LIKE '%//%'),
  upload_id uuid NOT NULL UNIQUE,
  principal_id text NOT NULL,
  content_hash text NOT NULL REFERENCES attachment_blobs,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(upload_id,principal_id) REFERENCES attachment_uploads(id,principal_id),
  UNIQUE(alias_path,content_hash)
);
CREATE FUNCTION lock_attachment_alias_upload() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  PERFORM id FROM durable_runtime.attachment_uploads WHERE id=NEW.upload_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='Upload missing';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attachment_alias_upload_lock BEFORE INSERT ON attachment_aliases
  FOR EACH ROW EXECUTE FUNCTION lock_attachment_alias_upload();
CREATE TRIGGER keep_attachment_alias BEFORE UPDATE OR DELETE ON attachment_aliases
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION check_attachment_commit_relation() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
DECLARE upload_key uuid; upload_state text; alias_count bigint;
BEGIN
  IF TG_TABLE_NAME='attachment_uploads' THEN upload_key:=NEW.id;
  ELSE upload_key:=NEW.upload_id; END IF;
  SELECT state INTO upload_state FROM durable_runtime.attachment_uploads WHERE id=upload_key;
  SELECT count(*) INTO alias_count FROM durable_runtime.attachment_aliases WHERE upload_id=upload_key;
  IF (upload_state='COMMITTED' AND alias_count<>1) OR (upload_state<>'COMMITTED' AND alias_count<>0) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Upload commit and alias must agree';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER attachment_upload_commit_relation AFTER INSERT OR UPDATE ON attachment_uploads
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_attachment_commit_relation();
CREATE CONSTRAINT TRIGGER attachment_alias_commit_relation AFTER INSERT ON attachment_aliases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_attachment_commit_relation();

ALTER TABLE input_attachments ADD CONSTRAINT input_attachment_alias_blob_fk
  FOREIGN KEY(blob_ref,content_hash) REFERENCES attachment_aliases(alias_path,content_hash);
