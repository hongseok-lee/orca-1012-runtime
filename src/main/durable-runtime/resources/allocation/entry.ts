import type { Pool } from 'pg'
import { logicalId } from '../../../../shared/durable-runtime/identity.ts'
import { runDurableMutation } from '../../db/atomic.ts'
import type { MutationOutcome } from '../../db/atomic.ts'
import { DurableDatabaseError } from '../../db/connection.ts'
import { lockAggregates } from '../../db/locks.ts'
import { discoverUnitMembers, lockUnitMembers } from '../../lifecycle/locks.ts'
import { evidenceDigest } from '../evidence/normalize.ts'
import { prepareSnapshot, reserveSnapshot } from './snapshot.ts'
import { recordResourcePlan } from './planning.ts'
import { lockController, lockBudget } from './locks.ts'
import { readPlan, planResult, resultJson, unitHead, refreshOriginal, requireOpenIntent, readPolicy } from './repository.ts'
import { reserveLockedPlan } from './reservation.ts'
import type { PrepareResourceRequest, ReserveResourceRequest } from './types.ts'

export async function prepareResourceOperation(pool: Pool, input: PrepareResourceRequest): Promise<MutationOutcome> {
  const request = prepareSnapshot(input)
  await request.authorize('PLAN')
  const unitId = request.authority.runtimeUnitId!
  const members = await discoverUnitMembers(pool, unitId)
  return runDurableMutation(pool, { key: { principalId: request.authority.principalId,
    sessionScope: JSON.stringify(['resource-unit', request.authority.datasetName, request.authority.domainIdentity, unitId]),
    method: 'resource.operation.prepare', operationKey: request.operationKey }, payloadHash: request.meaningHash,
    locks: { sessionIds: members, runtimeUnitIds: [unitId] } },
    async tx => resultJson(await recordResourcePlan(tx, request, members)))
}
export async function reserveExistingResourcePlan(pool: Pool, input: ReserveResourceRequest): Promise<MutationOutcome> {
  const request = reserveSnapshot(input)
  await request.authorize('RESERVE')
  const unitId = request.authority.runtimeUnitId!
  const members = await discoverUnitMembers(pool, unitId)
  return runDurableMutation(pool, { key: { principalId: request.authority.principalId,
    sessionScope: JSON.stringify(['resource-unit', request.authority.datasetName, request.authority.domainIdentity, unitId]),
    method: 'resource.operation.reserve', operationKey: request.operationKey },
    payloadHash: evidenceDigest([unitId, request.operationId, request.facts.declared]),
    locks: { sessionIds: members, runtimeUnitIds: [unitId] } }, async tx => {
    await lockUnitMembers(tx, unitId, members)
    const original = await readPlan(tx, unitId, { operationId: request.operationId })
    if (!original) { throw new DurableDatabaseError('RESOURCE_PLAN_MISSING') }
    if (original.spec_digest !== evidenceDigest(request.facts.declared)) {
      throw new DurableDatabaseError('RESOURCE_ORIGINAL_TARGET_CONFLICT')
    }
    const reservation = (await tx.query<{ state: string }>(
      'SELECT state FROM durable_runtime.resource_reservations WHERE operation_id=$1', [original.operation_id])).rows[0]
    if (reservation) {
      return resultJson(reservation.state === 'RESERVED' ? { ...planResult(original), status: 'RESERVED' } :
        { ...planResult(original), status: 'DEFERRED', reasons: ['APPLIED_OR_RELEASED_RESERVATION_NOT_SUPPORTED'] })
    }
    if (original.step === 'BLOCKED') { return resultJson(planResult(original, ['ORIGINAL_BLOCKER_PRESERVED'])) }
    await lockAggregates(tx, { operationIds: [logicalId('operation', original.operation_id)] })
    await lockController(tx, request.controller)
    await lockBudget(tx, request.authority)
    const { unit, head } = await unitHead(tx, request)
    await requireOpenIntent(tx, unit, request.expectedUnitRevision, request.expectedIntentRevision, members)
    if (unit.intent_revision !== original.intent_revision) { throw new DurableDatabaseError('RESOURCE_STALE_INTENT') }
    await refreshOriginal(tx, unit, { facts: request.facts, incidentId: original.incident_id,
      expectedClassificationRevision: original.facts.classificationRevision })
    const policy = await readPolicy(tx, original.policy_revision)
    return resultJson(await reserveLockedPlan(tx, { plan: original, head, authority: request.authority,
      controller: request.controller, facts: request.facts, policy }))
  })
}
