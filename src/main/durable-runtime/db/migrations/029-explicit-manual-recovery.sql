SET LOCAL search_path = durable_runtime, pg_catalog;

ALTER TABLE operations
  ADD COLUMN recovery_predecessor_id uuid,
  ADD COLUMN recovery_manual_receipt jsonb,
  ADD FOREIGN KEY(recovery_predecessor_id,runtime_unit_id) REFERENCES operations(id,runtime_unit_id),
  ADD CHECK((recovery_predecessor_id IS NULL AND recovery_manual_receipt IS NULL) OR
    (kind='WAKE' AND recovery_root_id=id AND recovery_predecessor_id<>id AND recovery_manual_receipt IS NOT NULL));

DROP INDEX one_recovery_budget_per_ready_attempt;
-- Automatic input/watchers still have one original incident per READY. A
-- separate explicit manual receipt may create one immutable successor.
CREATE UNIQUE INDEX one_recovery_budget_per_ready_attempt ON operations
  (runtime_unit_id,coalesce(recovery_anchor_attempt_id,'00000000-0000-0000-0000-000000000000'::uuid))
  WHERE recovery_root_id=id AND recovery_predecessor_id IS NULL;
CREATE UNIQUE INDEX one_explicit_recovery_successor ON operations(recovery_predecessor_id)
  WHERE recovery_predecessor_id IS NOT NULL;

CREATE FUNCTION retain_manual_recovery_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.recovery_root_id IS NOT NULL AND
    (NEW.recovery_predecessor_id IS DISTINCT FROM OLD.recovery_predecessor_id OR
      NEW.recovery_manual_receipt IS DISTINCT FROM OLD.recovery_manual_receipt) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Manual recovery origin is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER retain_manual_recovery_link BEFORE UPDATE ON operations
  FOR EACH ROW EXECUTE FUNCTION retain_manual_recovery_link();

-- The receipt is inserted by runDurableMutation after its body, in the SAME
-- transaction. Validate it at COMMIT; a copied operation key alone is no proof.
CREATE FUNCTION require_manual_recovery_receipt() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, durable_runtime, pg_temp AS $$
DECLARE current_row durable_runtime.operations;
BEGIN
  SELECT * INTO current_row FROM operations WHERE id=NEW.id;
  IF current_row.recovery_predecessor_id IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM operations p WHERE p.id=current_row.recovery_predecessor_id
      AND p.runtime_unit_id=current_row.runtime_unit_id AND p.recovery_root_id=p.id
      AND p.retry_exhausted_reason IS NOT NULL) OR
    NOT EXISTS(SELECT 1 FROM rpc_receipts r WHERE
      r.principal_id=current_row.recovery_manual_receipt->>'principalId' AND
      r.session_scope=current_row.recovery_manual_receipt->>'sessionScope' AND
      r.method='lifecycle.request-unit-intent' AND
      r.method=current_row.recovery_manual_receipt->>'method' AND
      r.operation_key=current_row.recovery_manual_receipt->>'operationKey' AND
      r.payload_hash=current_row.recovery_manual_receipt->>'payloadHash' AND
      r.response->>'operationId'=current_row.id::text) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Explicit manual recovery requires original committed wake receipt';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER require_manual_recovery_receipt AFTER INSERT OR UPDATE ON operations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_manual_recovery_receipt();
