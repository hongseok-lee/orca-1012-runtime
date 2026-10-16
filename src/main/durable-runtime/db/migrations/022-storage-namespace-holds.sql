SET LOCAL search_path = durable_runtime, pg_catalog;

-- Management namespace coordination only. These rows do not fence file writers
-- or certify a PV/export/helper/access-policy digest. There is no expiry.
CREATE TABLE storage_namespace_profiles (
  id uuid PRIMARY KEY,
  dataset_name text NOT NULL REFERENCES dataset_metadata,
  backend_id text NOT NULL,
  export_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 0),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('ACTIVE','DRAINING','APPLYING')),
  management_operation_id uuid,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  UNIQUE (dataset_name,backend_id,export_id),
  FOREIGN KEY (backend_id,export_id) REFERENCES storage_domains,
  CHECK ((state='ACTIVE') = (management_operation_id IS NULL))
);
CREATE TABLE storage_namespace_profile_versions (
  profile_id uuid NOT NULL REFERENCES storage_namespace_profiles,
  generation bigint NOT NULL CHECK (generation >= 0),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (profile_id,generation),
  UNIQUE (profile_id,generation,digest)
);
ALTER TABLE storage_namespace_profiles ADD FOREIGN KEY (id,generation,digest)
  REFERENCES storage_namespace_profile_versions(profile_id,generation,digest)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE storage_namespace_holds (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL,
  generation bigint NOT NULL,
  digest text NOT NULL,
  owner_token_hash text NOT NULL CHECK (owner_token_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('HELD','RELEASED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz,
  FOREIGN KEY (profile_id,generation,digest)
    REFERENCES storage_namespace_profile_versions(profile_id,generation,digest),
  CHECK ((state='RELEASED') = (released_at IS NOT NULL))
);
CREATE INDEX storage_namespace_held ON storage_namespace_holds(profile_id) WHERE state='HELD';
CREATE TABLE storage_namespace_management_operations (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL,
  generation bigint NOT NULL,
  digest text NOT NULL,
  owner_token_hash text NOT NULL CHECK (owner_token_hash ~ '^[0-9a-f]{64}$'),
  target_generation bigint NOT NULL CHECK (target_generation > 0),
  target_digest text NOT NULL CHECK (target_digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('DRAINING','APPLYING','COMPLETED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz,
  completed_at timestamptz,
  UNIQUE (id,profile_id,generation,digest),
  FOREIGN KEY (profile_id,generation,digest)
    REFERENCES storage_namespace_profile_versions(profile_id,generation,digest),
  CHECK (target_generation=generation+1),
  CHECK ((state IN ('APPLYING','COMPLETED')) = (claimed_at IS NOT NULL)),
  CHECK ((state='COMPLETED') = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX storage_namespace_one_management_operation
  ON storage_namespace_management_operations(profile_id) WHERE state<>'COMPLETED';
ALTER TABLE storage_namespace_profiles ADD FOREIGN KEY (management_operation_id,id,generation,digest)
  REFERENCES storage_namespace_management_operations(id,profile_id,generation,digest)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION guard_namespace_profile() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
DECLARE valid boolean;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Namespace profile history is retained';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'ACTIVE' OR NEW.revision<>0 THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Namespace profile initial state';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.dataset_name,NEW.backend_id,NEW.export_id)
       IS DISTINCT FROM ROW(OLD.id,OLD.dataset_name,OLD.backend_id,OLD.export_id)
       OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Namespace profile identity/revision';
  END IF;
  valid := false;
  IF OLD.state='ACTIVE' AND NEW.state='DRAINING' AND
     ROW(NEW.generation,NEW.digest)=ROW(OLD.generation,OLD.digest) THEN
    SELECT EXISTS(SELECT 1 FROM storage_namespace_management_operations o
      WHERE o.id=NEW.management_operation_id AND o.profile_id=OLD.id
      AND o.generation=OLD.generation AND o.digest=OLD.digest AND o.state='DRAINING') INTO valid;
  ELSIF OLD.state='DRAINING' AND NEW.state='APPLYING' AND
     ROW(NEW.generation,NEW.digest,NEW.management_operation_id)=
     ROW(OLD.generation,OLD.digest,OLD.management_operation_id) THEN
    SELECT EXISTS(SELECT 1 FROM storage_namespace_management_operations o
      WHERE o.id=OLD.management_operation_id AND o.state='APPLYING')
      AND NOT EXISTS(SELECT 1 FROM storage_namespace_holds h WHERE h.profile_id=OLD.id AND h.state='HELD') INTO valid;
  ELSIF OLD.state='APPLYING' AND NEW.state='ACTIVE' THEN
    SELECT EXISTS(SELECT 1 FROM storage_namespace_management_operations o
      WHERE o.id=OLD.management_operation_id AND o.profile_id=OLD.id AND o.state='COMPLETED'
      AND o.target_generation=NEW.generation AND o.target_digest=NEW.digest) INTO valid;
  END IF;
  IF NOT valid THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Namespace profile transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER namespace_profile_guard BEFORE INSERT OR UPDATE OR DELETE ON storage_namespace_profiles
  FOR EACH ROW EXECUTE FUNCTION guard_namespace_profile();
CREATE TRIGGER namespace_profile_version_history BEFORE UPDATE OR DELETE ON storage_namespace_profile_versions
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION guard_namespace_hold() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
DECLARE p storage_namespace_profiles;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Namespace hold history is retained';
  END IF;
  SELECT * INTO p FROM storage_namespace_profiles WHERE id=NEW.profile_id FOR UPDATE;
  IF TG_OP='INSERT' THEN
    IF p.id IS NULL OR p.state<>'ACTIVE' OR NEW.state<>'HELD' OR
       ROW(p.generation,p.digest) IS DISTINCT FROM ROW(NEW.generation,NEW.digest) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Namespace hold profile is not active';
    END IF;
  ELSIF ROW(NEW.id,NEW.profile_id,NEW.generation,NEW.digest,NEW.owner_token_hash,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.profile_id,OLD.generation,OLD.digest,OLD.owner_token_hash,OLD.created_at)
    OR OLD.state<>'HELD' OR NEW.state<>'RELEASED' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Namespace hold transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER namespace_hold_guard BEFORE INSERT OR UPDATE OR DELETE ON storage_namespace_holds
  FOR EACH ROW EXECUTE FUNCTION guard_namespace_hold();

CREATE FUNCTION guard_namespace_management() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
DECLARE p storage_namespace_profiles;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Namespace management history is retained';
  END IF;
  SELECT * INTO p FROM storage_namespace_profiles WHERE id=NEW.profile_id FOR UPDATE;
  IF TG_OP='INSERT' THEN
    IF p.id IS NULL OR p.state<>'ACTIVE' OR NEW.state<>'DRAINING' OR
       ROW(p.generation,p.digest) IS DISTINCT FROM ROW(NEW.generation,NEW.digest) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Namespace management initial state';
    END IF;
  ELSE
    IF ROW(NEW.id,NEW.profile_id,NEW.generation,NEW.digest,NEW.owner_token_hash,
           NEW.target_generation,NEW.target_digest,NEW.created_at)
       IS DISTINCT FROM ROW(OLD.id,OLD.profile_id,OLD.generation,OLD.digest,OLD.owner_token_hash,
           OLD.target_generation,OLD.target_digest,OLD.created_at) OR
       p.management_operation_id IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Namespace management identity';
    END IF;
    IF OLD.state='DRAINING' AND NEW.state='APPLYING' AND p.state='DRAINING' AND
       NOT EXISTS(SELECT 1 FROM storage_namespace_holds h WHERE h.profile_id=p.id AND h.state='HELD') THEN
      RETURN NEW;
    ELSIF OLD.state='APPLYING' AND NEW.state='COMPLETED' AND p.state='APPLYING' AND
          NEW.claimed_at=OLD.claimed_at THEN
      RETURN NEW;
    ELSE
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Namespace management transition';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER namespace_management_guard BEFORE INSERT OR UPDATE OR DELETE ON storage_namespace_management_operations
  FOR EACH ROW EXECUTE FUNCTION guard_namespace_management();
