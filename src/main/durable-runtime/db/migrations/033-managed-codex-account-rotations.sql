SET LOCAL search_path = durable_runtime, pg_catalog;
-- Rotation lineage only. Credential bytes and token digests never enter PG.
CREATE TABLE managed_codex_account_rotations (
  scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 512),
  account_key text NOT NULL CHECK (length(account_key) BETWEEN 1 AND 512),
  source_revision text NOT NULL CHECK (source_revision ~ '^[0-9]+:[0-9]+:[0-9]+:[0-9]+$'),
  claim_id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('STARTED','COMPLETED')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (scope,account_key,source_revision),
  CHECK ((state='STARTED' AND completed_at IS NULL) OR (state='COMPLETED' AND completed_at IS NOT NULL))
);
