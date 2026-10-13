import { randomUUID } from 'node:crypto'
import { logicalId } from '../../../../shared/durable-runtime/identity.ts'
import type { DurableTransaction } from '../../db/connection.ts'
import { DurableDatabaseError } from '../../db/connection.ts'
import { evaluateGrowth, evaluateReplacement, selectWakeProfile } from '../policy/growth.ts'
import { compareAdmission } from '../policy/admission.ts'
import type { AdmissionShape } from '../policy/admission.ts'
import type { ResourcePolicy, PolicyDecision } from '../policy/types.ts'
import type { SessionId } from '../../../../shared/durable-runtime/identity.ts'
import { lockAggregates } from '../../db/locks.ts'
import { lockUnitMembers } from '../../lifecycle/locks.ts'
import { evidenceDigest } from '../evidence/normalize.ts'
import { prepareSnapshot, decimal, json, immutable } from './snapshot.ts'
import { lockController, lockBudget } from './locks.ts'
import { unitHead, readPlan, readPolicy, budgetFacts, refreshOriginal, requireOpenIntent,
  fencedQuery, planResult, resultJson } from './repository.ts'
import { reserveLockedPlan } from './reservation.ts'
import { writeArtifacts } from './artifacts.ts'
import type { AllocationResult } from './types.ts'

