import type { Pool } from 'pg'
import type { AttemptId } from '../../../shared/durable-runtime/identity.ts'
import type { MutationOutcome } from '../db/atomic.ts'
import type { SleepReservationRequest, PreparedMemberActivity } from '../lifecycle/sleep.ts'
import type { PreparedCatalogCall } from './request.ts'
import type { CatalogOwnerEntries } from './owners.ts'
import { captureCatalogInstant, captureCatalogParsed } from './immutable.ts'
import { capturePreparedCatalogCall, lockCatalogWorkspaceMetadata, mutateCatalogWorkspace, publishCatalogMutation } from './mutation.ts'
import { catalogUnitMembers } from './membership.ts'
import { CatalogError } from './errors.ts'

export type PreparedCatalogSleep = {
  readonly request: SleepReservationRequest
  readonly preparedAttemptId: AttemptId | null
}

/** Snapshot trusted local observations and Date scalars before any Pool/SQL await. */
export function captureCatalogSleep(input: PreparedCatalogSleep): PreparedCatalogSleep {
  const { activity, ...plain } = input.request
  const copied = captureCatalogParsed(plain) as Omit<SleepReservationRequest, 'activity'>
  const preparedAttemptId = input.preparedAttemptId
  const prepared = new Map<string, { evidence: PreparedMemberActivity; original: PreparedMemberActivity }>()
  // Keep the trusted owner's method, not a one-time cached boolean. It checks
  // current synchronous local pin validity again at P113's SQL acceptance point.
  const currentPinValid = activity?.pinValid.bind(activity) ?? null
  if (activity && preparedAttemptId) {
    for (const sessionId of copied.discoveredMembers) {
      const observed = activity.member(sessionId, preparedAttemptId)
      if (!observed || !Object.isFrozen(observed)) {continue}
      const { observedAt, ...fields } = observed
      const evidence = Object.freeze({ ...captureCatalogParsed(fields), observedAt: new Date(captureCatalogInstant(observedAt)) }) as PreparedMemberActivity
      prepared.set(sessionId, { evidence, original: observed })
    }
  }
  const capturedActivity = activity === null ? null : Object.freeze({
    member: (sessionId: string, attemptId: string) => attemptId === preparedAttemptId ? prepared.get(sessionId)?.evidence ?? null : null,
    pinValid: (evidence: PreparedMemberActivity) => {
      const entry = prepared.get(evidence.sessionId)
      if (!entry || entry.evidence !== evidence || !currentPinValid) {return false}
      try { return currentPinValid(entry.original) === true } catch { return false }
    }
  })
  return Object.freeze({ preparedAttemptId, request: Object.freeze({ ...copied, activity: capturedActivity }) })
}

export async function reserveCatalogSleep(
  pool: Pool, input: PreparedCatalogCall<'worktree.sleep'>, prepared: PreparedCatalogSleep, entries: CatalogOwnerEntries
): Promise<MutationOutcome> {
  const call = capturePreparedCatalogCall(input), sleep = captureCatalogSleep(prepared)
  const owners = Object.freeze({ ...entries })
  if (sleep.request.actorId !== call.context.authority.principalId) {throw new CatalogError('CATALOG_SLEEP_AUTHORITY')}
  return mutateCatalogWorkspace(pool, call, call.params.worktree, async (tx, workspace, membership) => {
    const request = sleep.request
    if (workspace.runtime_unit_id !== request.unitId ||
      JSON.stringify(catalogUnitMembers(membership, request.unitId)) !== JSON.stringify([...request.discoveredMembers].sort())) {
      throw new CatalogError('CATALOG_SLEEP_MEMBERSHIP')
    }
    const reservation = await owners.reserveSleep(tx, request)
    await lockCatalogWorkspaceMetadata(tx, membership)
    if (reservation.status === 'RESERVED') {
      await publishCatalogMutation(tx, call, workspace.workspace_id, 'CATALOG_SLEEP_RESERVED',
        { worktreeId: workspace.public_id, reservation: { ...reservation, intent: { ...reservation.intent } } })
    }
    // DEFERRED is durable and explicit; the facade must not translate it to successful stop.
    return { worktreeId: workspace.public_id, reservation: reservation.status === 'RESERVED'
      ? { ...reservation, intent: { ...reservation.intent } } : { ...reservation } }
  })
}
