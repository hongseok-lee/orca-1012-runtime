import type { Pool } from 'pg'
import { runDurableMutation, type JsonValue, type MutationOutcome } from '../../db/atomic.ts'
import { DurableDatabaseError, type DurableTransaction } from '../../db/connection.ts'
import type { FailureIncidentStateRow, FailureObservationRow } from '../../db/rows.ts'
import { classifyFailureEvidence } from '../evidence/classify.ts'
import { prepareFailureObservation, snapshotJson } from '../evidence/normalize.ts'
import type { FailureObservationInput } from '../evidence/types.ts'
import { prepareIncidentInput, snapshotPreparedIncident, requireIncidentUnitLock } from './prepare.ts'
import type { IncidentIngressInput, PreparedIncidentInput } from './prepare.ts'
import { findIncident } from './aliases.ts'
import { recordObservation, linkObservation } from './observations.ts'
import { writeIncidentArtifacts } from './artifacts.ts'
import type { RecordFailureResult } from './types.ts'

async function executionBinding(tx: DurableTransaction, input: PreparedIncidentInput): Promise<boolean> {
  const t = input.observation.input.target
  const result = await tx.query<{ active_attempt_id: string | null; execution_epoch: string; incarnation: string | null }>(
    `SELECT u.active_attempt_id,u.execution_epoch,a.incarnation FROM durable_runtime.runtime_units u
     JOIN durable_runtime.attempts a ON a.runtime_unit_id=u.id
     WHERE u.id=$1 AND a.id=$2 AND a.execution_epoch=$3 AND a.pod_uid=$4`,
    [t.runtimeUnitId, t.attemptId, t.executionEpoch, t.podUid])
  const row = result.rows[0]
  if (!row || (t.incarnation !== null && row.incarnation !== t.incarnation)) {
    throw new DurableDatabaseError('INCIDENT_BINDING_CONFLICT')
  }
  if (input.runtimeEventId !== null) {
    const original = await tx.query<{ runtime_unit_id: string; attempt_id: string; pod_uid: string; execution_epoch: string; incarnation: string }>(
      `SELECT p.runtime_unit_id,p.attempt_id,p.pod_uid,p.execution_epoch,p.incarnation
       FROM durable_runtime.runtime_event_queue q JOIN durable_runtime.runtime_event_producers p
       ON p.producer_id=q.producer_id AND p.incarnation=q.incarnation WHERE q.event_id=$1`, [input.runtimeEventId])
    const event = original.rows[0]
    if (!event || event.runtime_unit_id !== t.runtimeUnitId || event.attempt_id !== t.attemptId ||
        event.pod_uid !== t.podUid || event.execution_epoch !== t.executionEpoch ||
        (t.incarnation !== null && event.incarnation !== t.incarnation)) {
      throw new DurableDatabaseError('INCIDENT_EVENT_BINDING_CONFLICT')
    }
    const targets = await tx.query<{ session_id: string }>(
      'SELECT session_id FROM durable_runtime.runtime_event_targets WHERE event_id=$1 ORDER BY session_id', [input.runtimeEventId])
    if (JSON.stringify(targets.rows.map(r => r.session_id)) !== JSON.stringify(input.sessionIds)) {
      throw new DurableDatabaseError('INCIDENT_EVENT_TARGET_CONFLICT')
    }
  }
  return row.active_attempt_id === t.attemptId && row.execution_epoch === t.executionEpoch
}

