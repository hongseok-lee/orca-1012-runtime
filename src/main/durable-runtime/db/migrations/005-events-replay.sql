SET LOCAL search_path = durable_runtime, pg_catalog;
CREATE TABLE session_events (
  session_id uuid NOT NULL REFERENCES sessions, journal_epoch bigint NOT NULL CHECK(journal_epoch>=0),
  seq bigint NOT NULL CHECK(seq>0), event_id uuid NOT NULL UNIQUE, source_key text NOT NULL UNIQUE,
  body jsonb NOT NULL, committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(session_id,journal_epoch,seq)
);
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY, aggregate_id uuid NOT NULL, aggregate_kind text NOT NULL,
  revision bigint NOT NULL CHECK(revision>=0), event jsonb NOT NULL, published_at timestamptz
);
CREATE TABLE runtime_event_queue (
  event_id uuid PRIMARY KEY, producer_id uuid NOT NULL, incarnation text NOT NULL CHECK(incarnation<>''),
  producer_seq bigint NOT NULL CHECK(producer_seq>0), agent_id uuid NOT NULL REFERENCES agents,
  payload jsonb NOT NULL, committed_at timestamptz NOT NULL DEFAULT clock_timestamp(), processed_at timestamptz,
  state text NOT NULL CHECK(state IN ('PENDING','PROCESSING','RETRY','DONE','FAILED')),
  attempt_count bigint NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 6),
  retry_count bigint NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 5),
  next_retry_at timestamptz, last_error text, terminal_at timestamptz,
  UNIQUE(producer_id,incarnation,producer_seq), UNIQUE(event_id,agent_id),
  CHECK(retry_count=greatest(attempt_count-1,0)),
  CHECK((state IN ('DONE','FAILED'))=(terminal_at IS NOT NULL)),
  CHECK((state='DONE')=(processed_at IS NOT NULL)),
  CHECK(state<>'FAILED' OR last_error IS NOT NULL)
);
CREATE TABLE runtime_event_targets (
  event_id uuid NOT NULL, session_id uuid NOT NULL, agent_id uuid NOT NULL,
  PRIMARY KEY(event_id,session_id),
  FOREIGN KEY(event_id,agent_id) REFERENCES runtime_event_queue(event_id,agent_id),
  FOREIGN KEY(session_id,agent_id) REFERENCES sessions(id,agent_id)
);
ALTER TABLE session_context_records ADD FOREIGN KEY(target_event_id,session_id) REFERENCES runtime_event_targets(event_id,session_id);
CREATE TABLE runtime_event_attempt_history (
  id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES runtime_event_queue,
  attempt_number bigint NOT NULL CHECK(attempt_number BETWEEN 1 AND 6),
  stage text NOT NULL CHECK(stage IN ('STARTED','SUCCEEDED','FAILED','UNCONFIRMED')),
  controller_term bigint NOT NULL CHECK(controller_term>=0),
  occurred_at timestamptz NOT NULL, error_code text, evidence_ref text,
  UNIQUE(event_id,attempt_number,stage)
);
CREATE TABLE runtime_event_failure_contexts (
  event_id uuid NOT NULL, session_id uuid NOT NULL, context_record_id uuid NOT NULL,
  PRIMARY KEY(event_id,session_id),
  FOREIGN KEY(event_id,session_id) REFERENCES runtime_event_targets,
  FOREIGN KEY(context_record_id,session_id,event_id) REFERENCES session_context_records(id,session_id,target_event_id)
);
CREATE FUNCTION keep_original_runtime_event() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.event_id,NEW.producer_id,NEW.incarnation,NEW.producer_seq,NEW.agent_id,NEW.payload,NEW.committed_at) IS DISTINCT FROM (OLD.event_id,OLD.producer_id,OLD.incarnation,OLD.producer_seq,OLD.agent_id,OLD.payload,OLD.committed_at) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Original queue event is immutable';
  END IF;
  IF OLD.state IN ('DONE','FAILED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Terminal queue outcome is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_event_original_guard BEFORE UPDATE ON runtime_event_queue FOR EACH ROW EXECUTE FUNCTION keep_original_runtime_event();
CREATE FUNCTION require_failed_event_context() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM runtime_event_queue q JOIN runtime_event_targets t ON t.event_id=q.event_id WHERE q.event_id=NEW.event_id AND q.state='FAILED' AND NOT EXISTS(SELECT 1 FROM runtime_event_failure_contexts f WHERE f.event_id=t.event_id AND f.session_id=t.session_id)) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='FAILED event requires each target context';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER failed_event_context_guard AFTER INSERT OR UPDATE ON runtime_event_queue DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_failed_event_context();
CREATE TRIGGER keep_queue_attempt_history BEFORE UPDATE OR DELETE ON runtime_event_attempt_history FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER keep_queue_event BEFORE DELETE ON runtime_event_queue FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER keep_queue_target BEFORE UPDATE OR DELETE ON runtime_event_targets FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER keep_failed_context BEFORE UPDATE OR DELETE ON runtime_event_failure_contexts FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE notifications (
  id uuid PRIMARY KEY, incident_key text NOT NULL UNIQUE,
  target_ref jsonb NOT NULL, reason text NOT NULL, state text NOT NULL CHECK(state IN ('OPEN','RESOLVED')),
  first_seen_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL,
  retry_count bigint NOT NULL DEFAULT 0 CHECK(retry_count>=0),
  read_at timestamptz, resolved_at timestamptz, action_ref uuid REFERENCES operations,
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  CHECK((state='RESOLVED')=(resolved_at IS NOT NULL))
);
CREATE TABLE replay_stream_heads (
  stream_id text PRIMARY KEY CHECK(stream_id<>''), epoch bigint NOT NULL CHECK(epoch>=0),
  published_offset bigint NOT NULL DEFAULT 0 CHECK(published_offset>=0),
  UNIQUE(stream_id,epoch)
);
CREATE TABLE replay_events (
  stream_id text NOT NULL, epoch bigint NOT NULL, offset bigint NOT NULL CHECK(offset>0),
  event_id uuid NOT NULL UNIQUE, occurred_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(), payload jsonb NOT NULL,
  PRIMARY KEY(stream_id,epoch,offset),
  FOREIGN KEY(stream_id,epoch) REFERENCES replay_stream_heads(stream_id,epoch)
);
CREATE TABLE runtime_audit_events (
  id uuid PRIMARY KEY, actor_id text NOT NULL, paired_device_id text,
  runtime_unit_id uuid, session_id uuid, operation_id uuid, attempt_id uuid,
  pod_uid text, node_uid text, resource_profile_revision bigint,
  kind text NOT NULL, reason_code text, previous_state jsonb, next_state jsonb,
  occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL,
  producer_id uuid NOT NULL, producer_seq bigint NOT NULL CHECK(producer_seq>0),
  evidence_refs jsonb NOT NULL, payload jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(session_id,runtime_unit_id) REFERENCES runtime_members(session_id,runtime_unit_id),
  FOREIGN KEY(operation_id,runtime_unit_id) REFERENCES operations(id,runtime_unit_id),
  FOREIGN KEY(attempt_id,runtime_unit_id) REFERENCES attempts(id,runtime_unit_id),
  FOREIGN KEY(runtime_unit_id,resource_profile_revision) REFERENCES resource_profiles,
  CHECK((session_id IS NULL AND operation_id IS NULL AND attempt_id IS NULL AND resource_profile_revision IS NULL) OR runtime_unit_id IS NOT NULL),
  UNIQUE(producer_id,producer_seq)
);
CREATE TRIGGER keep_session_event BEFORE UPDATE OR DELETE ON session_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER keep_audit_event BEFORE UPDATE OR DELETE ON runtime_audit_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER keep_replay_event BEFORE UPDATE OR DELETE ON replay_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
