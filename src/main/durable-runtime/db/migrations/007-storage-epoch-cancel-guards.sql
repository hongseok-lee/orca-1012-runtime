SET LOCAL search_path = durable_runtime, pg_catalog;
ALTER TABLE runtime_audit_events ADD CONSTRAINT audit_runtime_unit_fk FOREIGN KEY(runtime_unit_id) REFERENCES runtime_units(id);
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
    IF NOT EXISTS(SELECT 1 FROM attempts a JOIN runtime_members m ON m.runtime_unit_id=a.runtime_unit_id WHERE a.id=NEW.attempt_id AND m.storage_binding_id=NEW.storage_binding_id) THEN
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
CREATE OR REPLACE FUNCTION keep_storage_identity() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.id,NEW.backend_id,NEW.export_id,NEW.canonical_directory) IS DISTINCT FROM (OLD.id,OLD.backend_id,OLD.export_id,OLD.canonical_directory) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Canonical storage domain identity is immutable';
  END IF;
  UPDATE storage_domains SET lock_revision=lock_revision+1 WHERE backend_id=OLD.backend_id AND export_id=OLD.export_id;
  IF NEW.epoch<OLD.epoch OR (NEW.epoch<>OLD.epoch AND EXISTS(SELECT 1 FROM storage_write_grants WHERE storage_binding_id=OLD.id AND state IN ('RESERVED','ACTIVE','REVOKING'))) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Old storage grant must be revoked with proof';
  END IF;
  IF NEW.identity_verified_at IS NULL AND EXISTS(SELECT 1 FROM storage_write_grants WHERE storage_binding_id=OLD.id AND state IN ('RESERVED','ACTIVE','REVOKING')) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Held writer requires verified identity';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION keep_cancel_target() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.operation_id,NEW.session_id,NEW.target_message_id,NEW.target_message_revision,NEW.target_runtime_unit_id,NEW.target_attempt_id,NEW.target_execution_epoch,NEW.target_provider_turn_ref,NEW.requested_by,NEW.requested_at,NEW.cancel_revision) IS DISTINCT FROM (OLD.operation_id,OLD.session_id,OLD.target_message_id,OLD.target_message_revision,OLD.target_runtime_unit_id,OLD.target_attempt_id,OLD.target_execution_epoch,OLD.target_provider_turn_ref,OLD.requested_by,OLD.requested_at,OLD.cancel_revision) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Cancel operation target is immutable';
  END IF;
  RETURN NEW;
END $$;
