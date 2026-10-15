SET LOCAL search_path = durable_runtime, pg_catalog;

-- Nullable, not-yet-assigned historical attempts remain untouched.
ALTER TABLE attempts ADD CONSTRAINT attempt_execution_target_identity_unique
  UNIQUE(id,runtime_unit_id,execution_epoch,pod_uid,incarnation);

CREATE TABLE execution_target_records (
  attempt_id uuid PRIMARY KEY,
  runtime_unit_id uuid NOT NULL,
  execution_epoch bigint NOT NULL CHECK(execution_epoch>=0),
  pod_uid text NOT NULL CHECK(btrim(pod_uid)<>''),
  incarnation text NOT NULL CHECK(btrim(incarnation)<>''),
  cluster_identity_ref text NOT NULL CHECK(btrim(cluster_identity_ref)<>''),
  namespace text NOT NULL CHECK(btrim(namespace)<>''),
  pod_name text NOT NULL CHECK(btrim(pod_name)<>''),
  pod_resource_version text NOT NULL CHECK(btrim(pod_resource_version)<>''),
  node_name text NOT NULL CHECK(btrim(node_name)<>''),
  node_uid text NOT NULL CHECK(btrim(node_uid)<>''),
  node_resource_version text NOT NULL CHECK(btrim(node_resource_version)<>''),
  project_id text NOT NULL CHECK(btrim(project_id)<>''),
  project_number text NOT NULL CHECK(project_number ~ '^[1-9][0-9]*$'),
  zone text NOT NULL CHECK(btrim(zone)<>''),
  instance_name text NOT NULL CHECK(btrim(instance_name)<>''),
  numeric_instance_id text NOT NULL CHECK(numeric_instance_id ~ '^[1-9][0-9]*$'),
  compute_identity_ref text NOT NULL CHECK(btrim(compute_identity_ref)<>''),
  observed_at timestamptz NOT NULL CHECK(isfinite(observed_at)),
  kubernetes_evidence_ref text NOT NULL CHECK(btrim(kubernetes_evidence_ref)<>''),
  compute_identity_evidence_ref text NOT NULL CHECK(btrim(compute_identity_evidence_ref)<>''),
  observation_digest text NOT NULL CHECK(observation_digest ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(attempt_id,runtime_unit_id,execution_epoch,pod_uid,incarnation)
    REFERENCES attempts(id,runtime_unit_id,execution_epoch,pod_uid,incarnation),
  UNIQUE(cluster_identity_ref,pod_uid,incarnation)
);
CREATE TRIGGER retain_execution_target_records BEFORE UPDATE OR DELETE ON execution_target_records
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
