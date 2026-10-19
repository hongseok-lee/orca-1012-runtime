SET LOCAL search_path = durable_runtime, pg_catalog;

-- A physical retry may need another immutable Pod plan/name. Its budget stays
-- on the original WAKE operation, never on a process or the new child operation.
ALTER TABLE operations
  ADD COLUMN recovery_root_id uuid,
  ADD COLUMN recovery_anchor_attempt_id uuid,
  ADD COLUMN retry_count bigint NOT NULL DEFAULT 0 CHECK(retry_count>=0),
  ADD COLUMN retry_limit bigint CHECK(retry_limit>0),
  ADD COLUMN retry_claimed_at timestamptz,
  ADD COLUMN retry_owner text,
  ADD COLUMN retry_owner_term bigint,
  ADD COLUMN retry_accounted_at timestamptz,
  ADD COLUMN retry_exhausted_reason text,
  ADD COLUMN recovery_resolved_at timestamptz,
  ADD FOREIGN KEY(recovery_root_id,runtime_unit_id) REFERENCES operations(id,runtime_unit_id) DEFERRABLE INITIALLY DEFERRED,
  ADD FOREIGN KEY(recovery_anchor_attempt_id,runtime_unit_id) REFERENCES attempts(id,runtime_unit_id),
  ADD CHECK((recovery_root_id IS NULL AND recovery_anchor_attempt_id IS NULL AND retry_limit IS NULL)
    OR (kind='WAKE' AND recovery_root_id IS NOT NULL AND retry_limit IS NOT NULL
      AND ((deadline_at IS NOT NULL AND isfinite(deadline_at)) OR retry_exhausted_reason='REWAKE_DEADLINE_UNAVAILABLE')));

-- The root operation is the incident identity. NULL anchor supports an initial
-- WAKE before any READY; later READY attempts distinguish independent losses.
CREATE UNIQUE INDEX one_recovery_budget_per_ready_attempt
  ON operations(runtime_unit_id,coalesce(recovery_anchor_attempt_id,'00000000-0000-0000-0000-000000000000'::uuid))
  WHERE recovery_root_id=id;
CREATE INDEX unfinished_recovery_operations ON operations(controller_scope,retry_accounted_at)
  WHERE recovery_root_id IS NOT NULL;

CREATE FUNCTION retain_operation_recovery_budget() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
DECLARE root durable_runtime.operations;
BEGIN
  IF TG_OP='UPDATE' AND OLD.recovery_root_id IS NOT NULL THEN
    IF NEW.recovery_root_id IS DISTINCT FROM OLD.recovery_root_id
      OR NEW.recovery_anchor_attempt_id IS DISTINCT FROM OLD.recovery_anchor_attempt_id
      OR NEW.retry_limit IS DISTINCT FROM OLD.retry_limit OR NEW.retry_count<OLD.retry_count
      OR (OLD.deadline_at IS NOT NULL AND (NEW.deadline_at IS NULL OR NEW.deadline_at>OLD.deadline_at))
      OR (OLD.retry_claimed_at IS NOT NULL AND NEW.retry_claimed_at IS DISTINCT FROM OLD.retry_claimed_at)
      OR (OLD.retry_owner IS NOT NULL AND NEW.retry_owner IS DISTINCT FROM OLD.retry_owner)
      OR (OLD.retry_owner_term IS NOT NULL AND NEW.retry_owner_term IS DISTINCT FROM OLD.retry_owner_term)
      OR (OLD.retry_accounted_at IS NOT NULL AND NEW.retry_accounted_at IS DISTINCT FROM OLD.retry_accounted_at)
      OR (OLD.retry_exhausted_reason IS NOT NULL AND NEW.retry_exhausted_reason IS DISTINCT FROM OLD.retry_exhausted_reason) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Original recovery lineage, deadline and spent budget are retained';
    END IF;
  END IF;
  IF NEW.recovery_root_id IS NOT NULL AND NEW.recovery_root_id<>NEW.id THEN
    SELECT * INTO root FROM operations WHERE id=NEW.recovery_root_id AND runtime_unit_id=NEW.runtime_unit_id;
    IF NOT FOUND OR root.recovery_root_id IS DISTINCT FROM root.id
      OR NEW.recovery_anchor_attempt_id IS DISTINCT FROM root.recovery_anchor_attempt_id
      OR NEW.retry_limit IS DISTINCT FROM root.retry_limit OR NEW.deadline_at IS DISTINCT FROM root.deadline_at THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Child wake inherits the original recovery budget and deadline';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER retain_operation_recovery_budget BEFORE INSERT OR UPDATE ON operations
  FOR EACH ROW EXECUTE FUNCTION retain_operation_recovery_budget();
