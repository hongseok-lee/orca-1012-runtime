SET LOCAL search_path = durable_runtime, pg_catalog;
CREATE TABLE snapshot_manifests (
  id uuid PRIMARY KEY, runtime_unit_id uuid NOT NULL REFERENCES runtime_units,
  checkpoint_id uuid NOT NULL UNIQUE, snapshot_resource text NOT NULL,
  source_attempt_id uuid NOT NULL, source_execution_epoch bigint NOT NULL,
  status text NOT NULL CHECK(status IN ('PREPARING','READY_SEALED','CONSUMED','INVALID','FAILED')),
  provider_watermarks jsonb NOT NULL, spec_digest text NOT NULL,
  compatibility jsonb NOT NULL, closed_tab_revision bigint NOT NULL CHECK(closed_tab_revision>=0),
  capture_mode text NOT NULL CHECK(capture_mode IN ('QUIESCENT','FROZEN_TURN')),
  restore_gate_contract_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), consumed_at timestamptz,
  FOREIGN KEY(source_attempt_id,runtime_unit_id,source_execution_epoch) REFERENCES attempts(id,runtime_unit_id,execution_epoch),
  UNIQUE(id,runtime_unit_id),
  CHECK((status='CONSUMED')=(consumed_at IS NOT NULL))
);
ALTER TABLE attempts ADD FOREIGN KEY(snapshot_id,runtime_unit_id) REFERENCES snapshot_manifests(id,runtime_unit_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE storage_seals (
  id uuid PRIMARY KEY, storage_binding_id uuid NOT NULL REFERENCES storage_bindings,
  snapshot_id uuid NOT NULL REFERENCES snapshot_manifests,
  storage_epoch bigint NOT NULL CHECK(storage_epoch>=0),
  sealed_at timestamptz NOT NULL, source_stopped_at timestamptz NOT NULL,
  directory_mutation_seq bigint NOT NULL CHECK(directory_mutation_seq>=0),
  latest_file_mtime timestamptz, watch_coverage jsonb NOT NULL,
  evidence_ref text NOT NULL,
  UNIQUE(id,storage_binding_id), UNIQUE(snapshot_id,storage_binding_id)
);
ALTER TABLE storage_bindings ADD FOREIGN KEY(seal_id,id) REFERENCES storage_seals(id,storage_binding_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE snapshot_session_watermarks (
  snapshot_id uuid NOT NULL, runtime_unit_id uuid NOT NULL, session_id uuid NOT NULL,
  provider_handle_lineage jsonb NOT NULL, provider_checkpoint text,
  last_admitted_input_seq bigint NOT NULL CHECK(last_admitted_input_seq>=0),
  last_settled_input_seq bigint NOT NULL CHECK(last_settled_input_seq>=0),
  durable_event_cursor bigint NOT NULL CHECK(durable_event_cursor>=0),
  session_context_revision bigint NOT NULL CHECK(session_context_revision>=0),
  cancel_revision bigint NOT NULL CHECK(cancel_revision>=0), active_turn_ref text,
  PRIMARY KEY(snapshot_id,session_id),
  FOREIGN KEY(snapshot_id,runtime_unit_id) REFERENCES snapshot_manifests(id,runtime_unit_id),
  FOREIGN KEY(runtime_unit_id,session_id) REFERENCES runtime_members
);
CREATE TRIGGER keep_storage_seal BEFORE UPDATE OR DELETE ON storage_seals FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
