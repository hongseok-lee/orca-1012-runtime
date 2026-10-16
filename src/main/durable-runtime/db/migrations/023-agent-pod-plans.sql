SET LOCAL search_path = durable_runtime, pg_catalog;

-- An immutable UNAUTHORIZED_PLAN, not an actual attempt, Pod or grant.
CREATE TABLE agent_pod_plans (
  operation_id uuid PRIMARY KEY,
  runtime_unit_id uuid NOT NULL,
  dataset_name text NOT NULL REFERENCES dataset_metadata,
  attempt_id uuid NOT NULL UNIQUE,
  execution_epoch bigint NOT NULL CHECK (execution_epoch >= 0),
  intent_revision bigint NOT NULL CHECK (intent_revision >= 0),
  namespace text NOT NULL CHECK (namespace <> ''),
  resource_name text NOT NULL CHECK (resource_name <> ''),
  spec_hash text NOT NULL CHECK (spec_hash ~ '^[0-9a-f]{64}$'),
  pod_spec_sha256 text NOT NULL CHECK (pod_spec_sha256 ~ '^[0-9a-f]{64}$'),
  plan_digest text NOT NULL CHECK (plan_digest ~ '^[0-9a-f]{64}$'),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan)='object'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  FOREIGN KEY (operation_id,runtime_unit_id) REFERENCES operations(id,runtime_unit_id),
  CHECK (plan ?& ARRAY['kind','identity','pod','mountExpectations','podSpecSHA256',
    'readinessObserved','storageGrantIssued','physicalPinIssued']),
  CHECK (plan->>'kind'='UNAUTHORIZED_PLAN' AND plan->'readinessObserved'='false'::jsonb
    AND plan->'storageGrantIssued'='false'::jsonb AND plan->'physicalPinIssued'='false'::jsonb),
  CHECK (jsonb_typeof(plan->'identity')='object' AND
    (plan->'identity') ?& ARRAY['unitId','operationId','attemptId','executionEpoch','intentRevision','resourceName','specHash']),
  CHECK (plan->'identity'->>'unitId'=runtime_unit_id::text
    AND plan->'identity'->>'operationId'=operation_id::text
    AND plan->'identity'->>'attemptId'=attempt_id::text
    AND plan->'identity'->>'executionEpoch'=execution_epoch::text
    AND plan->'identity'->>'intentRevision'=intent_revision::text
    AND plan->'identity'->>'resourceName'=resource_name
    AND plan->'identity'->>'specHash'=spec_hash AND plan->>'podSpecSHA256'=pod_spec_sha256)
);
CREATE TRIGGER retain_agent_pod_plans BEFORE UPDATE OR DELETE ON agent_pod_plans
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
