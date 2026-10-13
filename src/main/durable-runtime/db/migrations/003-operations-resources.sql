SET LOCAL search_path = durable_runtime, pg_catalog;
CREATE TABLE controller_leases (
  scope text PRIMARY KEY CHECK(scope<>''), owner text NOT NULL,
  term bigint NOT NULL CHECK(term>=0), expires_at timestamptz NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0)
);
CREATE TABLE operations (
  id uuid PRIMARY KEY, runtime_unit_id uuid NOT NULL REFERENCES runtime_units,
  kind text NOT NULL, intent_revision bigint NOT NULL CHECK(intent_revision>=0),
  controller_scope text NOT NULL REFERENCES controller_leases,
  controller_term bigint NOT NULL CHECK(controller_term>=0),
  step text NOT NULL, step_revision bigint NOT NULL DEFAULT 0 CHECK(step_revision>=0),
  expected_pod_uid text, execution_epoch bigint NOT NULL CHECK(execution_epoch>=0),
  external_resource_name text, deadline_at timestamptz, retry_at timestamptz,
  result jsonb, revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  UNIQUE(id,runtime_unit_id)
);
CREATE TABLE resource_profiles (
  runtime_unit_id uuid NOT NULL REFERENCES runtime_units,
  revision bigint NOT NULL CHECK(revision>=0), container_resources jsonb NOT NULL,
  learned_memory_floor bigint CHECK(learned_memory_floor>=0), floor_protected_until timestamptz,
  previous_good_revision bigint, policy_revision bigint NOT NULL CHECK(policy_revision>=0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(runtime_unit_id,revision),
  FOREIGN KEY(runtime_unit_id,previous_good_revision) REFERENCES resource_profiles
);
ALTER TABLE attempts ADD FOREIGN KEY(runtime_unit_id,resource_profile_revision) REFERENCES resource_profiles DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE memory_rightsizing_state (
  runtime_unit_id uuid PRIMARY KEY REFERENCES runtime_units,
  workload_profile_key text NOT NULL, observation_window_ref text,
  last_resize_at timestamptz, downsize_blocked_until timestamptz,
  failed_downsize_targets jsonb NOT NULL DEFAULT '[]', pending_operation_id uuid,
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  FOREIGN KEY(pending_operation_id,runtime_unit_id) REFERENCES operations(id,runtime_unit_id)
);
CREATE TABLE failure_incidents (
  id uuid PRIMARY KEY, runtime_unit_id uuid NOT NULL REFERENCES runtime_units,
  attempt_id uuid NOT NULL, pod_uid text NOT NULL, container_id text NOT NULL,
  restart_identity text NOT NULL, evidence_key text NOT NULL UNIQUE,
  classification text NOT NULL, evidence_refs jsonb NOT NULL,
  observed_at timestamptz NOT NULL, recovery_episode_id uuid,
  FOREIGN KEY(attempt_id,runtime_unit_id) REFERENCES attempts(id,runtime_unit_id),
  UNIQUE(id,runtime_unit_id)
);
CREATE TABLE recovery_episodes (
  id uuid PRIMARY KEY, runtime_unit_id uuid NOT NULL REFERENCES runtime_units,
  trigger_incident_id uuid NOT NULL, state text NOT NULL,
  growth_count bigint NOT NULL DEFAULT 0 CHECK(growth_count>=0),
  replacement_count bigint NOT NULL DEFAULT 0 CHECK(replacement_count>=0),
  started_at timestamptz NOT NULL, resolved_at timestamptz,
  FOREIGN KEY(trigger_incident_id,runtime_unit_id) REFERENCES failure_incidents(id,runtime_unit_id),
  UNIQUE(id,runtime_unit_id)
);
ALTER TABLE failure_incidents ADD FOREIGN KEY(recovery_episode_id,runtime_unit_id) REFERENCES recovery_episodes(id,runtime_unit_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE resource_reservations (
  operation_id uuid PRIMARY KEY, runtime_unit_id uuid NOT NULL,
  resource_profile_revision bigint NOT NULL, resource_delta jsonb NOT NULL,
  state text NOT NULL CHECK(state IN ('RESERVED','APPLIED','RELEASED')),
  expires_at timestamptz,
  FOREIGN KEY(operation_id,runtime_unit_id) REFERENCES operations(id,runtime_unit_id),
  FOREIGN KEY(runtime_unit_id,resource_profile_revision) REFERENCES resource_profiles
);
CREATE TABLE observation_episodes (
  id uuid PRIMARY KEY, runtime_unit_id uuid NOT NULL REFERENCES runtime_units,
  attempt_id uuid NOT NULL, execution_epoch bigint NOT NULL,
  start_watermark bigint NOT NULL CHECK(start_watermark>=0),
  started_at timestamptz NOT NULL, deadline_at timestamptz NOT NULL,
  resolved_at timestamptz,
  FOREIGN KEY(attempt_id,runtime_unit_id,execution_epoch) REFERENCES attempts(id,runtime_unit_id,execution_epoch),
  CHECK(deadline_at>=started_at)
);
