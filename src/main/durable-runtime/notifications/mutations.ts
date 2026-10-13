import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { runDurableMutation } from '../db/atomic.ts'
import { uuid, decimal, date, reject } from '../replay/validation.ts'
import { authority, incident, targetJson, locks, payloadHash, lockIncident, original, expected, response, replayAfterIncidentLock } from './internal.ts'
import { artifacts } from './artifacts.ts'
import { snapshotRead, snapshotResolve } from './snapshot.ts'
import type { ReadNotification, ResolveNotification, NotificationMutation } from './types.ts'

export async function markNotificationRead(pool: Pool, request: ReadNotification): Promise<NotificationMutation> {
  const input = snapshotRead(request)
  if (!input.principal || !input.authorizationRef || !input.operationKey) { reject('NOTIFICATION_AUTHORITY') }
  uuid(input.notificationId); incident(input.incidentKey); decimal(input.expectedRevision)
  const targetRef = targetJson(input.targetRef)
  const identity = { key: { principalId: input.principal, sessionScope: `notification:${input.notificationId}`,
    method: 'notification.read', operationKey: input.operationKey },
    payloadHash: payloadHash({ notificationId: input.notificationId, incidentKey: input.incidentKey, targetRef, expectedRevision: input.expectedRevision }),
    locks: await locks(pool, input.targetRef) }
  return runDurableMutation(pool, identity, async tx => {
    await lockIncident(tx, input.incidentKey)
    const prior = await replayAfterIncidentLock(tx, identity)
    if (prior) { return prior.response }
    let row = await original(tx, input.incidentKey, targetRef, input.notificationId)
    if (!row) { reject('NOTIFICATION_MISSING') }
    expected(row, input.expectedRevision)
    if (!row.read_at) {
      await tx.query('UPDATE durable_runtime.notifications SET read_at=clock_timestamp(),revision=revision+1 WHERE id=$1', [row.id])
      row = (await original(tx, input.incidentKey, targetRef, input.notificationId))!
    }
    const at = await tx.query<{ at: Date }>('SELECT clock_timestamp() AS at')
    const eventId = randomUUID()
    await artifacts(tx, row, { kind: 'NOTIFICATION_READ', eventId, actorId: input.principal,
      evidenceRef: input.authorizationRef, occurredAt: at.rows[0].at })
    return response(row, eventId)
  })
}
export async function resolveNotification(pool: Pool, request: ResolveNotification): Promise<NotificationMutation> {
  const input = snapshotResolve(request)
  authority(input.authority); uuid(input.sourceEventId); uuid(input.notificationId)
  incident(input.incidentKey); decimal(input.expectedRevision); date(input.occurredAt)
  if (input.condition !== 'RECOVERED' || !input.recoveryEvidenceRef) { reject('NOTIFICATION_RECOVERY_UNVERIFIED') }
  const targetRef = targetJson(input.targetRef)
  const identity = { key: { principalId: input.authority.actorId, sessionScope: `notification:${input.notificationId}`,
    method: 'notification.resolve', operationKey: input.sourceEventId },
    payloadHash: payloadHash({ notificationId: input.notificationId, sourceEventId: input.sourceEventId, incidentKey: input.incidentKey,
      targetRef, expectedRevision: input.expectedRevision, occurredAt: input.occurredAt.toISOString(), condition: input.condition, recoveryEvidenceRef: input.recoveryEvidenceRef }),
    locks: await locks(pool, input.targetRef) }
  return runDurableMutation(pool, identity, async tx => {
    await lockIncident(tx, input.incidentKey)
    const prior = await replayAfterIncidentLock(tx, identity)
    if (prior) { return prior.response }
    let row = await original(tx, input.incidentKey, targetRef, input.notificationId)
    if (!row) { reject('NOTIFICATION_MISSING') }
    expected(row, input.expectedRevision)
    if (row.state !== 'RESOLVED') {
      if (input.occurredAt < row.last_seen_at) { reject('NOTIFICATION_RECOVERY_STALE') }
      await tx.query("UPDATE durable_runtime.notifications SET state='RESOLVED',resolved_at=$2,revision=revision+1 WHERE id=$1", [row.id, input.occurredAt])
      row = (await original(tx, input.incidentKey, targetRef, input.notificationId))!
    }
    await artifacts(tx, row, { kind: 'NOTIFICATION_RESOLVED', eventId: input.sourceEventId,
      actorId: input.authority.actorId, evidenceRef: input.recoveryEvidenceRef, occurredAt: input.occurredAt })
    return response(row, input.sourceEventId)
  })
}
