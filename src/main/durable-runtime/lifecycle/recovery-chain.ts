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
