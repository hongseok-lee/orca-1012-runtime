SET LOCAL search_path = durable_runtime, pg_catalog;

ALTER TABLE failure_incidents ADD UNIQUE(id,runtime_unit_id,attempt_id);
ALTER TABLE failure_incidents ADD CHECK(classification IN (
  'ISOLATED_NODE_MEMORY_EXHAUSTION','CONTAINER_LIMIT_OOM','SHARED_NODE_MEMORY_PRESSURE',
  'PROCESS_HEAP_LIMIT','CHILD_CGROUP_OOM','UNKNOWN_MEMORY_FAILURE','OTHER_TERMINATION'
));

CREATE TABLE failure_observations (
  id text PRIMARY KEY CHECK(id<>''),
  source_dedup_key text NOT NULL UNIQUE CHECK(source_dedup_key<>''),
  runtime_event_id uuid REFERENCES runtime_event_queue(event_id),
  runtime_unit_id uuid NOT NULL REFERENCES runtime_units,
  attempt_id uuid NOT NULL,
  pod_uid text NOT NULL CHECK(pod_uid<>''),
  execution_epoch bigint NOT NULL CHECK(execution_epoch>=0),
  container_name text CHECK(container_name IS NULL OR container_name<>''),
  container_id text CHECK(container_id IS NULL OR container_id<>''),
  incarnation text CHECK(incarnation IS NULL OR incarnation<>''),
  termination_finished_at text CHECK(termination_finished_at IS NULL OR termination_finished_at<>''),
  counter_kind text CHECK(counter_kind IS NULL OR counter_kind IN ('oom','oom_kill','oom_group_kill')),
  counter_previous numeric CHECK(counter_previous IS NULL OR (counter_previous>=0 AND counter_previous=trunc(counter_previous) AND counter_previous::text NOT IN ('NaN','Infinity','-Infinity'))),
  counter_current numeric CHECK(counter_current IS NULL OR (counter_current>=0 AND counter_current=trunc(counter_current) AND counter_current::text NOT IN ('NaN','Infinity','-Infinity'))),
  source_kind text NOT NULL CHECK(source_kind IN ('KUBERNETES','CGROUP','SUPERVISOR','UNTRUSTED_TEXT')),
  source_ref text NOT NULL CHECK(source_ref<>''),
  schema_version integer NOT NULL CHECK(schema_version=1),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
  evidence_digest text NOT NULL CHECK(evidence_digest ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY(attempt_id,runtime_unit_id,execution_epoch,pod_uid) REFERENCES attempts(id,runtime_unit_id,execution_epoch,pod_uid),
  UNIQUE(id,runtime_unit_id,attempt_id),
  CHECK((counter_kind IS NULL AND counter_previous IS NULL AND counter_current IS NULL)
     OR (counter_kind IS NOT NULL AND counter_previous IS NOT NULL AND counter_current IS NOT NULL))
);
CREATE TABLE failure_incident_observations (
  observation_id text PRIMARY KEY,
  incident_id uuid NOT NULL,
  runtime_unit_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  FOREIGN KEY(observation_id,runtime_unit_id,attempt_id) REFERENCES failure_observations(id,runtime_unit_id,attempt_id),
  FOREIGN KEY(incident_id,runtime_unit_id,attempt_id) REFERENCES failure_incidents(id,runtime_unit_id,attempt_id)
);
CREATE TABLE failure_incident_aliases (
  alias_key text PRIMARY KEY CHECK(alias_key<>''),
  incident_id uuid NOT NULL,
  runtime_unit_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  alias_kind text NOT NULL CHECK(alias_kind IN ('TERMINATION','COUNTER_TRANSITION')),
  alias_value jsonb NOT NULL CHECK(jsonb_typeof(alias_value)='object'),
  FOREIGN KEY(incident_id,runtime_unit_id,attempt_id) REFERENCES failure_incidents(id,runtime_unit_id,attempt_id)
);
CREATE TABLE failure_incident_state (
  incident_id uuid PRIMARY KEY,
  runtime_unit_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  execution_epoch bigint NOT NULL CHECK(execution_epoch>=0),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  collection_started_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN ('COLLECTING','CLASSIFIED','BLOCKED')),
  reason text CHECK(reason IS NULL OR reason<>''),
  classification_revision bigint NOT NULL DEFAULT 0 CHECK(classification_revision>=0),
  evidence_ids text[] NOT NULL DEFAULT '{}',
  FOREIGN KEY(incident_id,runtime_unit_id,attempt_id) REFERENCES failure_incidents(id,runtime_unit_id,attempt_id),
  FOREIGN KEY(attempt_id,runtime_unit_id,execution_epoch) REFERENCES attempts(id,runtime_unit_id,execution_epoch),
  CHECK(deadline_at>=collection_started_at),
  CHECK(state<>'BLOCKED' OR reason IS NOT NULL),
  CHECK(array_position(evidence_ids,NULL) IS NULL)
);

