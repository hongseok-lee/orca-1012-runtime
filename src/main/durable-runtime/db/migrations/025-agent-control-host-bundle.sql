SET LOCAL search_path = durable_runtime, pg_catalog;

-- The control bundle a host runs is fixed by the sha256 its bridge verifies;
-- a later backend must exec the SAME bundle to re-attach. Rows recorded
-- before this column carry NULL and are adopted only with the configured bundle.
ALTER TABLE agent_control_hosts ADD COLUMN control_sha256 text CHECK (control_sha256 ~ '^[0-9a-f]{64}$');
