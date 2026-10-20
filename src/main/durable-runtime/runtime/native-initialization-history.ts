/** Evaluated under the existing Session/Unit cold-permit locks. A new native
 * generation can discard only empty initialization, never possible input.
 * $1 unit, $2 new attempt, $3 session, $4 cold command, $5 initialization proof. */
export const nativeInitializationHistorySql=`SELECT id FROM durable_runtime.attempts WHERE runtime_unit_id=$1 AND id<>$2 AND stopped_at IS NULL
  UNION ALL SELECT id FROM durable_runtime.provider_context_deliveries WHERE session_id=$3
  UNION ALL SELECT id FROM durable_runtime.messages WHERE session_id=$3
    AND intake_status IN ('EFFECT_POSSIBLE','ADMITTED','SETTLED','UNKNOWN','INTERRUPTED')
  UNION ALL SELECT id FROM durable_runtime.delivery_attempts WHERE session_id=$3
    AND (provider_ref IS NOT NULL OR state IN ('EFFECT_POSSIBLE','ADMITTED','SETTLED','UNKNOWN','INTERRUPTED'))
  UNION ALL SELECT id FROM durable_runtime.runtime_commands WHERE runtime_unit_id=$1
    AND command_name='releaseGate' AND id<>$4
    AND NOT EXISTS(SELECT 1 FROM durable_runtime.runtime_audit_events e
      WHERE e.kind='INITIAL_NATIVE_CHECKPOINT_GUARDED' AND e.attempt_id::text=runtime_commands.input->>'attemptId'
      AND e.next_state->>'protocolVersion' IN ('1','2'))
  UNION ALL SELECT id FROM durable_runtime.runtime_audit_events WHERE runtime_unit_id=$1
    AND kind IN ('INITIAL_PROVIDER_NATIVE_OBSERVED','INITIAL_PROVIDER_READY') AND $5::jsonb IS NULL
  UNION ALL SELECT $2::uuid WHERE NOT EXISTS(SELECT 1 FROM durable_runtime.runtime_audit_events e
    WHERE e.attempt_id=$2 AND e.kind='INITIAL_NATIVE_CHECKPOINT_GUARDED'
    AND e.next_state->>'source'='AUTHENTICATED_AGENT_HOME'
    AND ((e.next_state->>'state'='NONE' AND $5::jsonb IS NULL)
      OR (e.next_state->>'protocolVersion'='2' AND e.next_state->>'state' IN ('PROVISIONAL','UNBOUND')
        AND e.next_state->>'inputState'='NOT_STARTED' AND $5::jsonb IS NOT NULL
        AND e.next_state->'initialization'=$5::jsonb)))`
