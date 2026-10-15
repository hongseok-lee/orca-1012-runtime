SET LOCAL search_path = durable_runtime, pg_catalog;

-- Additional associations retain the original Session -> Unit and primary binding.
CREATE TABLE runtime_member_storage_bindings (
  runtime_unit_id uuid NOT NULL,
  session_id uuid NOT NULL,
  storage_binding_id uuid NOT NULL REFERENCES storage_bindings(id),
  PRIMARY KEY(runtime_unit_id,session_id,storage_binding_id),
  FOREIGN KEY(session_id,runtime_unit_id) REFERENCES runtime_members(session_id,runtime_unit_id)
);
INSERT INTO runtime_member_storage_bindings(runtime_unit_id,session_id,storage_binding_id)
  SELECT runtime_unit_id,session_id,storage_binding_id FROM runtime_members;

CREATE FUNCTION record_primary_runtime_member_storage_binding() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  INSERT INTO runtime_member_storage_bindings(runtime_unit_id,session_id,storage_binding_id)
    VALUES(NEW.runtime_unit_id,NEW.session_id,NEW.storage_binding_id);
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_member_primary_storage_binding AFTER INSERT ON runtime_members
  FOR EACH ROW EXECUTE FUNCTION record_primary_runtime_member_storage_binding();
CREATE TRIGGER retain_runtime_member_storage_bindings BEFORE UPDATE OR DELETE ON runtime_member_storage_bindings
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION keep_runtime_member_primary_storage_binding() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF NEW.storage_binding_id IS DISTINCT FROM OLD.storage_binding_id THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Primary storage binding is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_member_primary_storage_binding_guard BEFORE UPDATE OF storage_binding_id ON runtime_members
  FOR EACH ROW EXECUTE FUNCTION keep_runtime_member_primary_storage_binding();

-- Preserve 007's domain write gate, post-gate epoch read, immutable grants and
-- parent/child conflict checks; membership now includes every attached binding.
CREATE OR REPLACE FUNCTION guard_storage_writer() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
DECLARE binding storage_bindings%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.id,NEW.storage_binding_id,NEW.attempt_id,NEW.storage_epoch) IS DISTINCT FROM (OLD.id,OLD.storage_binding_id,OLD.attempt_id,OLD.storage_epoch) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Storage grant identity is immutable';
  END IF;
  IF TG_OP='UPDATE' AND OLD.state='REVOKED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Revoked storage grant cannot be revived';
  END IF;
  SELECT * INTO STRICT binding FROM storage_bindings WHERE id=NEW.storage_binding_id;
  UPDATE storage_domains SET lock_revision=lock_revision+1 WHERE backend_id=binding.backend_id AND export_id=binding.export_id;
  -- Epoch/proof are read after the domain gate; canonical identity itself is immutable.
  SELECT * INTO STRICT binding FROM storage_bindings WHERE id=NEW.storage_binding_id;
  IF NEW.state IN ('RESERVED','ACTIVE','REVOKING') THEN
    IF binding.identity_verified_at IS NULL OR binding.epoch<>NEW.storage_epoch THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Verified current storage identity required';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM attempts a JOIN runtime_member_storage_bindings m ON m.runtime_unit_id=a.runtime_unit_id WHERE a.id=NEW.attempt_id AND m.storage_binding_id=NEW.storage_binding_id) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Storage writer is not a runtime member';
    END IF;
    IF EXISTS (
      SELECT 1 FROM storage_write_grants g JOIN storage_bindings b ON b.id=g.storage_binding_id
      WHERE g.id<>NEW.id AND g.state IN ('RESERVED','ACTIVE','REVOKING')
      AND b.backend_id=binding.backend_id AND b.export_id=binding.export_id
      AND (b.canonical_directory=binding.canonical_directory OR b.canonical_directory='/' OR binding.canonical_directory='/'
        OR left(b.canonical_directory,length(binding.canonical_directory)+1)=binding.canonical_directory||'/'
        OR left(binding.canonical_directory,length(b.canonical_directory)+1)=b.canonical_directory||'/')
    ) THEN
      RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Overlapping storage writer';
    END IF;
  END IF;
  RETURN NEW;
END $$;
