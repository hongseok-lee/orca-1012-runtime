import type { Pool } from 'pg'
import { RECOVERY_CHAIN_HEAD_SQL } from '../durable-runtime/lifecycle/recovery-chain.ts'

export async function readRewakeCandidates(pool: Pool) {
    return (await pool.query<{ unit_id: string; unit_revision: string; intent_revision: string; session_id: string; provider: 'codex' | 'claude';
      agent_id: string; workspace_id: string; reserved_path: string; launch_request: unknown; binding_id: string; binding_revision: string; binding_epoch: string; canonical_directory: string }>(`
      SELECT u.id AS unit_id,u.revision::text AS unit_revision,u.intent_revision::text,s.id AS session_id,g.provider,g.id AS agent_id,s.workspace_id,
        w.reserved_path,(SELECT tm.launch_request FROM durable_runtime.tabs t
          JOIN durable_runtime.catalog_tab_metadata tm ON tm.tab_id=t.id
          WHERE t.session_id=s.id AND t.kind='terminal' AND t.lifecycle='OPEN' LIMIT 1) AS launch_request,b.id AS binding_id,b.revision::text AS binding_revision,b.epoch::text AS binding_epoch,b.canonical_directory
      FROM durable_runtime.runtime_units u JOIN durable_runtime.runtime_members m ON m.runtime_unit_id=u.id
      JOIN durable_runtime.sessions s ON s.id=m.session_id AND s.lifecycle='OPEN' JOIN durable_runtime.agents g ON g.id=s.agent_id
      JOIN durable_runtime.catalog_workspace_metadata w ON w.workspace_id=s.workspace_id
      JOIN durable_runtime.runtime_member_storage_bindings mb ON mb.runtime_unit_id=u.id AND mb.session_id=s.id
      JOIN durable_runtime.storage_bindings b ON b.id=mb.storage_binding_id
      -- Accepted input that still waits is demand to run, even if fencing suspended the Unit after it arrived.
      WHERE u.desired_mode IN ('RUNNING','SUSPENDED') AND u.active_attempt_id IS NULL AND g.provider IN ('codex','claude')
        AND b.access_state IN ('UNVERIFIED','VERIFIED') AND b.writer_attempt_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM durable_runtime.attempts a WHERE a.runtime_unit_id=u.id AND a.stopped_at IS NULL)
        AND EXISTS(SELECT 1 FROM durable_runtime.messages x WHERE x.session_id=s.id AND x.intake_status='DURABLE' AND x.cancel_revision=0)
        AND NOT EXISTS(SELECT 1 FROM durable_runtime.operations o WHERE o.runtime_unit_id=u.id AND o.kind='WAKE' AND o.result IS NULL
          AND o.step<>'INTENT_QUEUED')
        AND NOT EXISTS(SELECT 1 FROM durable_runtime.operations r WHERE r.runtime_unit_id=u.id AND ${RECOVERY_CHAIN_HEAD_SQL}
          AND r.recovery_anchor_attempt_id IS NOT DISTINCT FROM (SELECT a.id FROM durable_runtime.attempts a WHERE a.runtime_unit_id=u.id AND a.ready_at IS NOT NULL
            ORDER BY a.execution_epoch DESC,a.ready_at DESC,a.id LIMIT 1)
          AND (r.retry_exhausted_reason IS NOT NULL OR (r.retry_at>clock_timestamp() AND r.deadline_at>clock_timestamp())))
      ORDER BY u.id`)).rows
  }