CREATE FUNCTION guard_failure_incident_identity() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.id,NEW.runtime_unit_id,NEW.attempt_id,NEW.pod_uid,NEW.container_id,NEW.restart_identity,NEW.evidence_key,NEW.observed_at)
     IS DISTINCT FROM (OLD.id,OLD.runtime_unit_id,OLD.attempt_id,OLD.pod_uid,OLD.container_id,OLD.restart_identity,OLD.evidence_key,OLD.observed_at) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Failure incident original identity and canonical evidence key are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER failure_incident_identity_guard BEFORE UPDATE ON failure_incidents
  FOR EACH ROW EXECUTE FUNCTION guard_failure_incident_identity();
CREATE FUNCTION guard_failure_incident_state() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND (
    (NEW.incident_id,NEW.runtime_unit_id,NEW.attempt_id,NEW.execution_epoch,NEW.collection_started_at,NEW.deadline_at)
      IS DISTINCT FROM (OLD.incident_id,OLD.runtime_unit_id,OLD.attempt_id,OLD.execution_epoch,OLD.collection_started_at,OLD.deadline_at)
    OR NEW.revision<OLD.revision OR NEW.classification_revision<OLD.classification_revision
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Failure collection identity and original deadline are immutable; revisions cannot decrease';
  END IF;
  IF EXISTS(SELECT 1 FROM unnest(NEW.evidence_ids) AS requested(id)
    WHERE NOT EXISTS(SELECT 1 FROM failure_incident_observations linked
      WHERE linked.observation_id=requested.id AND linked.incident_id=NEW.incident_id
        AND linked.runtime_unit_id=NEW.runtime_unit_id AND linked.attempt_id=NEW.attempt_id)) THEN
    RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='Failure classification evidence must belong to the original incident';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER failure_incident_state_guard BEFORE INSERT OR UPDATE ON failure_incident_state
  FOR EACH ROW EXECUTE FUNCTION guard_failure_incident_state();

CREATE FUNCTION guard_failure_alias_canonical_key() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM failure_incidents original
    WHERE original.evidence_key=NEW.alias_key AND original.id<>NEW.incident_id) THEN
    RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Failure alias canonical key belongs to another incident';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER failure_alias_canonical_key_guard BEFORE INSERT ON failure_incident_aliases
  FOR EACH ROW EXECUTE FUNCTION guard_failure_alias_canonical_key();
CREATE FUNCTION guard_failure_canonical_alias_owner() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM failure_incident_aliases original
    WHERE original.alias_key=NEW.evidence_key AND original.incident_id<>NEW.id) THEN
    RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Failure canonical key alias belongs to another incident';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER failure_canonical_alias_owner_guard BEFORE INSERT ON failure_incidents
  FOR EACH ROW EXECUTE FUNCTION guard_failure_canonical_alias_owner();

CREATE TRIGGER keep_failure_observation BEFORE UPDATE OR DELETE ON failure_observations
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER keep_failure_observation_link BEFORE UPDATE OR DELETE ON failure_incident_observations
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER keep_failure_alias BEFORE UPDATE OR DELETE ON failure_incident_aliases
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER retain_failure_incident BEFORE DELETE ON failure_incidents
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER retain_failure_incident_state BEFORE DELETE ON failure_incident_state
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
