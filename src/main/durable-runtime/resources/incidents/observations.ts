import { DurableDatabaseError, type DurableTransaction } from '../../db/connection.ts'
import type { FailureObservationRow, FailureIncidentObservationRow } from '../../db/rows.ts'
import type { IncidentId } from '../../../../shared/durable-runtime/identity.ts'
import type { PreparedIncidentInput } from './prepare.ts'
import type { OriginalObservationProvenance } from '../evidence/types.ts'
import { originalEvidenceMatches } from '../evidence/normalize.ts'

export async function recordObservation(tx: DurableTransaction, input: PreparedIncidentInput): Promise<{
  row: FailureObservationRow; inserted: boolean
}> {
  const p = input.observation; const o = p.input; const t = o.target; const c = o.counterTransition
  // The digest includes the whole normalized projection; original runtime event
  // and target tuple are compared separately, not inferred from a caller claim.
  const evidence = JSON.stringify(o)
  const inserted = await tx.query<FailureObservationRow>(
    `INSERT INTO durable_runtime.failure_observations
     (id,source_dedup_key,runtime_event_id,runtime_unit_id,attempt_id,pod_uid,execution_epoch,
      container_name,container_id,incarnation,termination_finished_at,counter_kind,counter_previous,counter_current,
      source_kind,source_ref,schema_version,observed_at,evidence,evidence_digest)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT DO NOTHING RETURNING *`,
    [o.observationId, o.sourceDedupKey, input.runtimeEventId, t.runtimeUnitId, t.attemptId, t.podUid,
      t.executionEpoch, t.containerName, t.runtimeContainerId, t.incarnation, p.finishedTime?.original ?? null,
      c?.counter ?? null, c?.previous ?? null, c?.current ?? null, o.sourceKind, o.sourceRef,
      p.schemaVersion, p.observedTime.original, evidence, p.payloadDigest])
  if (inserted.rows[0]) { return { row: inserted.rows[0], inserted: true } }
  const found = await tx.query<FailureObservationRow>(
    'SELECT * FROM durable_runtime.failure_observations WHERE source_dedup_key=$1 OR id=$2',
    [o.sourceDedupKey, o.observationId])
  const row = found.rows[0]
  if (found.rows.length !== 1 || !row || row.id !== o.observationId || row.source_dedup_key !== o.sourceDedupKey ||
      row.evidence_digest !== p.payloadDigest || row.runtime_event_id !== input.runtimeEventId ||
      row.runtime_unit_id !== t.runtimeUnitId || row.attempt_id !== t.attemptId || row.pod_uid !== t.podUid ||
      row.execution_epoch !== t.executionEpoch) { throw new DurableDatabaseError('INCIDENT_SOURCE_CONFLICT') }
  return { row, inserted: false }
}

export async function linkObservation(tx: DurableTransaction, observationId: string,
  incidentId: IncidentId, input: PreparedIncidentInput, provenance?: OriginalObservationProvenance): Promise<void> {
  const t = input.observation.input.target
  const original = await tx.query<FailureObservationRow>(
    'SELECT * FROM durable_runtime.failure_observations WHERE id=$1', [observationId])
  const row = original.rows[0]
  // Linking a previously unresolved observation needs an explicit verified
  // correlation to its original source and an exact alias/target. The same Pod,
  // nearby time, or arbitrary observation ID list never provides this proof.
  if (observationId !== input.observation.input.observationId && (!input.verifiedSource || !provenance ||
      row?.source_ref !== provenance.sourceRef || !originalEvidenceMatches(input.observation, provenance))) {
    throw new DurableDatabaseError('INCIDENT_LINK_PROOF_REQUIRED')
  }
  if (!row || row.runtime_unit_id !== t.runtimeUnitId || row.attempt_id !== t.attemptId ||
      row.pod_uid !== t.podUid || row.execution_epoch !== t.executionEpoch ||
      (row.container_id !== null && row.container_id !== t.runtimeContainerId) ||
      (row.incarnation !== null && row.incarnation !== t.incarnation)) {
    throw new DurableDatabaseError('INCIDENT_OBSERVATION_BINDING_CONFLICT')
  }
  await tx.query(`INSERT INTO durable_runtime.failure_incident_observations
    (observation_id,incident_id,runtime_unit_id,attempt_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
  [observationId, incidentId, t.runtimeUnitId, t.attemptId])
  const linked = await tx.query<FailureIncidentObservationRow>(
    'SELECT * FROM durable_runtime.failure_incident_observations WHERE observation_id=$1', [observationId])
  if (linked.rows[0]?.incident_id !== incidentId) { throw new DurableDatabaseError('INCIDENT_OBSERVATION_CONFLICT') }
}
