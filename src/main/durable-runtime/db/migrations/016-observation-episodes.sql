SET LOCAL search_path = durable_runtime, pg_catalog;

-- Never fabricate the original Pod/source/time for a historical episode.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM durable_runtime.observation_episodes) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Observation episode migration requires an empty original table; historical provenance cannot be backfilled';
  END IF;
END $$;

ALTER TABLE observation_episodes
  ALTER COLUMN start_watermark DROP NOT NULL,
  ALTER COLUMN started_at SET DEFAULT clock_timestamp(),
  ADD COLUMN pod_uid text NOT NULL CHECK(pod_uid<>''),
  ADD COLUMN state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','FENCING','BLOCKED','RESOLVED')),
  ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  ADD COLUMN start_source_ref text NOT NULL CHECK(start_source_ref<>''),
  ADD COLUMN start_producer_id uuid,
  ADD COLUMN fence_operation_id uuid,
  ADD COLUMN reason text CHECK(reason IS NULL OR reason<>''),
  ADD FOREIGN KEY(attempt_id,runtime_unit_id,execution_epoch,pod_uid)
    REFERENCES attempts(id,runtime_unit_id,execution_epoch,pod_uid),
  ADD FOREIGN KEY(fence_operation_id,runtime_unit_id) REFERENCES operations(id,runtime_unit_id),
  ADD UNIQUE(id,runtime_unit_id,attempt_id,execution_epoch,pod_uid),
  ADD CHECK((start_producer_id IS NULL)=(start_watermark IS NULL)),
  ADD CHECK((state='RESOLVED')=(resolved_at IS NOT NULL)),
  ADD CHECK(resolved_at IS NULL OR resolved_at>=started_at),
  ADD CHECK(state<>'BLOCKED' OR reason IS NOT NULL),
  ADD CHECK(state NOT IN ('FENCING','BLOCKED') OR fence_operation_id IS NOT NULL),
  ADD CHECK(deadline_at=started_at+interval '6 hours');

CREATE UNIQUE INDEX one_unresolved_observation_episode
  ON observation_episodes(runtime_unit_id,attempt_id,execution_epoch,pod_uid)
  WHERE resolved_at IS NULL;

CREATE FUNCTION guard_observation_episode() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.deadline_at IS NULL THEN
      NEW.deadline_at:=NEW.started_at+interval '6 hours';
    END IF;
  ELSE
    IF (NEW.id,NEW.runtime_unit_id,NEW.attempt_id,NEW.execution_epoch,NEW.pod_uid,
        NEW.started_at,NEW.deadline_at,NEW.start_source_ref,NEW.start_producer_id,NEW.start_watermark)
       IS DISTINCT FROM
       (OLD.id,OLD.runtime_unit_id,OLD.attempt_id,OLD.execution_epoch,OLD.pod_uid,
        OLD.started_at,OLD.deadline_at,OLD.start_source_ref,OLD.start_producer_id,OLD.start_watermark)
       OR NEW.revision<OLD.revision THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Observation original tuple, start, six-hour deadline and producer watermark are immutable; revision cannot decrease';
    END IF;
    IF OLD.resolved_at IS NOT NULL AND
       (NEW.state,NEW.resolved_at) IS DISTINCT FROM (OLD.state,OLD.resolved_at) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Resolved observation episode cannot reopen or replace its resolution time';
    END IF;
    IF OLD.fence_operation_id IS NOT NULL AND NEW.fence_operation_id IS DISTINCT FROM OLD.fence_operation_id THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Observation original fence operation is retained';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER observation_episode_guard BEFORE INSERT OR UPDATE ON observation_episodes
  FOR EACH ROW EXECUTE FUNCTION guard_observation_episode();
CREATE TRIGGER retain_observation_episode BEFORE DELETE ON observation_episodes
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE observation_challenges (
  id text PRIMARY KEY CHECK(id<>''),
  episode_id uuid NOT NULL,
  runtime_unit_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  pod_uid text NOT NULL CHECK(pod_uid<>''),
  execution_epoch bigint NOT NULL CHECK(execution_epoch>=0),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  request_source_ref text NOT NULL CHECK(request_source_ref<>''),
  expected_producer_id uuid,
  expected_watermark bigint CHECK(expected_watermark>=0),
  consumed_at timestamptz,
  superseded_at timestamptz,
  superseded_by text,
  FOREIGN KEY(episode_id,runtime_unit_id,attempt_id,execution_epoch,pod_uid)
    REFERENCES observation_episodes(id,runtime_unit_id,attempt_id,execution_epoch,pod_uid),
  UNIQUE(id,episode_id),
  FOREIGN KEY(superseded_by,episode_id) REFERENCES observation_challenges(id,episode_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK((expected_producer_id IS NULL)=(expected_watermark IS NULL)),
  CHECK(consumed_at IS NULL OR consumed_at>=issued_at),
  CHECK(superseded_at IS NULL OR superseded_at>=issued_at),
  CHECK(consumed_at IS NULL OR superseded_at IS NULL),
  CHECK((superseded_at IS NULL)=(superseded_by IS NULL)),
  CHECK(superseded_by IS NULL OR superseded_by<>id)
);
CREATE UNIQUE INDEX one_pending_observation_challenge
  ON observation_challenges(episode_id) WHERE consumed_at IS NULL AND superseded_at IS NULL;

CREATE FUNCTION guard_observation_challenge() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.id,NEW.episode_id,NEW.runtime_unit_id,NEW.attempt_id,NEW.pod_uid,NEW.execution_epoch,
      NEW.issued_at,NEW.request_source_ref,NEW.expected_producer_id,NEW.expected_watermark)
     IS DISTINCT FROM
     (OLD.id,OLD.episode_id,OLD.runtime_unit_id,OLD.attempt_id,OLD.pod_uid,OLD.execution_epoch,
      OLD.issued_at,OLD.request_source_ref,OLD.expected_producer_id,OLD.expected_watermark) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Observation challenge original request identity and correlation are immutable';
  END IF;
  IF (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at)
     OR (OLD.superseded_at IS NOT NULL AND
         (NEW.superseded_at,NEW.superseded_by) IS DISTINCT FROM (OLD.superseded_at,OLD.superseded_by)) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Observation challenge consumption and supersession facts are retained';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER observation_challenge_guard BEFORE UPDATE ON observation_challenges
  FOR EACH ROW EXECUTE FUNCTION guard_observation_challenge();
CREATE TRIGGER retain_observation_challenge BEFORE DELETE ON observation_challenges
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
