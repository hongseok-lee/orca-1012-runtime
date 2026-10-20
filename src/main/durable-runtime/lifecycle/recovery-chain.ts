/** SQL alias r denotes one recovery root. Every owner uses the same chain head;
 * historical exhausted predecessors are retained, never selected or mutated. */
export const RECOVERY_CHAIN_HEAD_SQL = `r.recovery_root_id=r.id AND NOT EXISTS(
  SELECT 1 FROM durable_runtime.operations successor WHERE successor.recovery_predecessor_id=r.id)`

/** Only current unfinished recovery work can be planned. Original unresolved
 * commands are retained separately by the takeover reader for truthful lookup. */
export const RECOVERY_OPERATION_CURRENT_SQL = `(o.recovery_root_id IS NULL OR EXISTS(
  SELECT 1 FROM durable_runtime.operations r WHERE r.id=o.recovery_root_id AND ${RECOVERY_CHAIN_HEAD_SQL}))`
export const RECOVERY_OPERATION_PLANNABLE_SQL = `(${RECOVERY_OPERATION_CURRENT_SQL} AND (o.recovery_root_id IS NULL OR EXISTS(
  SELECT 1 FROM durable_runtime.operations r WHERE r.id=o.recovery_root_id
    AND r.retry_exhausted_reason IS NULL AND r.recovery_resolved_at IS NULL)))`

/** A committed manual wake is demand even with no replayable input. It never
 * changes a message receipt or authorizes replay of an UNKNOWN dispatch. */
export function manualWakeDemandSql(unit:'u.id'|'$1'):string {
  return `EXISTS(SELECT 1 FROM durable_runtime.operations r
    JOIN durable_runtime.runtime_units manual_unit ON manual_unit.id=r.runtime_unit_id
    WHERE r.runtime_unit_id=${unit} AND r.kind='WAKE'
      AND (r.recovery_root_id IS NULL OR (${RECOVERY_CHAIN_HEAD_SQL}))
      AND (r.recovery_manual_receipt IS NOT NULL OR EXISTS(
        SELECT 1 FROM durable_runtime.rpc_receipts receipt
        WHERE receipt.method='lifecycle.request-unit-intent'
          AND receipt.session_scope LIKE 'ops:%:runtime-unit:'||r.runtime_unit_id::text
          AND receipt.response->>'operationId'=r.id::text))
      AND (r.result IS NULL OR r.recovery_root_id=r.id AND r.result->>'state'='FAILED')
      AND r.recovery_resolved_at IS NULL
      AND r.retry_exhausted_reason IS NULL AND r.deadline_at>clock_timestamp()
      AND r.intent_revision=manual_unit.intent_revision AND manual_unit.desired_mode='RUNNING')`
}
