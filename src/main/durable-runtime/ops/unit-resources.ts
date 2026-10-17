import { createHash } from 'node:crypto'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { RuntimeUnitId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, type DurableTransaction } from '../db/connection.ts'
import type { JsonValue } from '../db/atomic.ts'
import { readAgentPodPlan } from '../runtime/agent-pod-plan-records.ts'
import { canonicalInput } from '../runtime/gateway/input.ts'
import type { OpsResourceQuantity } from './contract.ts'

const invalid = (): never => { throw new DurableDatabaseError('OPS_RESOURCE_PROFILE_REFERENCE') }
function object(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return invalid() }
  return value
}
function decimal(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) { return invalid() }
  return value
}
function declaredContainer(body: JsonValue, unitId: string) {
  const shape = object(body)
  if (shape.runtimeUnitId !== unitId || shape.complete !== true || typeof shape.observed !== 'boolean' ||
      typeof shape.sourceRef !== 'string' || !shape.sourceRef || typeof shape.profileId !== 'string' || !shape.profileId ||
      typeof shape.containerIdentity !== 'string' || !shape.containerIdentity || !Array.isArray(shape.containers)) { return invalid() }
  const matches = shape.containers.map(object).filter(c => c.name === shape.containerIdentity)
  if (matches.length !== 1) { return invalid() }
  const quantity: OpsResourceQuantity = { cpuMilli: decimal(matches[0].cpuMillicores), memoryBytes: decimal(matches[0].memoryBytes) }
  return { shape, quantity }
}

/** The Ops caller has already checked Workspace access. Use its same read-only
 * snapshot; this reads stored Agent-container requests, not policy/admission.
 * No latest-revision selection, observation flag promotion or physical effect. */
export async function readOpsUnitDesiredResources(tx: DurableTransaction, unitId: RuntimeUnitId): Promise<OpsResourceQuantity | null> {
  const head = (await tx.query<{ approved: string; desired: string | null; policy: string }>(`SELECT
    approved_profile_revision::text AS approved,desired_profile_revision::text AS desired,policy_revision::text AS policy
    FROM durable_runtime.resource_unit_state WHERE runtime_unit_id=$1`, [unitId])).rows[0]
  if (head) {
    // A null desired pointer means there is no pending replacement of approved.
    const revision = head.desired ?? head.approved
    const profile = (await tx.query<{ body: JsonValue; policy: string }>(`SELECT container_resources AS body,policy_revision::text AS policy
      FROM durable_runtime.resource_profiles WHERE runtime_unit_id=$1 AND revision=$2`, [unitId, revision])).rows[0]
    if (!profile || profile.policy !== head.policy) { return invalid() }
    return declaredContainer(profile.body, unitId).quantity
  }

  // Before resource accounting registration, only the exact initial-plan
  // declaration audit identifies a profile. Retained/other-attempt profiles
  // cannot become the desired profile by ordering their revision numbers.
  const candidates = (await tx.query<{ operation_id: string; revision: string; policy: string; body: JsonValue;
    event: JsonValue; unit_revision: string; active_attempt_id: string | null; active_profile: string | null }>(`SELECT
      a.operation_id,p.revision::text AS revision,p.policy_revision::text AS policy,p.container_resources AS body,
      a.next_state AS event,u.revision::text AS unit_revision,u.active_attempt_id,t.resource_profile_revision::text AS active_profile
    FROM durable_runtime.runtime_audit_events a
    JOIN durable_runtime.runtime_units u ON u.id=a.runtime_unit_id
    JOIN durable_runtime.operations o ON o.id=a.operation_id AND o.runtime_unit_id=u.id
    JOIN durable_runtime.resource_profiles p ON p.runtime_unit_id=u.id AND p.revision=a.resource_profile_revision
    LEFT JOIN durable_runtime.attempts t ON t.id=u.active_attempt_id AND t.runtime_unit_id=u.id
    WHERE a.runtime_unit_id=$1 AND a.kind='INITIAL_AGENT_RESOURCE_PROFILE_RECORDED'`, [unitId])).rows
  if (!candidates.length) { return null }
  if (candidates.length !== 1) { return invalid() }
  const row = candidates[0], event = object(row.event), declared = declaredContainer(row.body, unitId)
  const digest = createHash('sha256').update(canonicalInput(row.body)).digest('hex')
  if (event.kind !== 'INITIAL_AGENT_RESOURCE_PROFILE_RECORDED' || event.unitId !== unitId ||
      event.operationId !== row.operation_id || event.profileRevision !== row.revision || event.policyRevision !== row.policy ||
      event.shapeDigest !== digest || typeof event.planDigest !== 'string' ||
      BigInt(decimal(event.recordedUnitRevision)) > BigInt(row.unit_revision) ||
      (row.active_attempt_id !== null && row.active_profile !== row.revision)) { return invalid() }
  const record = await readAgentPodPlan(tx, logicalId('operation', row.operation_id))
  if (!record || record.planDigest !== event.planDigest || record.plan.identity.unitId !== unitId ||
      record.plan.identity.operationId !== row.operation_id ||
      record.plan.pod.metadata.annotations['orca.dev/resource-profile-revision'] !== row.revision ||
      declared.shape.sourceRef !== `initial-agent-plan:v1:${record.planDigest}` ||
      declared.shape.profileId !== `initial-agent-profile:v1:${unitId}:${row.revision}` ||
      declared.shape.containerIdentity !== record.plan.pod.spec.containers[0].name) { return invalid() }
  // Unit conversion only. The strict original plan reader validates its
  // declaration; do not rerun scheduling/policy or label requests as admitted.
  const requests = record.plan.pod.spec.containers[0].resources.requests
  if (declared.quantity.cpuMilli !== requests.cpu.slice(0, -1) ||
      declared.quantity.memoryBytes !== (BigInt(requests.memory.slice(0, -2)) * 1048576n).toString()) { return invalid() }
  return declared.quantity
}
