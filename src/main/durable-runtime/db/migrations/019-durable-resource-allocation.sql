SET LOCAL search_path = durable_runtime, pg_catalog;

CREATE TABLE resource_policy_versions (
  policy_revision bigint PRIMARY KEY CHECK(policy_revision>=0),
  policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object' AND policy ? 'revision'
    AND jsonb_typeof(policy->'revision')='string' AND policy->>'revision'=policy_revision::text),
  policy_digest text NOT NULL CHECK(policy_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_resource_policy BEFORE UPDATE OR DELETE ON resource_policy_versions
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE resource_budget_scopes (
  scope text PRIMARY KEY CHECK(scope<>''),
  dataset_name text NOT NULL REFERENCES dataset_metadata,
  budget_domain_id text NOT NULL CHECK(budget_domain_id<>''),
  memory_limit_bytes bigint NOT NULL CHECK(memory_limit_bytes>=0),
  cpu_limit_millicores bigint NOT NULL CHECK(cpu_limit_millicores>=0),
  configuration jsonb NOT NULL CHECK(jsonb_typeof(configuration)='object'),
  evidence_ref text NOT NULL CHECK(evidence_ref<>''),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  UNIQUE(dataset_name,budget_domain_id)
);
CREATE FUNCTION guard_resource_budget_scope() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.scope,NEW.dataset_name,NEW.budget_domain_id)
       IS DISTINCT FROM (OLD.scope,OLD.dataset_name,OLD.budget_domain_id)
     OR NEW.revision<OLD.revision OR (NEW IS DISTINCT FROM OLD AND NEW.revision<=OLD.revision) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Budget identity is immutable and configuration changes require an advancing revision';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resource_budget_scope_guard BEFORE UPDATE ON resource_budget_scopes
  FOR EACH ROW EXECUTE FUNCTION guard_resource_budget_scope();
CREATE TRIGGER retain_resource_budget_scope BEFORE DELETE ON resource_budget_scopes
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE UNIQUE INDEX one_unresolved_recovery_episode ON recovery_episodes(runtime_unit_id) WHERE resolved_at IS NULL;
CREATE FUNCTION guard_resource_recovery_episode() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.id,NEW.runtime_unit_id,NEW.trigger_incident_id,NEW.started_at)
       IS DISTINCT FROM (OLD.id,OLD.runtime_unit_id,OLD.trigger_incident_id,OLD.started_at)
     OR NEW.growth_count<OLD.growth_count OR NEW.replacement_count<OLD.replacement_count THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Recovery episode original identity is immutable and counters cannot decrease';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resource_recovery_episode_guard BEFORE UPDATE ON recovery_episodes
  FOR EACH ROW EXECUTE FUNCTION guard_resource_recovery_episode();
CREATE TRIGGER retain_resource_recovery_episode BEFORE DELETE ON recovery_episodes
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE FUNCTION guard_resource_profile_original() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.runtime_unit_id,NEW.revision,NEW.container_resources,NEW.policy_revision,NEW.previous_good_revision)
       IS DISTINCT FROM (OLD.runtime_unit_id,OLD.revision,OLD.container_resources,OLD.policy_revision,OLD.previous_good_revision) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Resource profile original revision, shape and policy are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resource_profile_original_guard BEFORE UPDATE ON resource_profiles
  FOR EACH ROW EXECUTE FUNCTION guard_resource_profile_original();
