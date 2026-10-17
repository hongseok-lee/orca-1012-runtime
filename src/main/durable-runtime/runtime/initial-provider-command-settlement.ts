import type { Pool } from 'pg'
import { DurableDatabaseError, runDurableTransaction } from '../db/connection.ts'
import { immutableSnapshot } from '../providers/shared/recovery-renderer.ts'
import { readInitialAgentPodAssignmentTarget } from './initial-agent-pod-assignment.ts'
import { LockedGatewayAuthority } from './gateway/authority.ts'
import { settleOwnedExecution } from './gateway/claim.ts'
import { originalIdentity } from './gateway/store.ts'
import type { CommandClaim, GatewayContext, JsonValue } from './gateway/types.ts'
import type { SettledCommandReceipt } from './command-types.ts'

/** Called only by the original ensure executor AFTER its API call and PG Pod
 * assignment have returned. Existing exact plan/reservation validation is
 * reused under its original locks. This resolves only ensureAttempt (Pod
 * ASSIGNED), never provider readiness, workload identity, grants or gate.
 * Lookup/takeover cannot manufacture the original executor's completion. */
export async function settleInitialEnsureAssigned(pool: Pool, original: Readonly<{
  context: GatewayContext; claim: CommandClaim; planDigest: string
}>) {
  const input = immutableSnapshot(original), connect = pool.connect.bind(pool)
  const borrowed: Pool = Object.create(pool, { connect: { value: connect } })
  const database = await runDurableTransaction(borrowed, async tx => {
    const assigned = await readInitialAgentPodAssignmentTarget(tx, input.context,
      { claim: input.claim, planDigest: input.planDigest })
    if (input.claim.identity.command !== 'ensureAttempt' || assigned.status !== 'POD_ASSIGNED' || !assigned.podUid) {
      throw new DurableDatabaseError('INITIAL_PROVIDER_ENSURE_NOT_ASSIGNED')
    }
    const authority = await LockedGatewayAuthority.acquire(tx, input.context)
    const result = { attemptId: assigned.attemptId, phase: 'PROVISIONING', podState: 'ASSIGNED', podUid: assigned.podUid }
    const row = await settleOwnedExecution(authority, input.claim, { state: 'RESOLVED', result, evidenceRefs: [] })
    await authority.assertCurrent()
    const receipt: Extract<SettledCommandReceipt<JsonValue>, { state: 'RESOLVED' }> = Object.freeze({
      identity: originalIdentity(row), state: 'RESOLVED', result,
    })
    return Object.freeze({ receipt, plan: assigned.record, unitRevision: assigned.unitRevision })
  })
  return Object.freeze({ database, continuation: database.ok && database.commitOutcome === 'ACKNOWLEDGED' && !database.cleanupFailed
    ? database.value : null })
}
