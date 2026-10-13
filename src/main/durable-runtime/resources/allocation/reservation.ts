import { logicalId } from '../../../../shared/durable-runtime/identity.ts'
import type { DurableTransaction } from '../../db/connection.ts'
import { DurableDatabaseError } from '../../db/connection.ts'
import { compareAdmission, podDemand } from '../policy/admission.ts'
import { inspectBudgets, selectWakeProfile } from '../policy/growth.ts'
import type { ResourcePolicy } from '../policy/types.ts'
import type { ControllerAuthority } from '../../lifecycle/types.ts'
import type { ResourceAuthority, ResourceFacts, AllocationResult } from './types.ts'
import { decimal, json } from './snapshot.ts'
import { evidenceDigest } from '../evidence/normalize.ts'
import { requireScopeLock } from './locks.ts'
import { fencedQuery, budgetFacts, planResult, resultJson } from './repository.ts'
import type { PlanProjection, ResourceHeadProjection } from './repository.ts'
import { writeArtifacts } from './artifacts.ts'

function additional(steady: string, overlap: string, protection: string, accounted: string): string {
  const demand = [steady, overlap, protection].map(value => BigInt(decimal(value)))
  const largest = demand.reduce((a, b) => a > b ? a : b)
  const delta = largest - BigInt(decimal(accounted))
  return decimal((delta > 0n ? delta : 0n).toString())
}
export async function advancePlan(tx: DurableTransaction, plan: PlanProjection, authority: ResourceAuthority,
  controller: ControllerAuthority, status: 'RESOURCE_WAIT' | 'BLOCKED' | 'RESERVED', reasons: readonly string[],
  openBreaker = false): Promise<AllocationResult> {
  const operation = await fencedQuery(tx, controller, `UPDATE durable_runtime.operations
    SET step=$2,step_revision=step_revision+1,revision=revision+1,controller_term=$3
    WHERE id=$1 AND result IS NULL AND @lease RETURNING id`, [plan.operation_id, status, controller.term])
  if (operation.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_OPERATION_WRITE_REJECTED') }
  if (openBreaker) {
    const head = await fencedQuery(tx, controller, `UPDATE durable_runtime.resource_unit_state
      SET breaker='OPEN',breaker_reason=$2,revision=revision+1 WHERE runtime_unit_id=$1 AND @lease RETURNING runtime_unit_id`,
      [plan.runtime_unit_id, reasons.join(',')])
    if (head.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_HEAD_WRITE_REJECTED') }
  }
  const unit = await fencedQuery<{ revision: string }>(tx, controller, `UPDATE durable_runtime.runtime_units SET revision=revision+1
    WHERE id=$1 AND intent_revision=$2 AND desired_mode='RUNNING' AND @lease RETURNING revision`,
    [plan.runtime_unit_id, plan.intent_revision])
  if (unit.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_STALE_INTENT_OR_LEASE') }
  const result = { ...planResult({ ...plan, step: status }, reasons), status }
  await writeArtifacts(tx, { actor: authority.principalId, unitId: logicalId('runtime-unit', plan.runtime_unit_id),
    operationId: logicalId('operation', plan.operation_id), revision: decimal(unit.rows[0].revision),
    kind: `RESOURCE_PLAN_${status}`, body: resultJson(result) })
  return result
}
/** Caller already holds Unit2, operation4, lease5 and shared scope11.
 * Expired RESERVED rows remain charged. This never frees physical occupancy. */
export async function reserveLockedPlan(tx: DurableTransaction, input: {
  readonly plan: PlanProjection; readonly head: ResourceHeadProjection; readonly authority: ResourceAuthority
  readonly controller: ControllerAuthority; readonly facts: ResourceFacts; readonly policy: ResourcePolicy
}): Promise<AllocationResult> {
  const { plan, head, authority, controller, facts, policy } = input
  requireScopeLock(tx, authority.budgetScope)
  const existing = (await tx.query<{ state: string; runtime_unit_id: string; resource_profile_revision: string }>(
    'SELECT state,runtime_unit_id,resource_profile_revision FROM durable_runtime.resource_reservations WHERE operation_id=$1',
    [plan.operation_id])).rows[0]
  if (existing) {
    if (existing.runtime_unit_id !== plan.runtime_unit_id || existing.resource_profile_revision !== plan.target_profile_revision) {
      throw new DurableDatabaseError('RESOURCE_RESERVATION_IDENTITY_CONFLICT')
    }
    return existing.state === 'RESERVED' ? { ...planResult(plan), status: 'RESERVED' } :
      { ...planResult(plan), status: 'DEFERRED', reasons: ['APPLIED_OR_RELEASED_RESERVATION_NOT_SUPPORTED'] }
  }
  if (head.policy_revision !== plan.policy_revision || head.approved_profile_revision !== plan.previous_profile_revision || head.breaker !== 'CLOSED') {
    return advancePlan(tx, plan, authority, controller, 'BLOCKED', ['PLAN_POLICY_PROFILE_OR_BREAKER_CONFLICT'])
  }
  if (evidenceDigest(facts.declared) !== plan.spec_digest) {
    throw new DurableDatabaseError('RESOURCE_ORIGINAL_TARGET_CONFLICT')
  }
  const admission = compareAdmission(plan.target_pod_shape, facts.admitted, facts.old)
  if (admission.status !== 'MATCH_DATA_ONLY' || !admission.steady || !admission.overlap || !facts.old) {
    return advancePlan(tx, plan, authority, controller, 'RESOURCE_WAIT', ['NEEDS_ADMISSION_EVIDENCE', ...admission.differences])
  }
  const old = podDemand(facts.old)
  if (old.memoryBytes !== head.accounted_memory_bytes || old.cpuMillicores !== head.accounted_cpu_millicores) {
    return advancePlan(tx, plan, authority, controller, 'RESOURCE_WAIT', ['RESOURCE_ACCOUNTING_ORIGINAL_SHAPE_MISMATCH'])
  }
  const originalProfile = plan.facts.resourceFacts.profile
  const configuration = (profile: ResourceFacts['profile']) => ({ profileId: profile.profileId,
    profileRevision: profile.profileRevision, memoryBytes: profile.memoryBytes, cpuMillicores: profile.cpuMillicores,
    minimumMemoryBytes: profile.minimumMemoryBytes, minimumCpuMillicores: profile.minimumCpuMillicores,
    coldStartMemoryBytes: profile.coldStartMemoryBytes, ratio: profile.ratio,
    memoryLimitOmitted: profile.memoryLimitOmitted, cpuLimitOmitted: profile.cpuLimitOmitted,
    spot: profile.spot, isolated: profile.isolated })
  if (evidenceDigest(configuration(facts.profile)) !== evidenceDigest(configuration(originalProfile)) ||
      evidenceDigest(facts.profile.target) !== evidenceDigest(facts.target)) {
    throw new DurableDatabaseError('RESOURCE_ORIGINAL_CONFIG_CONFLICT')
  }
  const approved = selectWakeProfile(policy, facts.target, false, facts.profile, facts.caps)
  if (approved.kind !== 'PROFILE_CANDIDATE') {
    return advancePlan(tx, plan, authority, controller,
      approved.kind === 'BLOCKED' ? 'BLOCKED' : 'RESOURCE_WAIT', approved.reasons)
  }
  const budget = await budgetFacts(tx, plan.runtime_unit_id, policy, plan.episode_id)
  const checks = inspectBudgets(policy, facts.caps, facts.profile, budget, facts.target)
  const blockers = plan.kind === 'GROW' ? checks.reasons : checks.reasons.filter(reason =>
    reason !== 'EPISODE_GROWTH_EXHAUSTED' && reason !== 'ROLLING_GROWTH_EXHAUSTED')
  if (blockers.length > 0) { return advancePlan(tx, plan, authority, controller, 'BLOCKED', blockers, true) }
  // Recheck policy/quota/ratio caps against the fixed target; never calculate
  // another growth target or substitute a capacity=true observation.
  const targetMemory = BigInt(planResult(plan).targetMemoryBytes!)
  const caps = [policy.capBytes, facts.caps.policyBytes, facts.caps.unitBudgetBytes,
    facts.caps.quotaBytes, facts.caps.ratioBytes, facts.caps.reservationBytes]
  if (caps.some(cap => targetMemory > BigInt(decimal(cap)))) {
    return advancePlan(tx, plan, authority, controller, 'BLOCKED', ['FIXED_TARGET_EXCEEDS_CURRENT_CAP'])
  }
  if (!facts.caps.verified || facts.caps.capacityAvailable !== true || facts.caps.singleWriterBudgetAvailable !== true) {
    return advancePlan(tx, plan, authority, controller, 'RESOURCE_WAIT', ['CURRENT_CAPACITY_OR_SINGLE_WRITER_UNCONFIRMED'])
  }
  const memoryCharge = additional(admission.steady.memoryBytes, admission.overlap.memoryBytes,
    facts.protectedDemand.memoryBytes, head.accounted_memory_bytes)
  const cpuCharge = additional(admission.steady.cpuMillicores, admission.overlap.cpuMillicores,
    facts.protectedDemand.cpuMillicores, head.accounted_cpu_millicores)
  const total = (await tx.query<{ memory: string; cpu: string; memory_limit_bytes: string; cpu_limit_millicores: string }>(
    `SELECT b.memory_limit_bytes,b.cpu_limit_millicores,
     (COALESCE((SELECT SUM(u.accounted_memory_bytes) FROM durable_runtime.resource_unit_state u WHERE u.budget_scope=b.scope),0)+
      COALESCE((SELECT SUM(a.additional_memory_charge_bytes) FROM durable_runtime.resource_reservation_accounting a
        JOIN durable_runtime.resource_reservations r ON r.operation_id=a.operation_id WHERE a.budget_scope=b.scope AND r.state='RESERVED'),0))::text AS memory,
     (COALESCE((SELECT SUM(u.accounted_cpu_millicores) FROM durable_runtime.resource_unit_state u WHERE u.budget_scope=b.scope),0)+
      COALESCE((SELECT SUM(a.additional_cpu_charge_millicores) FROM durable_runtime.resource_reservation_accounting a
        JOIN durable_runtime.resource_reservations r ON r.operation_id=a.operation_id WHERE a.budget_scope=b.scope AND r.state='RESERVED'),0))::text AS cpu
     FROM durable_runtime.resource_budget_scopes b WHERE b.scope=$1`, [authority.budgetScope])).rows[0]
  if (BigInt(total.memory) + BigInt(memoryCharge) > BigInt(decimal(total.memory_limit_bytes)) ||
      BigInt(total.cpu) + BigInt(cpuCharge) > BigInt(decimal(total.cpu_limit_millicores))) {
    return advancePlan(tx, plan, authority, controller, 'RESOURCE_WAIT', ['SHARED_SCOPE_CAPACITY_INSUFFICIENT'])
  }
  const reservation = await fencedQuery(tx, controller, `INSERT INTO durable_runtime.resource_reservations
    (operation_id,runtime_unit_id,resource_profile_revision,resource_delta,state,expires_at)
    SELECT $1,$2,$3,$4::jsonb,'RESERVED',clock_timestamp()+$5::bigint*interval '1 millisecond'
    WHERE @lease RETURNING operation_id`, [plan.operation_id, plan.runtime_unit_id, plan.target_profile_revision,
    JSON.stringify({ memoryBytes: memoryCharge, cpuMillicores: cpuCharge }), plan.facts.reservationDurationMs])
  if (reservation.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_RESERVATION_WRITE_REJECTED') }
  const accounting = await fencedQuery(tx, controller, `INSERT INTO durable_runtime.resource_reservation_accounting
    (operation_id,runtime_unit_id,resource_profile_revision,budget_scope,steady_memory_bytes,steady_cpu_millicores,
     overlap_memory_bytes,overlap_cpu_millicores,protected_memory_bytes,protected_cpu_millicores,
     additional_memory_charge_bytes,additional_cpu_charge_millicores,facts,facts_digest,spec_digest)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15 WHERE @lease RETURNING operation_id`,
    [plan.operation_id, plan.runtime_unit_id, plan.target_profile_revision, authority.budgetScope,
      decimal(admission.steady.memoryBytes), decimal(admission.steady.cpuMillicores),
      decimal(admission.overlap.memoryBytes), decimal(admission.overlap.cpuMillicores),
      decimal(facts.protectedDemand.memoryBytes), decimal(facts.protectedDemand.cpuMillicores), memoryCharge, cpuCharge,
      JSON.stringify(json(facts)), evidenceDigest(json(facts)), plan.spec_digest])
  if (accounting.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_ACCOUNTING_WRITE_REJECTED') }
  const ledger = await fencedQuery(tx, controller, `INSERT INTO durable_runtime.resource_growth_ledger
    (operation_id,runtime_unit_id,episode_id,charge_kind) SELECT $1,$2,$3,$4 WHERE @lease RETURNING operation_id`,
    [plan.operation_id, plan.runtime_unit_id, plan.episode_id, plan.kind])
  if (ledger.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_CHARGE_WRITE_REJECTED') }
  const episode = await fencedQuery(tx, controller, `UPDATE durable_runtime.recovery_episodes
    SET growth_count=growth_count+CASE WHEN $3='GROW' THEN 1 ELSE 0 END,replacement_count=replacement_count+1
    WHERE id=$1 AND runtime_unit_id=$2 AND resolved_at IS NULL AND @lease RETURNING id`,
    [plan.episode_id, plan.runtime_unit_id, plan.kind])
  if (episode.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_EPISODE_WRITE_REJECTED') }
  return advancePlan(tx, plan, authority, controller, 'RESERVED', ['INTERNAL_RESERVATION_ONLY'])
}