CREATE TRIGGER retain_resource_profile BEFORE DELETE ON resource_profiles
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE resource_unit_state (
  runtime_unit_id uuid PRIMARY KEY REFERENCES runtime_units,
  budget_scope text NOT NULL REFERENCES resource_budget_scopes(scope),
  approved_profile_revision bigint NOT NULL CHECK(approved_profile_revision>=0),
  desired_profile_revision bigint CHECK(desired_profile_revision IS NULL OR desired_profile_revision>=0),
  policy_revision bigint NOT NULL REFERENCES resource_policy_versions,
  current_episode_id uuid,
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  breaker text NOT NULL CHECK(breaker IN ('CLOSED','OPEN')),
  breaker_reason text CHECK(breaker_reason IS NULL OR breaker_reason<>''),
  last_oom_at timestamptz,
  accounted_memory_bytes bigint NOT NULL CHECK(accounted_memory_bytes>=0),
  accounted_cpu_millicores bigint NOT NULL CHECK(accounted_cpu_millicores>=0),
  accounting_evidence_ref text NOT NULL CHECK(accounting_evidence_ref<>''),
  FOREIGN KEY(runtime_unit_id,approved_profile_revision) REFERENCES resource_profiles,
  FOREIGN KEY(runtime_unit_id,desired_profile_revision) REFERENCES resource_profiles,
  FOREIGN KEY(current_episode_id,runtime_unit_id) REFERENCES recovery_episodes(id,runtime_unit_id),
  UNIQUE(runtime_unit_id,budget_scope),
  CHECK(breaker<>'OPEN' OR breaker_reason IS NOT NULL)
);
CREATE FUNCTION guard_resource_unit_state() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.runtime_unit_id,NEW.budget_scope) IS DISTINCT FROM (OLD.runtime_unit_id,OLD.budget_scope)
     OR NEW.revision<OLD.revision OR (NEW IS DISTINCT FROM OLD AND NEW.revision<=OLD.revision) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Resource head identity is immutable and changes require an advancing revision';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resource_unit_state_guard BEFORE UPDATE ON resource_unit_state
  FOR EACH ROW EXECUTE FUNCTION guard_resource_unit_state();
CREATE TRIGGER retain_resource_unit_state BEFORE DELETE ON resource_unit_state
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE resource_operation_plans (
  operation_id uuid PRIMARY KEY,
  runtime_unit_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('GROW','REPLACE','DOWNSIZE','ROLLBACK')),
  incident_id uuid,
  episode_id uuid,
  attempt_id uuid NOT NULL,
  execution_epoch bigint NOT NULL CHECK(execution_epoch>=0),
  policy_revision bigint NOT NULL REFERENCES resource_policy_versions,
  previous_profile_revision bigint NOT NULL CHECK(previous_profile_revision>=0),
  target_profile_revision bigint NOT NULL CHECK(target_profile_revision>=0),
  intent_revision bigint NOT NULL CHECK(intent_revision>=0),
  workload_profile_key text NOT NULL CHECK(workload_profile_key<>''),
  target_pod_shape jsonb NOT NULL CHECK(jsonb_typeof(target_pod_shape)='object'),
  spec_digest text NOT NULL CHECK(spec_digest ~ '^[0-9a-f]{64}$'),
  facts jsonb NOT NULL CHECK(jsonb_typeof(facts)='object'),
  facts_digest text NOT NULL CHECK(facts_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  downsize_original_operation_id uuid,
  observation_window_ref text CHECK(observation_window_ref IS NULL OR observation_window_ref<>''),
  FOREIGN KEY(operation_id,runtime_unit_id) REFERENCES operations(id,runtime_unit_id),
  FOREIGN KEY(incident_id,runtime_unit_id) REFERENCES failure_incidents(id,runtime_unit_id),
  FOREIGN KEY(episode_id,runtime_unit_id) REFERENCES recovery_episodes(id,runtime_unit_id),
  FOREIGN KEY(attempt_id,runtime_unit_id,execution_epoch) REFERENCES attempts(id,runtime_unit_id,execution_epoch),
  FOREIGN KEY(runtime_unit_id,previous_profile_revision) REFERENCES resource_profiles,
  FOREIGN KEY(runtime_unit_id,target_profile_revision) REFERENCES resource_profiles,
  FOREIGN KEY(downsize_original_operation_id,runtime_unit_id) REFERENCES operations(id,runtime_unit_id),
  UNIQUE(operation_id,runtime_unit_id,episode_id,kind),
  UNIQUE(operation_id,runtime_unit_id,target_profile_revision)
);
CREATE UNIQUE INDEX one_resource_plan_per_incident ON resource_operation_plans(incident_id) WHERE incident_id IS NOT NULL;
CREATE TRIGGER immutable_resource_operation_plan BEFORE UPDATE OR DELETE ON resource_operation_plans
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE resource_growth_ledger (
  operation_id uuid PRIMARY KEY,
  runtime_unit_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  charge_kind text NOT NULL CHECK(charge_kind IN ('GROW','REPLACE')),
  charged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(operation_id,runtime_unit_id,episode_id,charge_kind)
    REFERENCES resource_operation_plans(operation_id,runtime_unit_id,episode_id,kind)
);
CREATE TRIGGER immutable_resource_growth_charge BEFORE UPDATE OR DELETE ON resource_growth_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

