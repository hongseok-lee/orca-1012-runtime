SET LOCAL search_path = durable_runtime, pg_catalog;
CREATE TABLE messages (
  id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES sessions,
  seq bigint NOT NULL CHECK(seq>0), revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  sealed_revision bigint, sealed_payload_hash text,
  body_or_blob_ref jsonb NOT NULL,
  intake_status text NOT NULL CHECK(intake_status IN ('DURABLE','DISPATCH_INTENT','STAGED','EFFECT_POSSIBLE','ADMITTED','SETTLED','CANCELLED','UNKNOWN','INTERRUPTED')),
  cancel_requested_at timestamptz, cancel_revision bigint NOT NULL DEFAULT 0 CHECK(cancel_revision>=0),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(session_id,seq), UNIQUE(id,session_id),
  CHECK((sealed_revision IS NULL)=(sealed_payload_hash IS NULL)),
  CHECK(sealed_revision IS NULL OR (sealed_revision>=0 AND sealed_revision<=revision AND sealed_payload_hash ~ '^[0-9a-f]{64}$')),
  CHECK((cancel_requested_at IS NULL)=(cancel_revision=0))
);
CREATE TABLE input_components (
  id uuid PRIMARY KEY, message_id uuid NOT NULL, session_id uuid NOT NULL,
  input_seq bigint NOT NULL CHECK(input_seq>0), authenticated_sender text NOT NULL CHECK(authenticated_sender<>''),
  client_operation_id text, original_payload_hash text NOT NULL CHECK(original_payload_hash ~ '^[0-9a-f]{64}$'),
  body_or_blob_ref jsonb NOT NULL, accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(message_id,session_id) REFERENCES messages(id,session_id),
  UNIQUE(session_id,input_seq), UNIQUE(id,message_id,session_id)
);
CREATE TABLE input_attachments (
  input_id uuid NOT NULL REFERENCES input_components, position bigint NOT NULL CHECK(position>=0),
  blob_ref text NOT NULL CHECK(blob_ref<>''), content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY(input_id,position)
);
CREATE TRIGGER keep_original_input BEFORE UPDATE OR DELETE ON input_components FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER keep_input_attachments BEFORE UPDATE OR DELETE ON input_attachments FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION guard_sealed_message() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.id,NEW.session_id,NEW.seq) IS DISTINCT FROM (OLD.id,OLD.session_id,OLD.seq) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Message identity is immutable';
  END IF;
  IF OLD.sealed_revision IS NOT NULL AND (NEW.body_or_blob_ref,NEW.sealed_revision,NEW.sealed_payload_hash) IS DISTINCT FROM (OLD.body_or_blob_ref,OLD.sealed_revision,OLD.sealed_payload_hash) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Dispatch payload is sealed';
  END IF;
  IF NEW.cancel_revision<OLD.cancel_revision OR (OLD.cancel_requested_at IS NOT NULL AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Cancel intent cannot be erased';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER message_seal_guard BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION guard_sealed_message();
CREATE TRIGGER retain_messages BEFORE DELETE ON messages FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE delivery_attempts (
  id uuid PRIMARY KEY, message_id uuid NOT NULL, session_id uuid NOT NULL,
  runtime_unit_id uuid NOT NULL, attempt_id uuid NOT NULL, execution_epoch bigint NOT NULL,
  state text NOT NULL CHECK(state IN ('DISPATCH_INTENT','STAGED','EFFECT_POSSIBLE','ADMITTED','SETTLED','CANCELLED','UNKNOWN','INTERRUPTED')),
  provider_ref text, effect_possible_at timestamptz, admitted_at timestamptz,
  completed_at timestamptz, failure_reason text,
  FOREIGN KEY(message_id,session_id) REFERENCES messages(id,session_id),
  FOREIGN KEY(session_id,runtime_unit_id) REFERENCES runtime_members(session_id,runtime_unit_id),
  FOREIGN KEY(attempt_id,runtime_unit_id,execution_epoch) REFERENCES attempts(id,runtime_unit_id,execution_epoch),
  UNIQUE(id,message_id,session_id),
  CHECK(state NOT IN ('ADMITTED','SETTLED') OR (admitted_at IS NOT NULL AND provider_ref IS NOT NULL)),
  CHECK(state<>'SETTLED' OR completed_at IS NOT NULL)
);
CREATE TABLE session_context_records (
  id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES sessions,
  revision bigint NOT NULL CHECK(revision>=0), kind text NOT NULL,
  target_message_id uuid, target_event_id uuid, body_ref jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), provider_delivery_evidence jsonb,
  FOREIGN KEY(target_message_id,session_id) REFERENCES messages(id,session_id),
  UNIQUE(id,session_id), UNIQUE(id,session_id,target_event_id)
);
CREATE TABLE cancel_intents (
  operation_id uuid PRIMARY KEY, session_id uuid NOT NULL,
  target_message_id uuid NOT NULL, target_message_revision bigint NOT NULL CHECK(target_message_revision>=0),
  target_runtime_unit_id uuid, target_attempt_id uuid, target_execution_epoch bigint,
  target_provider_turn_ref text, requested_by text NOT NULL CHECK(requested_by<>''),
  requested_at timestamptz NOT NULL, cancel_revision bigint NOT NULL CHECK(cancel_revision>0),
  interrupt_status text NOT NULL CHECK(interrupt_status IN ('NOT_REQUIRED','REQUESTED','CONFIRMED','UNKNOWN','ALREADY_SETTLED')),
  interrupt_evidence_ref text, updated_at timestamptz NOT NULL,
  FOREIGN KEY(target_message_id,session_id) REFERENCES messages(id,session_id),
  FOREIGN KEY(session_id,target_runtime_unit_id) REFERENCES runtime_members(session_id,runtime_unit_id),
  FOREIGN KEY(target_attempt_id,target_runtime_unit_id,target_execution_epoch) REFERENCES attempts(id,runtime_unit_id,execution_epoch) MATCH FULL,
  CHECK(interrupt_status<>'CONFIRMED' OR nullif(interrupt_evidence_ref,'') IS NOT NULL)
);
CREATE FUNCTION keep_cancel_target() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.operation_id,NEW.session_id,NEW.target_message_id,NEW.target_message_revision,NEW.target_runtime_unit_id,NEW.target_attempt_id,NEW.target_execution_epoch,NEW.requested_by,NEW.requested_at,NEW.cancel_revision) IS DISTINCT FROM (OLD.operation_id,OLD.session_id,OLD.target_message_id,OLD.target_message_revision,OLD.target_runtime_unit_id,OLD.target_attempt_id,OLD.target_execution_epoch,OLD.requested_by,OLD.requested_at,OLD.cancel_revision) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Cancel operation target is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cancel_target_guard BEFORE UPDATE ON cancel_intents FOR EACH ROW EXECUTE FUNCTION keep_cancel_target();
CREATE TRIGGER retain_cancel_intents BEFORE DELETE ON cancel_intents FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE rpc_receipts (
  principal_id text NOT NULL CHECK(principal_id<>''), session_scope text NOT NULL CHECK(session_scope<>''),
  method text NOT NULL CHECK(method<>''), operation_key text NOT NULL CHECK(operation_key<>''),
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL, committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(principal_id,session_scope,method,operation_key)
);
CREATE TRIGGER keep_receipt BEFORE UPDATE OR DELETE ON rpc_receipts FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE legacy_drafts (
  terminal_handle text NOT NULL REFERENCES tabs(terminal_handle), paired_device_id text NOT NULL CHECK(paired_device_id<>''),
  floor_generation bigint NOT NULL CHECK(floor_generation>=0), draft_revision bigint NOT NULL CHECK(draft_revision>=0),
  body jsonb NOT NULL, attachments jsonb NOT NULL, lifecycle text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(terminal_handle,paired_device_id,floor_generation)
);