export async function recordFailureEvidence(tx: DurableTransaction, request: PreparedIncidentInput): Promise<RecordFailureResult> {
  const input = snapshotPreparedIncident(request)
  requireIncidentUnitLock(tx, input)
  const p = input.observation; const o = p.input; const t = o.target
  const current = await executionBinding(tx, input)
  const observation = await recordObservation(tx, input)
  const base = { observationId: o.observationId, currentExecution: current }
  if (!p.canonicalKey || p.resolution !== 'RESOLVED' || !input.verifiedSource) {
    if (observation.inserted) {
      await writeIncidentArtifacts(tx, { actorId: input.receiptKey.principalId, unitId: t.runtimeUnitId,
        attemptId: t.attemptId, podUid: t.podUid, kind: 'RESOURCE_FAILURE_OBSERVED', reason: 'TARGET_UNRESOLVED',
        revision: '0', evidenceIds: [o.observationId], previous: null,
        next: { observationId: o.observationId, incidentId: null, currentExecution: current,
          issues: [...p.issues], authority: 'DATA_ONLY' } })
    }
    return { ...base, status: 'OBSERVATION_ONLY', incidentId: null, classification: null,
      revision: null, state: null, reason: p.issues.includes('SOURCE_UNVERIFIED') ? 'SOURCE_UNVERIFIED' : 'TARGET_UNRESOLVED' }
  }
  const { row: incident, created } = await findIncident(tx, input)
  const previous = (await tx.query<FailureIncidentStateRow & { due: boolean }>(
    'SELECT *,deadline_at<=clock_timestamp() AS due FROM durable_runtime.failure_incident_state WHERE incident_id=$1 FOR UPDATE', [incident.id])).rows[0]
  // An already-stored source can supply newly proven links, but never rewrite
  // original observation JSON or reset the collection deadline.
  const linksBefore = await tx.query<{ observation_id: string }>(
    'SELECT observation_id FROM durable_runtime.failure_incident_observations WHERE incident_id=$1', [incident.id])
  const knownIds = new Set(linksBefore.rows.map(r => r.observation_id))
  const linking = [o.observationId, ...input.linkObservations.map(link => link.observationId)]
  await linkObservation(tx, o.observationId, incident.id, input)
  for (const link of input.linkObservations) { await linkObservation(tx, link.observationId, incident.id, input, link.provenance) }
  if (!created && !observation.inserted && linking.every(id => knownIds.has(id))) {
    if (!previous) { throw new DurableDatabaseError('INCIDENT_STATE_MISSING') }
    return { ...base, status: 'REPLAYED', incidentId: incident.id, classification: incident.classification,
      revision: previous.revision, state: previous.state, reason: previous.reason }
  }
  const originals = await tx.query<FailureObservationRow>(
    `SELECT o.* FROM durable_runtime.failure_observations o JOIN durable_runtime.failure_incident_observations l
     ON l.observation_id=o.id WHERE l.incident_id=$1 ORDER BY o.id`, [incident.id])
  const normalized = originals.rows.map(row => {
    const raw = snapshotJson(row.evidence)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { throw new DurableDatabaseError('INCIDENT_EVIDENCE_SHAPE') }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Immutable schema-versioned PG projection is revalidated completely by the evidence owner's normalizer.
    return prepareFailureObservation(raw as unknown as FailureObservationInput)
  }).filter(value => value.resolution === 'RESOLVED')
  const classification = classifyFailureEvidence(normalized)
  const expired = previous ? (await tx.query<{ due: boolean }>(
    'SELECT deadline_at<=clock_timestamp() AS due FROM durable_runtime.failure_incident_state WHERE incident_id=$1',
    [incident.id])).rows[0].due : false
  const unknown = classification.classification === 'UNKNOWN_MEMORY_FAILURE'
  const deadlineBlocked = previous?.reason === 'RESOURCE_EVIDENCE_DEADLINE' ||
    (expired && (previous?.state === 'COLLECTING' || unknown))
  const state = deadlineBlocked || !current ? 'BLOCKED' : unknown ? 'COLLECTING' : 'CLASSIFIED'
  const reason = deadlineBlocked ? 'RESOURCE_EVIDENCE_DEADLINE' : !current ? 'STALE_EXECUTION' : classification.conflicts.length ? 'RESOURCE_EVIDENCE_CONFLICT' : null
  const ids = originals.rows.map(row => row.id)
  await tx.query('UPDATE durable_runtime.failure_incidents SET classification=$2,evidence_refs=$3::jsonb WHERE id=$1',
    [incident.id, classification.classification, JSON.stringify(ids)])
  let next: FailureIncidentStateRow
  if (!previous) {
    next = (await tx.query<FailureIncidentStateRow>(
      `WITH first_seen AS (SELECT clock_timestamp() AS started_at)
       INSERT INTO durable_runtime.failure_incident_state
       (incident_id,runtime_unit_id,attempt_id,execution_epoch,collection_started_at,deadline_at,state,reason,classification_revision,evidence_ids)
       SELECT $1,$2,$3,$4,started_at,started_at+$5::double precision*interval '1 millisecond',$6,$7,1,$8::text[]
       FROM first_seen RETURNING *`,
      [incident.id, t.runtimeUnitId, t.attemptId, t.executionEpoch, current ? input.collectionPolicy.budgetMs : 0,
        state, reason, classification.observationIds])).rows[0]
  } else {
    next = (await tx.query<FailureIncidentStateRow>(
      `UPDATE durable_runtime.failure_incident_state SET state=$2,reason=$3,revision=revision+1,
       classification_revision=classification_revision+1,evidence_ids=$4::text[] WHERE incident_id=$1 RETURNING *`,
      [incident.id, state, reason, classification.observationIds])).rows[0]
  }
  const result: RecordFailureResult = { ...base, status: 'RECORDED', incidentId: incident.id,
    classification: classification.classification, revision: next.revision, state: next.state, reason: next.reason }
  await writeIncidentArtifacts(tx, { actorId: input.receiptKey.principalId, unitId: t.runtimeUnitId,
    attemptId: t.attemptId, podUid: t.podUid,
    kind: deadlineBlocked && previous?.reason !== 'RESOURCE_EVIDENCE_DEADLINE' ? 'RESOURCE_EVIDENCE_DEADLINE' : 'RESOURCE_FAILURE_CLASSIFIED',
    reason, revision: next.revision, evidenceIds: ids,
    previous: previous ? { state: previous.state, revision: previous.revision, classification: incident.classification } : null,
    next: { ...result, classificationRevision: next.classification_revision,
      collectionPolicyRevision: input.collectionPolicy.revision, deadlineAt: next.deadline_at.toISOString(),
      classificationReasons: [...classification.reasons], missing: [...classification.missing], conflicts: [...classification.conflicts],
      automaticGrowthCandidate: current && state !== 'BLOCKED' && classification.automaticGrowthCandidate,
      authority: 'DATA_ONLY' } })
  return result
}

export async function ingestFailureEvidence(pool: Pool, request: IncidentIngressInput): Promise<MutationOutcome> {
  const input = prepareIncidentInput(request)
  return runDurableMutation(pool, { key: input.receiptKey, payloadHash: input.payloadHash,
    locks: { sessionIds: input.sessionIds, runtimeUnitIds: [input.observation.input.target.runtimeUnitId] } },
  async tx => ({ ...await recordFailureEvidence(tx, input) } satisfies JsonValue))
}
