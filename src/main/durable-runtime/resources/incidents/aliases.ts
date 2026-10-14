import { randomUUID } from 'node:crypto'
import { logicalId } from '../../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, type DurableTransaction } from '../../db/connection.ts'
import type { FailureIncidentAliasRow, FailureIncidentRow } from '../../db/rows.ts'
import { resolveEvidenceAliases, evidenceDigest } from '../evidence/normalize.ts'
import type { PreparedIncidentInput } from './prepare.ts'

export async function findIncident(tx: DurableTransaction, input: PreparedIncidentInput): Promise<{
  row: FailureIncidentRow; created: boolean
}> {
  const p = input.observation; const t = p.input.target
  if (!p.canonicalKey || !t.runtimeContainerId || !t.incarnation) {
    throw new DurableDatabaseError('INCIDENT_CANONICAL_REQUIRED')
  }
  const keys = p.aliases.map(a => a.key)
  const aliases = await tx.query<FailureIncidentAliasRow>(
    'SELECT * FROM durable_runtime.failure_incident_aliases WHERE alias_key=ANY($1::text[])', [keys])
  const originals = await tx.query<FailureIncidentRow>(
    'SELECT * FROM durable_runtime.failure_incidents WHERE evidence_key=ANY($1::text[])', [keys])
  const resolution = resolveEvidenceAliases(p, [
    ...aliases.rows.map(a => ({ aliasKey: a.alias_key, incidentId: a.incident_id })),
    ...originals.rows.map(i => ({ aliasKey: i.evidence_key, incidentId: i.id }))])
  if (resolution.conflicts.length) { throw new DurableDatabaseError('INCIDENT_ALIAS_CONFLICT') }
  let row: FailureIncidentRow | undefined
  if (resolution.incidentId) {
    row = (await tx.query<FailureIncidentRow>(
      'SELECT * FROM durable_runtime.failure_incidents WHERE id=$1', [resolution.incidentId])).rows[0]
    if (!row || row.runtime_unit_id !== t.runtimeUnitId || row.attempt_id !== t.attemptId ||
        row.pod_uid !== t.podUid || row.container_id !== t.runtimeContainerId || row.restart_identity !== t.incarnation) {
      throw new DurableDatabaseError('INCIDENT_ALIAS_BINDING_CONFLICT')
    }
  }
  const created = !row
  if (!row) {
    const id = logicalId('incident', randomUUID())
    row = (await tx.query<FailureIncidentRow>(
      `INSERT INTO durable_runtime.failure_incidents
       (id,runtime_unit_id,attempt_id,pod_uid,container_id,restart_identity,evidence_key,classification,evidence_refs,observed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'[]',$9) RETURNING *`,
      [id, t.runtimeUnitId, t.attemptId, t.podUid, t.runtimeContainerId, t.incarnation,
        p.canonicalKey, input.classification.classification, p.observedTime.original])).rows[0]
  }
  for (const alias of p.aliases) {
    await tx.query(`INSERT INTO durable_runtime.failure_incident_aliases
      (alias_key,incident_id,runtime_unit_id,attempt_id,alias_kind,alias_value)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [alias.key, row.id, t.runtimeUnitId, t.attemptId, alias.kind, JSON.stringify(alias.value)])
    const stored = (await tx.query<FailureIncidentAliasRow>(
      'SELECT * FROM durable_runtime.failure_incident_aliases WHERE alias_key=$1', [alias.key])).rows[0]
    if (!stored || stored.incident_id !== row.id || stored.alias_kind !== alias.kind ||
        stored.runtime_unit_id !== t.runtimeUnitId || stored.attempt_id !== t.attemptId ||
        evidenceDigest(stored.alias_value) !== evidenceDigest(alias.value)) {
      throw new DurableDatabaseError('INCIDENT_ALIAS_CONFLICT')
    }
  }
  return { row, created }
}
