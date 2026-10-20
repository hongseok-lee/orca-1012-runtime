SET LOCAL search_path = durable_runtime, pg_catalog;
-- Separate physical process exit from successful OAuth rotation. An account
-- may not start another rotation while an earlier native owner is unconfirmed.
ALTER TABLE managed_codex_account_rotations ADD COLUMN native_stopped_at timestamptz;
UPDATE managed_codex_account_rotations SET native_stopped_at=completed_at WHERE state='COMPLETED';
