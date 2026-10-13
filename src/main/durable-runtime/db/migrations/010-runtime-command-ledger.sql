SET LOCAL search_path = durable_runtime, pg_catalog;
CREATE TABLE runtime_commands (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL, runtime_unit_id uuid NOT NULL,
  command_name text NOT NULL CHECK(command_name IN ('ensureAttempt','planRecovery','fenceAttempt','bind','prepareCheckpoint','checkpointAndStop','releaseGate','resizeAttempt','stageInput','dispatchInput','cancel')),
  original_controller_term bigint NOT NULL CHECK(original_controller_term>=0),
  step_revision bigint NOT NULL CHECK(step_revision>=0),
  pod_target text NOT NULL CHECK(pod_target IN ('CREATE_WITHOUT_POD','EXISTING_POD')),
  expected_pod_uid text,
  execution_epoch bigint NOT NULL CHECK(execution_epoch>=0),
  intent_revision bigint NOT NULL CHECK(intent_revision>=0),
  input_hash text NOT NULL CHECK(input_hash ~ '^[0-9a-f]{64}$'), input jsonb NOT NULL,
  state text NOT NULL DEFAULT 'ACCEPTED' CHECK(state IN ('ACCEPTED','EXECUTING','UNKNOWN','RESOLVED','REFUSED')),
  owner_controller_term bigint NOT NULL CHECK(owner_controller_term>=original_controller_term),
  executor_id text, execution_token uuid,
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz, settled_at timestamptz,
  result jsonb, refusal_code text, evidence_refs jsonb NOT NULL DEFAULT '[]',
  FOREIGN KEY(operation_id,runtime_unit_id) REFERENCES operations(id,runtime_unit_id),
  UNIQUE(operation_id,step_revision,command_name),
  CHECK((pod_target='CREATE_WITHOUT_POD' AND expected_pod_uid IS NULL)
     OR (pod_target='EXISTING_POD' AND nullif(expected_pod_uid,'') IS NOT NULL)),
  CHECK((claimed_at IS NULL AND executor_id IS NULL AND execution_token IS NULL)
     OR (claimed_at IS NOT NULL AND nullif(executor_id,'') IS NOT NULL AND execution_token IS NOT NULL)),
  CHECK(state<>'ACCEPTED' OR claimed_at IS NULL),
  CHECK(state NOT IN ('EXECUTING','UNKNOWN') OR claimed_at IS NOT NULL),
  CHECK((state IN ('RESOLVED','REFUSED'))=(settled_at IS NOT NULL)),
  CHECK((state='RESOLVED' AND result IS NOT NULL AND refusal_code IS NULL)
     OR (state='REFUSED' AND result IS NULL AND nullif(refusal_code,'') IS NOT NULL)
     OR (state IN ('ACCEPTED','EXECUTING','UNKNOWN') AND result IS NULL AND refusal_code IS NULL)),
  CHECK(claimed_at IS NULL OR claimed_at>=accepted_at),
  CHECK(settled_at IS NULL OR settled_at>=coalesce(claimed_at,accepted_at)),
  CHECK(jsonb_typeof(evidence_refs)='array')
);
CREATE UNIQUE INDEX runtime_one_unresolved_command ON runtime_commands(runtime_unit_id)
  WHERE state IN ('ACCEPTED','EXECUTING','UNKNOWN');
CREATE FUNCTION keep_runtime_command_identity() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.id,NEW.operation_id,NEW.runtime_unit_id,NEW.command_name,NEW.original_controller_term,
      NEW.step_revision,NEW.pod_target,NEW.expected_pod_uid,NEW.execution_epoch,NEW.intent_revision,
      NEW.input_hash,NEW.input,NEW.accepted_at)
     IS DISTINCT FROM
     (OLD.id,OLD.operation_id,OLD.runtime_unit_id,OLD.command_name,OLD.original_controller_term,
      OLD.step_revision,OLD.pod_target,OLD.expected_pod_uid,OLD.execution_epoch,OLD.intent_revision,
      OLD.input_hash,OLD.input,OLD.accepted_at)
     OR NEW.owner_controller_term<OLD.owner_controller_term OR NEW.revision<OLD.revision
     OR (OLD.state IN ('RESOLVED','REFUSED') AND NEW IS DISTINCT FROM OLD)
     OR (OLD.state IN ('EXECUTING','UNKNOWN') AND NEW.state='ACCEPTED')
     OR (OLD.state='UNKNOWN' AND NEW.state='EXECUTING')
     OR (OLD.claimed_at IS NOT NULL AND (NEW.claimed_at,NEW.executor_id,NEW.execution_token)
         IS DISTINCT FROM (OLD.claimed_at,OLD.executor_id,OLD.execution_token)) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Command original identity or execution outcome is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER runtime_command_identity_guard BEFORE UPDATE ON runtime_commands
  FOR EACH ROW EXECUTE FUNCTION keep_runtime_command_identity();
CREATE TRIGGER retain_runtime_command BEFORE DELETE ON runtime_commands
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE runtime_command_history (
  id uuid PRIMARY KEY, command_id uuid NOT NULL REFERENCES runtime_commands,
  stage text NOT NULL CHECK(stage<>''),
  controller_term bigint NOT NULL CHECK(controller_term>=0),
  executor_id text, execution_token uuid,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  evidence_refs jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(evidence_refs)='array'),
  CHECK((executor_id IS NULL AND execution_token IS NULL)
     OR (nullif(executor_id,'') IS NOT NULL AND execution_token IS NOT NULL))
);
CREATE TRIGGER keep_runtime_command_history BEFORE UPDATE OR DELETE ON runtime_command_history
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