ALTER TABLE resource_reservations ADD UNIQUE(operation_id,runtime_unit_id,resource_profile_revision);
CREATE FUNCTION guard_resource_reservation_original() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
BEGIN
  IF (NEW.operation_id,NEW.runtime_unit_id,NEW.resource_profile_revision,NEW.resource_delta,NEW.expires_at)
       IS DISTINCT FROM (OLD.operation_id,OLD.runtime_unit_id,OLD.resource_profile_revision,OLD.resource_delta,OLD.expires_at) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Reservation original identity, demand and expiry are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resource_reservation_original_guard BEFORE UPDATE ON resource_reservations
  FOR EACH ROW EXECUTE FUNCTION guard_resource_reservation_original();
CREATE TRIGGER retain_resource_reservation BEFORE DELETE ON resource_reservations
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE TABLE resource_reservation_accounting (
  operation_id uuid PRIMARY KEY,
  runtime_unit_id uuid NOT NULL,
  resource_profile_revision bigint NOT NULL CHECK(resource_profile_revision>=0),
  budget_scope text NOT NULL,
  steady_memory_bytes bigint NOT NULL CHECK(steady_memory_bytes>=0),
  steady_cpu_millicores bigint NOT NULL CHECK(steady_cpu_millicores>=0),
  overlap_memory_bytes bigint NOT NULL CHECK(overlap_memory_bytes>=0),
  overlap_cpu_millicores bigint NOT NULL CHECK(overlap_cpu_millicores>=0),
  protected_memory_bytes bigint NOT NULL CHECK(protected_memory_bytes>=0),
  protected_cpu_millicores bigint NOT NULL CHECK(protected_cpu_millicores>=0),
  additional_memory_charge_bytes bigint NOT NULL CHECK(additional_memory_charge_bytes>=0),
  additional_cpu_charge_millicores bigint NOT NULL CHECK(additional_cpu_charge_millicores>=0),
  facts jsonb NOT NULL CHECK(jsonb_typeof(facts)='object'),
  facts_digest text NOT NULL CHECK(facts_digest ~ '^[0-9a-f]{64}$'),
  spec_digest text NOT NULL CHECK(spec_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(operation_id,runtime_unit_id,resource_profile_revision)
    REFERENCES resource_reservations(operation_id,runtime_unit_id,resource_profile_revision),
  FOREIGN KEY(operation_id,runtime_unit_id,resource_profile_revision)
    REFERENCES resource_operation_plans(operation_id,runtime_unit_id,target_profile_revision),
  FOREIGN KEY(runtime_unit_id,budget_scope) REFERENCES resource_unit_state(runtime_unit_id,budget_scope)
);
CREATE TRIGGER immutable_resource_reservation_accounting BEFORE UPDATE OR DELETE ON resource_reservation_accounting
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

-- No policy/budget/head seed or admission claim is made here. Existing profile0 is unchanged.
-- Charges and episode increments are one consumer transaction: GROW adds growth+replacement,
-- REPLACE adds replacement only. Rolling24h uses charged_at, not a resettable counter.
-- Scope rank11 and current lease/intent/admission/capacity checks are consumer entry contracts.
