import type { DurableTransaction } from '../db/connection.ts'
import type { JsonValue } from '../db/atomic.ts'
import type { OpsActor } from './types.ts'
import { OpsHttpError } from './errors.ts'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** The immutable 014 workspace anchor survives current member removal and tombstones. */
export async function unitVisible(tx: DurableTransaction, actor: OpsActor, id: string): Promise<boolean> {
  return (await tx.query(`SELECT u.id FROM durable_runtime.runtime_units u WHERE u.id=$1 AND u.dataset_name=$2
    AND EXISTS(SELECT 1 FROM durable_runtime.catalog_workspace_metadata c
      JOIN durable_runtime.workspaces w ON w.id=c.workspace_id
      WHERE c.runtime_unit_id=u.id AND w.dataset_name=$2 AND w.id=ANY($3::uuid[]))`,
    [id, actor.datasetName, actor.workspaceIds])).rowCount === 1
}
export async function requireUnitAccess(tx: DurableTransaction, actor: OpsActor, id: string): Promise<void> {
  if (!(await tx.query('SELECT id FROM durable_runtime.runtime_units WHERE id=$1', [id])).rowCount) {
    throw new OpsHttpError(404, 'not_found', 'The runtime unit was not found.')
  }
  if (!(await unitVisible(tx, actor, id))) { throw new OpsHttpError(403, 'forbidden', 'The target is outside the server namespace.') }
}
export async function listVisibleUnitIds(tx: DurableTransaction, actor: OpsActor): Promise<string[]> {
  const result = await tx.query<{ id: string }>(`SELECT DISTINCT u.id FROM durable_runtime.runtime_units u
    JOIN durable_runtime.catalog_workspace_metadata c ON c.runtime_unit_id=u.id
    JOIN durable_runtime.workspaces w ON w.id=c.workspace_id
    WHERE u.dataset_name=$1 AND w.dataset_name=$1 AND w.id=ANY($2::uuid[]) ORDER BY u.id`,
    [actor.datasetName, actor.workspaceIds])
  return result.rows.map(row => row.id)
}
/** All stored references must prove access. Missing targets are hidden, never globally authorized. */
export async function targetVisible(tx: DurableTransaction, actor: OpsActor, value: JsonValue): Promise<boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return false }
  const units = new Set<string>()
  let proven = false
  for (const key of ['runtimeUnitId', 'operationId', 'eventId', 'agentId']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !uuid.test(value[key] as string))) { return false }
  }
  if (typeof value.runtimeUnitId === 'string') { units.add(value.runtimeUnitId) }
  if (typeof value.operationId === 'string') {
    const rows = await tx.query<{ runtime_unit_id: string }>('SELECT runtime_unit_id FROM durable_runtime.operations WHERE id=$1', [value.operationId])
    if (!rows.rows[0]) { return false }
    units.add(rows.rows[0].runtime_unit_id)
  }
  if (typeof value.eventId === 'string') {
    const rows = await tx.query<{ runtime_unit_id: string }>(`SELECT p.runtime_unit_id FROM durable_runtime.runtime_event_queue q
      JOIN durable_runtime.runtime_event_producers p USING(producer_id,incarnation) WHERE q.event_id=$1`, [value.eventId])
    if (!rows.rows[0]) { return false }
    units.add(rows.rows[0].runtime_unit_id)
  }
  if (value.sessionIds !== undefined) {
    if (!Array.isArray(value.sessionIds) || value.sessionIds.some(id => typeof id !== 'string' || !uuid.test(id))) { return false }
    for (const id of value.sessionIds) {
      const rows = await tx.query<{ runtime_unit_id: string; agent_id: string }>(`SELECT c.runtime_unit_id,s.agent_id FROM durable_runtime.sessions s
        JOIN durable_runtime.workspaces w ON w.id=s.workspace_id
        JOIN durable_runtime.catalog_workspace_metadata c ON c.workspace_id=w.id
        WHERE s.id=$1 AND s.workspace_id=ANY($2::uuid[]) AND w.dataset_name=$3`, [id, actor.workspaceIds, actor.datasetName])
      // Dataset is proved by the immutable Session/workspace FK.
      if (!rows.rows[0]?.runtime_unit_id) { return false }
      if (value.agentId !== undefined && rows.rows[0].agent_id !== value.agentId) { return false }
      units.add(rows.rows[0].runtime_unit_id)
    }
  }
  for (const id of units) { if (!(await unitVisible(tx, actor, id))) { return false }; proven = true }
  if (typeof value.agentId === 'string') {
    const rows = await tx.query<{ workspace_id: string; runtime_unit_id: string | null; dataset_name: string }>(`SELECT s.workspace_id,c.runtime_unit_id,w.dataset_name
      FROM durable_runtime.sessions s JOIN durable_runtime.workspaces w ON w.id=s.workspace_id
      JOIN durable_runtime.agents a ON a.id=s.agent_id
      LEFT JOIN durable_runtime.catalog_workspace_metadata c ON c.workspace_id=w.id
      WHERE s.agent_id=$1 AND a.dataset_name=$2`, [value.agentId, actor.datasetName])
    if (!rows.rowCount) { return false }
    const related = units.size ? rows.rows.filter(row => row.runtime_unit_id && units.has(row.runtime_unit_id)) : rows.rows
    if (!related.length) { return false }
    for (const row of related) {
      if (row.dataset_name !== actor.datasetName || !actor.workspaceIds.includes(row.workspace_id) ||
        !row.runtime_unit_id || !(await unitVisible(tx, actor, row.runtime_unit_id))) { return false }
    }
    proven = true
  }
  return proven
}
