SET LOCAL search_path = durable_runtime, pg_catalog;

CREATE TABLE runtime_units (
  id uuid PRIMARY KEY,
  dataset_name text NOT NULL DEFAULT 'orca-1012-dev-v1' REFERENCES dataset_metadata,
  desired_mode text NOT NULL CHECK (desired_mode IN ('RUNNING','SUSPENDED','DELETED')),
  intent_revision bigint NOT NULL DEFAULT 0 CHECK (intent_revision >= 0),
  phase text NOT NULL CHECK (phase IN ('ABSENT','PROVISIONING','RESTORING','REHYDRATING','READY','QUIESCING','SNAPSHOTTING','SUSPENDED','RECOVERING','RESOURCE_WAIT','BLOCKED','DELETING')),
  execution_epoch bigint NOT NULL DEFAULT 0 CHECK (execution_epoch >= 0),
  active_attempt_id uuid,
  last_work_event_at timestamptz,
  idle_due_at timestamptz,
  observation_lost_at timestamptz,
  reconcile_due_at timestamptz,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
CREATE TABLE attempts (
  id uuid PRIMARY KEY,
  runtime_unit_id uuid NOT NULL REFERENCES runtime_units,
  execution_epoch bigint NOT NULL CHECK (execution_epoch >= 0),
  mode text NOT NULL CHECK (mode IN ('COLD','RESTORE')),
  pod_uid text,
  incarnation text,
  snapshot_id uuid,
  resource_profile_revision bigint NOT NULL CHECK (resource_profile_revision >= 0),
  effective_resources jsonb NOT NULL,
  status text NOT NULL,
  started_at timestamptz, ready_at timestamptz, stopped_at timestamptz, reason text,
  UNIQUE(id, runtime_unit_id), UNIQUE(id, runtime_unit_id, execution_epoch),
  UNIQUE(runtime_unit_id, execution_epoch)
);
ALTER TABLE runtime_units ADD FOREIGN KEY(active_attempt_id, id) REFERENCES attempts(id, runtime_unit_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE execution_grants (
  id uuid PRIMARY KEY,
  runtime_unit_id uuid NOT NULL REFERENCES runtime_units,
  attempt_id uuid NOT NULL,
  execution_epoch bigint NOT NULL CHECK (execution_epoch >= 0),
  state text NOT NULL CHECK (state IN ('RESERVED','ACTIVE','REVOKING','REVOKED')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  stopped_proof_ref text,
  FOREIGN KEY(attempt_id, runtime_unit_id, execution_epoch) REFERENCES attempts(id, runtime_unit_id, execution_epoch),
  CHECK ((state='REVOKED') = (revoked_at IS NOT NULL)),
  CHECK (state<>'REVOKED' OR nullif(stopped_proof_ref,'') IS NOT NULL)
);
CREATE UNIQUE INDEX one_execution_owner ON execution_grants(runtime_unit_id) WHERE state IN ('RESERVED','ACTIVE','REVOKING');

CREATE TABLE storage_domains (
  backend_id text NOT NULL CHECK (backend_id<>''),
  export_id text NOT NULL CHECK (export_id<>''),
  lock_revision bigint NOT NULL DEFAULT 0 CHECK(lock_revision>=0),
  PRIMARY KEY(backend_id, export_id)
);
CREATE TABLE storage_bindings (
  id uuid PRIMARY KEY,
  backend_id text NOT NULL,
  export_id text NOT NULL,
  canonical_directory text NOT NULL CHECK (canonical_directory ~ '^/' AND canonical_directory !~ '//|(^|/)\.{1,2}(/|$)' AND (canonical_directory='/' OR canonical_directory !~ '/$')),
  identity_proof_ref text,
  identity_verified_at timestamptz,
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch>=0),
  seal_id uuid,
  writer_attempt_id uuid REFERENCES attempts,
  access_state text NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  FOREIGN KEY(backend_id,export_id) REFERENCES storage_domains,
  UNIQUE(backend_id,export_id,canonical_directory),
  CHECK ((identity_verified_at IS NOT NULL) = (nullif(identity_proof_ref,'') IS NOT NULL))
);
CREATE TABLE runtime_members (
  runtime_unit_id uuid NOT NULL REFERENCES runtime_units,
  session_id uuid NOT NULL UNIQUE REFERENCES sessions,
  storage_binding_id uuid NOT NULL REFERENCES storage_bindings,
  PRIMARY KEY(runtime_unit_id,session_id),
  UNIQUE(session_id,runtime_unit_id), UNIQUE(runtime_unit_id,session_id,storage_binding_id)
);
CREATE TABLE storage_write_grants (
  id uuid PRIMARY KEY,
  storage_binding_id uuid NOT NULL REFERENCES storage_bindings,
  attempt_id uuid NOT NULL REFERENCES attempts,
  storage_epoch bigint NOT NULL CHECK(storage_epoch>=0),
  state text NOT NULL CHECK(state IN ('RESERVED','ACTIVE','REVOKING','REVOKED')),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  revocation_proof_ref text,
  UNIQUE(id,storage_binding_id,attempt_id,storage_epoch),
  CHECK ((state='REVOKED') = (revoked_at IS NOT NULL)),
  CHECK (state<>'REVOKED' OR nullif(revocation_proof_ref,'') IS NOT NULL)
);
CREATE UNIQUE INDEX one_storage_writer ON storage_write_grants(storage_binding_id) WHERE state IN ('RESERVED','ACTIVE','REVOKING');

CREATE FUNCTION guard_storage_writer() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
DECLARE binding storage_bindings%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.storage_binding_id,NEW.attempt_id,NEW.storage_epoch) IS DISTINCT FROM (OLD.storage_binding_id,OLD.attempt_id,OLD.storage_epoch) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Storage grant identity is immutable';
  END IF;
  SELECT * INTO STRICT binding FROM storage_bindings WHERE id=NEW.storage_binding_id;
  -- A row write serializes overlapping paths and forces stale RR snapshots to abort.
  UPDATE storage_domains SET lock_revision=lock_revision+1 WHERE backend_id=binding.backend_id AND export_id=binding.export_id;
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
CREATE TRIGGER storage_writer_domain_guard BEFORE INSERT OR UPDATE ON storage_write_grants FOR EACH ROW EXECUTE FUNCTION guard_storage_writer();
CREATE TRIGGER retain_storage_grants BEFORE DELETE ON storage_write_grants FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER retain_execution_grants BEFORE DELETE ON execution_grants FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION keep_storage_identity() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.backend_id,NEW.export_id,NEW.canonical_directory) IS DISTINCT FROM (OLD.backend_id,OLD.export_id,OLD.canonical_directory) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Canonical storage domain identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER storage_identity_guard BEFORE UPDATE ON storage_bindings FOR EACH ROW EXECUTE FUNCTION keep_storage_identity();

CREATE TABLE storage_mounts (
  id uuid PRIMARY KEY,
  storage_binding_id uuid NOT NULL REFERENCES storage_bindings,
  attempt_id uuid NOT NULL REFERENCES attempts,
  pod_uid text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('RO','RW')),
  write_grant_id uuid,
  desired_state text NOT NULL,
  observed_state text NOT NULL CHECK(observed_state IN ('RESERVED','ACTIVE','REVOKING','REVOKED','UNKNOWN')),
  grant_epoch bigint NOT NULL CHECK(grant_epoch>=0),
  mounted_at timestamptz, revoking_at timestamptz, revoked_at timestamptz, evidence_ref text,
  FOREIGN KEY(write_grant_id,storage_binding_id,attempt_id,grant_epoch) REFERENCES storage_write_grants(id,storage_binding_id,attempt_id,storage_epoch),
  CHECK ((mode='RW') = (write_grant_id IS NOT NULL)),
  CHECK (observed_state<>'REVOKED' OR (revoked_at IS NOT NULL AND nullif(evidence_ref,'') IS NOT NULL))
);
CREATE UNIQUE INDEX one_rw_mount_per_grant ON storage_mounts(write_grant_id) WHERE mode='RW' AND observed_state<>'REVOKED';