type Prepared = ReturnType<typeof prepareSnapshot>
function undecided(status: AllocationResult['status'], reasons: readonly string[]): AllocationResult {
  return { authority: 'DATA_ONLY', status, operationId: null, incidentId: null,
    targetProfileRevision: null, targetMemoryBytes: null, targetCpuMillicores: null,
    reasons, applied: false, externalCapacityGuaranteed: false }
}
async function newOperation(tx: DurableTransaction, request: Prepared) {
  const id = logicalId('operation', randomUUID()), unitId = request.authority.runtimeUnitId!
  const row = await fencedQuery(tx, request.controller, `INSERT INTO durable_runtime.operations
    (id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,expected_pod_uid,execution_epoch)
    SELECT $1,u.id,$3,u.intent_revision,$4,$5,'RESOURCE_PLANNING',$6,u.execution_epoch
    FROM durable_runtime.runtime_units u WHERE u.id=$2 AND @lease RETURNING id`,
    [id, unitId, request.kind, request.controller.scope, request.controller.term, request.facts.target.podUid])
  if (row.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_STALE_LEASE') }
  // New operation is transaction-local and Unit2 already serializes creation.
  await lockAggregates(tx, { operationIds: [id] })
  return id
}
async function rejectedOperation(tx: DurableTransaction, request: Prepared, operationId: string, decision: PolicyDecision) {
  const response = undecided(decision.kind === 'BLOCKED' ? 'BLOCKED' :
    decision.kind === 'NOT_ELIGIBLE' ? 'NOT_ELIGIBLE' : 'NEEDS_ADMISSION_EVIDENCE', decision.reasons)
  const updated = await fencedQuery(tx, request.controller, `UPDATE durable_runtime.operations
    SET step=$2,result=$3::jsonb,step_revision=step_revision+1,revision=revision+1
    WHERE id=$1 AND @lease RETURNING id`, [operationId, response.status,
    JSON.stringify({ ...resultJson(response), incidentId: request.incidentId, originalMeaningHash: request.meaningHash,
      originalFacts: json(request.facts) })])
  if (updated.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_STALE_LEASE') }
  if (response.status === 'BLOCKED') {
    const blocked = await fencedQuery(tx, request.controller, `UPDATE durable_runtime.resource_unit_state
      SET breaker='OPEN',breaker_reason=$2,revision=revision+1 WHERE runtime_unit_id=$1 AND @lease RETURNING runtime_unit_id`,
      [request.authority.runtimeUnitId, response.reasons.join(',')])
    if (blocked.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_HEAD_WRITE_REJECTED') }
  }
  const unit = await fencedQuery<{ revision: string }>(tx, request.controller, `UPDATE durable_runtime.runtime_units
    SET revision=revision+1 WHERE id=$1 AND intent_revision=$2 AND desired_mode='RUNNING' AND @lease RETURNING revision`,
    [request.authority.runtimeUnitId, request.expectedIntentRevision])
  if (unit.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_STALE_INTENT_OR_LEASE') }
  await writeArtifacts(tx, { actor: request.authority.principalId, unitId: request.authority.runtimeUnitId!,
    operationId: logicalId('operation', operationId), revision: unit.rows[0].revision,
    kind: 'RESOURCE_PLAN_REJECTED', body: json({ ...response, operationId, incidentId: request.incidentId }) })
  return { ...response, operationId, incidentId: request.incidentId }
}
/** Same transaction as the P103 receipt. No issuer, cloud IO or COMMIT here. */
export async function recordResourcePlan(tx: DurableTransaction, request: Prepared,
  discovered: readonly SessionId[]): Promise<AllocationResult> {
  const unitId = request.authority.runtimeUnitId!
  const members = await lockUnitMembers(tx, unitId, discovered)
  const original = await readPlan(tx, unitId, { incidentId: request.incidentId })
  if (original) {
    if (original.kind !== request.kind || original.facts.originalMeaningHash !== request.meaningHash) {
      throw new DurableDatabaseError('RESOURCE_ORIGINAL_PLAN_CONFLICT')
    }
    // Same incident reentry returns the fixed target; reserve is a separate entry.
    return planResult(original, ['ORIGINAL_PLAN_REUSED_NO_CHARGE'])
  }
  const initial = await unitHead(tx, request)
  await requireOpenIntent(tx, initial.unit, request.expectedUnitRevision, request.expectedIntentRevision, members)
  if (initial.head.breaker !== 'CLOSED') { return undecided('BLOCKED', ['CIRCUIT_BREAKER_OPEN']) }
  const pending = await tx.query(`SELECT id FROM durable_runtime.operations WHERE runtime_unit_id=$1
    AND kind IN ('GROW','REPLACE','DOWNSIZE','ROLLBACK') AND result IS NULL LIMIT 1`, [unitId])
  if (pending.rowCount) { return undecided('DEFERRED', ['RESOURCE_OPERATION_PENDING']) }
  const admission = compareAdmission(request.facts.declared, request.facts.admitted, request.facts.old)
  if (admission.status !== 'MATCH_DATA_ONLY' || !admission.steady || !admission.overlap) {
    return undecided('NEEDS_ADMISSION_EVIDENCE', admission.differences.length ? admission.differences : ['COMPLETE_ORIGINAL_ADMISSION_REQUIRED'])
  }
  const operationId = await newOperation(tx, request)
  await lockController(tx, request.controller)
  await lockBudget(tx, request.authority)
  // Re-read AFTER both lease/scope waits; no lower-rank acquisition from here.
  const { unit, head } = await unitHead(tx, request)
  await requireOpenIntent(tx, unit, request.expectedUnitRevision, request.expectedIntentRevision, members)
  const originalEvidence = await refreshOriginal(tx, unit, request)
  if (head.approved_profile_revision !== request.expectedApprovedProfileRevision || head.policy_revision !== request.policyRevision ||
      originalEvidence.attempt.resource_profile_revision !== head.approved_profile_revision || head.breaker !== 'CLOSED') {
    throw new DurableDatabaseError('RESOURCE_APPROVED_PROFILE_CHANGED')
  }
  const profile = (await tx.query<{ container_resources: AdmissionShape }>(
    'SELECT container_resources FROM durable_runtime.resource_profiles WHERE runtime_unit_id=$1 AND revision=$2',
    [unitId, head.approved_profile_revision])).rows[0]
  if (!request.facts.old || !profile || compareAdmission(immutable<AdmissionShape>(profile.container_resources), request.facts.old, null).status !== 'MATCH_DATA_ONLY') {
    throw new DurableDatabaseError('RESOURCE_ORIGINAL_PROFILE_SHAPE')
  }
  const agentContainer = request.facts.old.containers.find(c => c.name === request.facts.target.containerName)
  if (!agentContainer || agentContainer.memoryBytes !== request.facts.profile.memoryBytes ||
      agentContainer.cpuMillicores !== request.facts.profile.cpuMillicores ||
      request.facts.old.profileId !== request.facts.profile.profileId ||
      request.facts.profile.profileRevision !== head.approved_profile_revision) {
    throw new DurableDatabaseError('RESOURCE_APPROVED_CONTAINER_MISMATCH')
  }
  const openEpisodes = await tx.query<{ id: string }>(
    'SELECT id FROM durable_runtime.recovery_episodes WHERE runtime_unit_id=$1 AND resolved_at IS NULL', [unitId])
  if (openEpisodes.rowCount! > 1 || (head.current_episode_id !== null && openEpisodes.rows[0]?.id !== head.current_episode_id)) {
    throw new DurableDatabaseError('RESOURCE_EPISODE_CONFLICT')
  }
  const priorEpisode = openEpisodes.rows[0]?.id ?? null
  const policy: ResourcePolicy = await readPolicy(tx, request.policyRevision)
  const budget = await budgetFacts(tx, unitId, policy, priorEpisode)
  const common = { policy, target: request.facts.target, profile: request.facts.profile, caps: request.facts.caps, budget }
  const decision = request.kind === 'GROW' ? evaluateGrowth({ ...common, classification: request.facts.classification,
    classificationTarget: request.facts.target, currentAgent: members.length > 0, peak: request.facts.peak, priorResourceWait: false }) :
    evaluateReplacement(policy, common.target, common.profile, common.caps, budget)
  // Same-profile replacement uses the policy owner's approved wake selector;
  // it does not fabricate external capacity or duplicate growth arithmetic.
  const targetMemory = decision.targetMemoryBytes ?? (request.kind === 'REPLACE' && decision.kind === 'RESOURCE_WAIT'
    ? selectWakeProfile(policy, common.target, false, common.profile, common.caps).targetMemoryBytes : null)
  if (!['GROW_CANDIDATE', 'PROFILE_CANDIDATE', 'RESOURCE_WAIT'].includes(decision.kind) || targetMemory === null) {
    return rejectedOperation(tx, request, operationId, decision)
  }
  const target = request.facts.declared.containers.find(c => c.name === request.facts.target.containerName)
  if (!target || decimal(target.memoryBytes) !== decimal(targetMemory) ||
      BigInt(decimal(target.cpuMillicores)) < BigInt(decimal(common.profile.minimumCpuMillicores)) ||
      BigInt(target.memoryBytes) < BigInt(target.cpuMillicores) * BigInt(decimal(common.profile.ratio.minBytesPerMillicore)) ||
      BigInt(target.memoryBytes) > BigInt(target.cpuMillicores) * BigInt(decimal(common.profile.ratio.maxBytesPerMillicore))) {
    throw new DurableDatabaseError('RESOURCE_TARGET_ADMISSION_MISMATCH')
  }
  const episodeId = priorEpisode ?? logicalId('recovery-episode', randomUUID())
  if (!priorEpisode) {
    const episode = await fencedQuery(tx, request.controller, `INSERT INTO durable_runtime.recovery_episodes
      (id,runtime_unit_id,trigger_incident_id,state,started_at) SELECT $1,$2,$3,'ACTIVE',clock_timestamp() WHERE @lease RETURNING id`,
      [episodeId, unitId, request.incidentId])
    if (episode.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_EPISODE_WRITE_REJECTED') }
  }
  const revision = decimal(((BigInt((await tx.query<{ latest: string }>(
    'SELECT COALESCE(MAX(revision),0)::text AS latest FROM durable_runtime.resource_profiles WHERE runtime_unit_id=$1', [unitId])).rows[0].latest)) + 1n).toString())
  const insertedProfile = await fencedQuery(tx, request.controller, `INSERT INTO durable_runtime.resource_profiles
    (runtime_unit_id,revision,container_resources,policy_revision,previous_good_revision)
    SELECT $1,$2,$3::jsonb,$4,$5 WHERE @lease RETURNING revision`,
    [unitId, revision, JSON.stringify(request.facts.declared), request.policyRevision, head.approved_profile_revision])
  if (insertedProfile.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_PROFILE_WRITE_REJECTED') }
  const storedFacts = json({ originalMeaningHash: request.meaningHash, resourceFacts: request.facts,
    reservationDurationMs: request.reservationDurationMs, classificationRevision: request.expectedClassificationRevision,
    policyDecision: decision })
  const plan = await fencedQuery(tx, request.controller, `INSERT INTO durable_runtime.resource_operation_plans
    (operation_id,runtime_unit_id,kind,incident_id,episode_id,attempt_id,execution_epoch,policy_revision,
     previous_profile_revision,target_profile_revision,intent_revision,workload_profile_key,target_pod_shape,spec_digest,facts,facts_digest)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,$16 WHERE @lease RETURNING operation_id`,
    [operationId, unitId, request.kind, request.incidentId, episodeId, request.facts.target.attemptId,
      request.facts.target.executionEpoch, request.policyRevision, head.approved_profile_revision, revision,
      unit.intent_revision, request.workloadProfileKey, JSON.stringify(request.facts.declared),
      evidenceDigest(request.facts.declared), JSON.stringify(storedFacts), evidenceDigest(storedFacts)])
  if (plan.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_PLAN_WRITE_REJECTED') }
  const desired = await fencedQuery(tx, request.controller, `UPDATE durable_runtime.resource_unit_state
    SET desired_profile_revision=$2,current_episode_id=$3,revision=revision+1
    WHERE runtime_unit_id=$1 AND approved_profile_revision=$4 AND policy_revision=$5 AND @lease RETURNING runtime_unit_id`,
    [unitId, revision, episodeId, head.approved_profile_revision, request.policyRevision])
  if (desired.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_HEAD_WRITE_REJECTED') }
  const stored = await readPlan(tx, unitId, { operationId })
  if (!stored) { throw new DurableDatabaseError('RESOURCE_PLAN_MISSING') }
  return reserveLockedPlan(tx, { plan: stored, head, authority: request.authority, controller: request.controller,
    facts: request.facts, policy })
}
