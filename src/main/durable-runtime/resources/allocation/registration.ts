import type { Pool } from 'pg'
import { runDurableMutation } from '../../db/atomic.ts'
import type { MutationOutcome, JsonValue } from '../../db/atomic.ts'
import { DurableDatabaseError } from '../../db/connection.ts'
import { compareAdmission, podDemand } from '../policy/admission.ts'
import { evidenceDigest } from '../evidence/normalize.ts'
import { discoverUnitMembers, lockUnitMembers } from '../../lifecycle/locks.ts'
import { envelope, immutable, decimal, json } from './snapshot.ts'
import { lockController, lockBudget, requireLiveController } from './locks.ts'
import type { PolicyRegistration, BudgetRegistration, UnitRegistration } from './types.ts'

/** Registration needs an authenticated operator scope, never candidate booleans.
 * The production issuer/authorizer is an explicit unconnected integration gate. */
export async function registerResourcePolicy(pool: Pool, input: PolicyRegistration): Promise<MutationOutcome> {
  const common = envelope(input), policy = immutable(input.policy)
  const revision = decimal(policy.revision), hash = evidenceDigest(policy)
  await common.authorize('REGISTER')
  return runDurableMutation(pool, { key: { principalId: common.authority.principalId,
    sessionScope: JSON.stringify(['resource-domain', common.authority.datasetName, common.authority.domainIdentity]),
    method: 'resource.policy.register', operationKey: common.operationKey }, payloadHash: hash, locks: {} }, async tx => {
    await lockController(tx, common.controller)
    await tx.query(`INSERT INTO durable_runtime.resource_policy_versions(policy_revision,policy,policy_digest)
      SELECT $1,$2::jsonb,$3 WHERE EXISTS(SELECT 1 FROM durable_runtime.controller_leases
        WHERE scope=$4 AND owner=$5 AND term=$6 AND expires_at>clock_timestamp())
      ON CONFLICT(policy_revision) DO NOTHING`, [revision, JSON.stringify(policy), hash,
      common.controller.scope, common.controller.owner, common.controller.term])
    await requireLiveController(tx, common.controller)
    const row = (await tx.query<{ policy_digest: string }>(
      'SELECT policy_digest FROM durable_runtime.resource_policy_versions WHERE policy_revision=$1', [revision])).rows[0]
    if (!row || row.policy_digest !== hash) { throw new DurableDatabaseError('RESOURCE_POLICY_CONFLICT') }
    return { policyRevision: revision, policyDigest: hash, authority: 'DATA_ONLY' }
  })
}
export async function registerResourceBudgetScope(pool: Pool, input: BudgetRegistration): Promise<MutationOutcome> {
  const common = envelope(input), settings = immutable(input.settings)
  const memory = decimal(input.memoryLimitBytes), cpu = decimal(input.cpuLimitMillicores)
  const expected = input.expectedRevision === null ? null : decimal(input.expectedRevision)
  const evidenceRef = input.evidence.evidenceRef, evidenceAt = input.evidence.observedAt
  if (typeof evidenceRef !== 'string' || !evidenceRef || typeof evidenceAt !== 'string' || !evidenceAt ||
      !settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new DurableDatabaseError('RESOURCE_REGISTRATION_EVIDENCE')
  }
  const meaning = json([common.authority.budgetScope, common.authority.datasetName,
    common.authority.domainIdentity, memory, cpu, settings, evidenceRef])
  await common.authorize('REGISTER')
  return runDurableMutation(pool, { key: { principalId: common.authority.principalId,
    sessionScope: JSON.stringify(['resource-budget', common.authority.datasetName, common.authority.domainIdentity]),
    method: 'resource.budget.register', operationKey: common.operationKey }, payloadHash: evidenceDigest(meaning), locks: {} }, async tx => {
    await lockController(tx, common.controller)
    if (expected === null) {
      await tx.query(`INSERT INTO durable_runtime.resource_budget_scopes
        (scope,dataset_name,budget_domain_id,memory_limit_bytes,cpu_limit_millicores,configuration,evidence_ref)
        SELECT $1,$2,$3,$4,$5,$6::jsonb,$7 WHERE EXISTS(SELECT 1 FROM durable_runtime.controller_leases
          WHERE scope=$8 AND owner=$9 AND term=$10 AND expires_at>clock_timestamp()) ON CONFLICT(scope) DO NOTHING`,
        [common.authority.budgetScope, common.authority.datasetName, common.authority.domainIdentity,
          memory, cpu, JSON.stringify(settings), evidenceRef, common.controller.scope, common.controller.owner, common.controller.term])
    }
    await lockBudget(tx, common.authority)
    await requireLiveController(tx, common.controller)
    const current = (await tx.query<{ memory_limit_bytes: string; cpu_limit_millicores: string; configuration: JsonValue; evidence_ref: string; revision: string }>(
      'SELECT memory_limit_bytes,cpu_limit_millicores,configuration,evidence_ref,revision FROM durable_runtime.resource_budget_scopes WHERE scope=$1',
      [common.authority.budgetScope])).rows[0]
    if (expected === null) {
      if (current.memory_limit_bytes !== memory || current.cpu_limit_millicores !== cpu ||
          evidenceDigest(current.configuration) !== evidenceDigest(settings) || current.evidence_ref !== evidenceRef) {
        throw new DurableDatabaseError('RESOURCE_BUDGET_CONFLICT')
      }
    } else {
      const updated = await tx.query(`UPDATE durable_runtime.resource_budget_scopes
        SET memory_limit_bytes=$2,cpu_limit_millicores=$3,configuration=$4::jsonb,evidence_ref=$5,revision=revision+1
        WHERE scope=$1 AND revision=$6 AND EXISTS(SELECT 1 FROM durable_runtime.controller_leases
          WHERE scope=$7 AND owner=$8 AND term=$9 AND expires_at>clock_timestamp()) RETURNING revision`,
        [common.authority.budgetScope, memory, cpu, JSON.stringify(settings), evidenceRef, expected,
          common.controller.scope, common.controller.owner, common.controller.term])
      if (updated.rowCount !== 1) { throw new DurableDatabaseError('RESOURCE_BUDGET_CAS') }
    }
    return { scope: common.authority.budgetScope, memoryLimitBytes: memory, cpuLimitMillicores: cpu, authority: 'DATA_ONLY' }
  })
}
export async function registerResourceUnitHead(pool: Pool, input: UnitRegistration): Promise<MutationOutcome> {
  const common = envelope(input), shape = immutable(input.approvedShape), accounted = immutable(input.accounted)
  const approved = decimal(input.approvedProfileRevision), policy = decimal(input.policyRevision)
  const proof = Object.freeze({ evidenceRef: input.evidence.evidenceRef, observedAt: input.evidence.observedAt })
  const bootstrap = input.bootstrap, unitId = common.authority.runtimeUnitId
  if (!unitId || shape.runtimeUnitId !== unitId || !proof.evidenceRef || !proof.observedAt ||
      !['NO_EXECUTION_HISTORY', 'CURRENT_ACCOUNTED'].includes(bootstrap)) {
    throw new DurableDatabaseError('RESOURCE_REGISTRATION_EVIDENCE')
  }
  decimal(accounted.memoryBytes); decimal(accounted.cpuMillicores)
  if (compareAdmission(shape, shape, null).status !== 'MATCH_DATA_ONLY') {
    throw new DurableDatabaseError('RESOURCE_REGISTRATION_ADMISSION')
  }
  const demand = podDemand(shape)
  const meaning = json([unitId, common.authority.budgetScope, approved, policy, shape, accounted, proof, bootstrap])
  await common.authorize('REGISTER')
  const members = await discoverUnitMembers(pool, unitId)
  return runDurableMutation(pool, { key: { principalId: common.authority.principalId,
    sessionScope: JSON.stringify(['resource-unit', common.authority.datasetName, common.authority.domainIdentity, unitId]), method: 'resource.unit.register', operationKey: common.operationKey },
    payloadHash: evidenceDigest(meaning), locks: { sessionIds: members, runtimeUnitIds: [unitId] } }, async tx => {
    await lockUnitMembers(tx, unitId, members)
    await lockController(tx, common.controller)
    await lockBudget(tx, common.authority)
    await requireLiveController(tx, common.controller)
    const profile = (await tx.query<{ container_resources: JsonValue; policy_revision: string }>(
      'SELECT container_resources,policy_revision FROM durable_runtime.resource_profiles WHERE runtime_unit_id=$1 AND revision=$2', [unitId, approved])).rows[0]
    const unit = (await tx.query<{ dataset_name: string; active_attempt_id: string | null }>(
      'SELECT dataset_name,active_attempt_id FROM durable_runtime.runtime_units WHERE id=$1', [unitId])).rows[0]
    if (!unit || unit.dataset_name !== common.authority.datasetName || !profile ||
        profile.policy_revision !== policy || evidenceDigest(profile.container_resources) !== evidenceDigest(shape)) {
      throw new DurableDatabaseError('RESOURCE_APPROVED_PROFILE_EVIDENCE')
    }
    if (bootstrap === 'NO_EXECUTION_HISTORY') {
      const history = await tx.query('SELECT id FROM durable_runtime.attempts WHERE runtime_unit_id=$1 LIMIT 1', [unitId])
      if (unit.active_attempt_id !== null || history.rowCount !== 0 || accounted.memoryBytes !== '0' || accounted.cpuMillicores !== '0') {
        throw new DurableDatabaseError('RESOURCE_EXECUTION_HISTORY')
      }
    } else if (BigInt(accounted.memoryBytes) < BigInt(demand.memoryBytes) || BigInt(accounted.cpuMillicores) < BigInt(demand.cpuMillicores)) {
      throw new DurableDatabaseError('RESOURCE_ACCOUNTING_UNDERSTATED')
    }
    await tx.query(`INSERT INTO durable_runtime.resource_unit_state
      (runtime_unit_id,budget_scope,approved_profile_revision,policy_revision,accounted_memory_bytes,accounted_cpu_millicores,accounting_evidence_ref,breaker)
      SELECT $1,$2,$3,$4,$5,$6,$7,'CLOSED' WHERE EXISTS(SELECT 1 FROM durable_runtime.controller_leases
        WHERE scope=$8 AND owner=$9 AND term=$10 AND expires_at>clock_timestamp()) ON CONFLICT(runtime_unit_id) DO NOTHING`,
      [unitId, common.authority.budgetScope, approved, policy, accounted.memoryBytes, accounted.cpuMillicores,
        proof.evidenceRef, common.controller.scope, common.controller.owner, common.controller.term])
    const original = (await tx.query<{ budget_scope: string; approved_profile_revision: string; policy_revision: string;
      accounted_memory_bytes: string; accounted_cpu_millicores: string; accounting_evidence_ref: string }>(
      'SELECT * FROM durable_runtime.resource_unit_state WHERE runtime_unit_id=$1', [unitId])).rows[0]
    if (!original || original.budget_scope !== common.authority.budgetScope || original.approved_profile_revision !== approved ||
        original.policy_revision !== policy || original.accounted_memory_bytes !== accounted.memoryBytes ||
        original.accounted_cpu_millicores !== accounted.cpuMillicores || original.accounting_evidence_ref !== proof.evidenceRef) {
      throw new DurableDatabaseError('RESOURCE_UNIT_HEAD_CONFLICT')
    }
    return { runtimeUnitId: unitId, approvedProfileRevision: approved, accounted: json(accounted), authority: 'DATA_ONLY' }
  })
}
