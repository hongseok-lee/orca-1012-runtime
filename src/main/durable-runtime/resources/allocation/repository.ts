import type { QueryResultRow } from 'pg'
import type { DurableTransaction } from '../../db/connection.ts'
import { DurableDatabaseError } from '../../db/connection.ts'
import type { RuntimeUnitRow } from '../../db/rows.ts'
import type { ControllerAuthority } from '../../lifecycle/types.ts'
import type { JsonValue } from '../../db/atomic.ts'
import type { ResourcePolicy, BudgetFacts } from '../policy/types.ts'
import type { AdmissionShape } from '../policy/admission.ts'
import type { Envelope, ResourceFacts, AllocationResult } from './types.ts'
import { decimal, immutable } from './snapshot.ts'

import type { ResourceUnitStateRow, ResourceOperationPlanRow } from '../../db/resource-allocation-rows.ts'

export type ResourceHeadProjection = ResourceUnitStateRow
// This narrows the actual DB owner's row for the supported GROW/REPLACE entry
// and adds only the joined operation progress and decoded immutable facts.
export type PlanProjection = Omit<ResourceOperationPlanRow, 'kind' | 'incident_id' | 'episode_id' | 'target_pod_shape' | 'facts'> & {
  kind: 'GROW' | 'REPLACE'; incident_id: string; episode_id: string; target_pod_shape: AdmissionShape
  facts: { originalMeaningHash: string; resourceFacts: ResourceFacts; reservationDurationMs: number; classificationRevision: string }
  step: string; deadline_at: Date | null
}
export async function fencedQuery<Row extends QueryResultRow = QueryResultRow>(
  tx: DurableTransaction, controller: ControllerAuthority, sql: string, values: readonly unknown[]
) {
  const n = values.length
  if (!sql.includes('@lease')) { throw new DurableDatabaseError('RESOURCE_WRITE_GUARD_REQUIRED') }
  const guard = `EXISTS(SELECT 1 FROM durable_runtime.controller_leases WHERE scope=$${n + 1}
    AND owner=$${n + 2} AND term=$${n + 3} AND expires_at>clock_timestamp())`
  return tx.query<Row>(sql.replaceAll('@lease', guard), [...values, controller.scope, controller.owner, controller.term])
}
export async function unitHead(tx: DurableTransaction, common: Pick<Envelope, 'authority'>) {
  const id = common.authority.runtimeUnitId
  const unit = (await tx.query<RuntimeUnitRow & { dataset_name: string }>(
    'SELECT * FROM durable_runtime.runtime_units WHERE id=$1', [id])).rows[0]
  const head = (await tx.query<ResourceHeadProjection>(
    'SELECT * FROM durable_runtime.resource_unit_state WHERE runtime_unit_id=$1', [id])).rows[0]
  if (!unit || !head || unit.dataset_name !== common.authority.datasetName || head.budget_scope !== common.authority.budgetScope) {
    throw new DurableDatabaseError('RESOURCE_UNIT_SCOPE_BINDING')
  }
  for (const value of [head.revision, head.approved_profile_revision, head.policy_revision,
    head.accounted_memory_bytes, head.accounted_cpu_millicores, unit.revision, unit.intent_revision, unit.execution_epoch]) { decimal(value) }
  return { unit, head }
}
export async function readPlan(tx: DurableTransaction, unitId: string, by: { incidentId: string } | { operationId: string }): Promise<PlanProjection | null> {
  const column = 'incidentId' in by ? 'incident_id' : 'operation_id'
  const key = 'incidentId' in by ? by.incidentId : by.operationId
  const rows = await tx.query<PlanProjection>(`SELECT p.*,o.step,o.deadline_at
    FROM durable_runtime.resource_operation_plans p JOIN durable_runtime.operations o ON o.id=p.operation_id
    WHERE p.runtime_unit_id=$1 AND p.${column}=$2`, [unitId, key])
  const row = rows.rows[0]
  if (row && (!['GROW', 'REPLACE'].includes(row.kind) || row.incident_id === null || row.episode_id === null)) {
    throw new DurableDatabaseError('RESOURCE_OPERATION_KIND_NOT_SUPPORTED')
  }
  return row ?? null
}
export function planResult(plan: PlanProjection, reasons: readonly string[] = []): AllocationResult {
  const shape = immutable(plan.target_pod_shape)
  const original = plan.facts.resourceFacts.target.containerName
  const target = shape.containers.find(c => c.name === original)
  if (!target) { throw new DurableDatabaseError('RESOURCE_PLAN_TARGET') }
  return { authority: 'DATA_ONLY', status: plan.step === 'RESERVED' ? 'RESERVED' :
    plan.step === 'BLOCKED' ? 'BLOCKED' : 'RESOURCE_WAIT', operationId: plan.operation_id,
    incidentId: plan.incident_id, targetProfileRevision: decimal(plan.target_profile_revision),
    targetMemoryBytes: decimal(target.memoryBytes), targetCpuMillicores: decimal(target.cpuMillicores),
    reasons, applied: false, externalCapacityGuaranteed: false }
}
export async function readPolicy(tx: DurableTransaction, revision: string): Promise<ResourcePolicy> {
  const row = (await tx.query<{ policy: ResourcePolicy }>(
    'SELECT policy FROM durable_runtime.resource_policy_versions WHERE policy_revision=$1', [decimal(revision)])).rows[0]
  if (!row || row.policy.revision !== revision) { throw new DurableDatabaseError('RESOURCE_POLICY_MISSING') }
  return immutable(row.policy)
}
export async function budgetFacts(tx: DurableTransaction, unitId: string, policy: ResourcePolicy, episodeId: string | null): Promise<BudgetFacts> {
  const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now
  const counters = episodeId === null ? null : (await tx.query<{ growth_count: string; replacement_count: string }>(
    'SELECT growth_count,replacement_count FROM durable_runtime.recovery_episodes WHERE id=$1 AND runtime_unit_id=$2 AND resolved_at IS NULL',
    [episodeId, unitId])).rows[0]
  if (episodeId !== null && !counters) { throw new DurableDatabaseError('RESOURCE_EPISODE_MISSING') }
  const rolling = (await tx.query<{ n: string }>(`SELECT count(*) AS n FROM durable_runtime.resource_growth_ledger
    WHERE runtime_unit_id=$1 AND charge_kind='GROW' AND charged_at>$2::timestamptz-$3::bigint*interval '1 millisecond'`,
    [unitId, now, policy.rollingMs])).rows[0].n
  const dbNowMs = now.getTime()
  return Object.freeze({ runtimeUnitId: unitId, sourceRef: `pg-resource-budget:${unitId}`,
    dbNowMs, rollingStartMs: Math.max(0, dbNowMs - policy.rollingMs), episodeGrowth: decimal(counters?.growth_count ?? '0'),
    episodeReplacements: decimal(counters?.replacement_count ?? '0'), rollingGrowth: decimal(rolling) })
}
export async function refreshOriginal(tx: DurableTransaction, unit: RuntimeUnitRow, input: {
  readonly facts: ResourceFacts; readonly incidentId: string; readonly expectedClassificationRevision: string
}) {
  const target = input.facts.target
  const incident = (await tx.query<{ attempt_id: string; pod_uid: string; container_id: string; restart_identity: string;
    classification: string; classification_revision: string; state: string; reason: string | null; evidence_ids: string[];
    execution_epoch: string; deadline_at: Date }>(`SELECT i.*,s.classification_revision,s.state,s.reason,s.evidence_ids,s.execution_epoch,s.deadline_at
    FROM durable_runtime.failure_incidents i JOIN durable_runtime.failure_incident_state s ON s.incident_id=i.id
    WHERE i.id=$1 AND i.runtime_unit_id=$2`, [input.incidentId, unit.id])).rows[0]
  const attempt = (await tx.query<{ pod_uid: string; incarnation: string; execution_epoch: string; resource_profile_revision: string }>(
    'SELECT pod_uid,incarnation,execution_epoch,resource_profile_revision FROM durable_runtime.attempts WHERE id=$1 AND runtime_unit_id=$2',
    [target.attemptId, unit.id])).rows[0]
  if (!incident || !attempt || target.runtimeUnitId !== unit.id || unit.active_attempt_id !== target.attemptId ||
      unit.execution_epoch !== target.executionEpoch || incident.attempt_id !== target.attemptId ||
      incident.execution_epoch !== target.executionEpoch || incident.pod_uid !== target.podUid ||
      attempt.pod_uid !== target.podUid || attempt.incarnation !== target.incarnation || attempt.execution_epoch !== target.executionEpoch ||
      incident.container_id !== target.runtimeContainerId || incident.restart_identity !== target.incarnation) {
    throw new DurableDatabaseError('RESOURCE_STALE_INCIDENT')
  }
  const ids = [...input.facts.classification.observationIds].sort()
  if (incident.classification_revision !== input.expectedClassificationRevision || incident.classification !== input.facts.classification.classification ||
      JSON.stringify([...incident.evidence_ids].sort()) !== JSON.stringify(ids)) {
    throw new DurableDatabaseError('RESOURCE_CLASSIFICATION_CHANGED')
  }
  if (incident.state !== 'CLASSIFIED' || incident.reason !== null || input.facts.classification.conflicts.length !== 0) {
    throw new DurableDatabaseError('RESOURCE_INCIDENT_BLOCKED_OR_CONFLICT')
  }
  return { incident, attempt }
}
export async function requireOpenIntent(tx: DurableTransaction, unit: RuntimeUnitRow,
  expectedUnit: string, expectedIntent: string, members: readonly string[]): Promise<void> {
  if (unit.revision !== expectedUnit || unit.intent_revision !== expectedIntent || unit.desired_mode !== 'RUNNING') {
    throw new DurableDatabaseError('RESOURCE_STALE_INTENT')
  }
  const closed = await tx.query("SELECT id FROM durable_runtime.sessions WHERE id=ANY($1::uuid[]) AND lifecycle<>'OPEN'", [members])
  const cancel = await tx.query(`SELECT operation_id FROM durable_runtime.cancel_intents
    WHERE target_runtime_unit_id=$1 AND target_attempt_id=$2 AND interrupt_status IN ('REQUESTED','UNKNOWN') LIMIT 1`,
    [unit.id, unit.active_attempt_id])
  if (closed.rowCount || cancel.rowCount) { throw new DurableDatabaseError('RESOURCE_CLOSE_OR_CANCEL_PENDING') }
}
export function resultJson(value: AllocationResult): { [key: string]: JsonValue } {
  return { ...value, reasons: [...value.reasons] }
}
