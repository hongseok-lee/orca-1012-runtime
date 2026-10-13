import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { runDurableMutation } from '../db/atomic.ts'
import { uuid, decimal, reject } from '../replay/validation.ts'
import { authority, incident, targetJson, locks, payloadHash, lockIncident, original, expected, response, validateObservation, replayAfterIncidentLock } from './internal.ts'
import { artifacts } from './artifacts.ts'
import { snapshotObservation } from './snapshot.ts'
import type { Observation, NotificationMutation } from './types.ts'

export async function observeNotification(pool: Pool, request: Observation): Promise<NotificationMutation> {
  const input = snapshotObservation(request)
  authority(input.authority); uuid(input.sourceEventId); incident(input.incidentKey)
  validateObservation(input.reasonCode, input.occurredAt, input.retryCount)
  if (input.actionRef !== undefined) { uuid(input.actionRef) }
  if (input.expectedRevision !== undefined) { decimal(input.expectedRevision) }
  const targetRef = targetJson(input.targetRef)
  const identity = { key: { principalId: input.authority.actorId, sessionScope: `notification-incident:${input.incidentKey}`,
    method: 'notification.observe', operationKey: input.sourceEventId },
    payloadHash: payloadHash({ sourceEventId: input.sourceEventId, incidentKey: input.incidentKey, targetRef,
      reasonCode: input.reasonCode, occurredAt: input.occurredAt.toISOString(), retryCount: input.retryCount,
      actionRef: input.actionRef ?? null, expectedRevision: input.expectedRevision ?? null }),
    locks: await locks(pool, input.targetRef, input.actionRef) }
  return runDurableMutation(pool, identity, async tx => {
    await lockIncident(tx, input.incidentKey)
    const prior = await replayAfterIncidentLock(tx, identity)
    if (prior) { return prior.response }
    let row = await original(tx, input.incidentKey, targetRef)
    let created = false
    if (!row) {
      const inserted = await tx.query(`INSERT INTO durable_runtime.notifications(id,incident_key,target_ref,reason,state,first_seen_at,last_seen_at,retry_count,action_ref)
        VALUES($1,$2,$3,$4,'OPEN',$5,$5,$6,$7) ON CONFLICT(incident_key) DO NOTHING`,
        [randomUUID(), input.incidentKey, JSON.stringify(targetRef), input.reasonCode, input.occurredAt, input.retryCount, input.actionRef ?? null])
      created = inserted.rowCount === 1
      row = await original(tx, input.incidentKey, targetRef)
    }
    if (!row) { reject('NOTIFICATION_MISSING') }
    if (input.expectedRevision !== undefined) { expected(row, input.expectedRevision) }
    // Retain resolved episodes; a late failure is history, not a new episode.
    if (!created && row.state === 'OPEN') {
      await tx.query(`UPDATE durable_runtime.notifications SET
        reason=CASE WHEN last_seen_at<=$2 THEN $3 ELSE reason END,
        last_seen_at=greatest(last_seen_at,$2),retry_count=greatest(retry_count,$4::bigint),
        action_ref=CASE WHEN last_seen_at<=$2 THEN coalesce($5::uuid,action_ref) ELSE action_ref END,
        revision=revision+1 WHERE id=$1`, [row.id, input.occurredAt, input.reasonCode, input.retryCount, input.actionRef ?? null])
      row = (await original(tx, input.incidentKey, targetRef))!
    }
    await artifacts(tx, row, { kind: created ? 'NOTIFICATION_OPENED' : 'NOTIFICATION_OBSERVED', eventId: input.sourceEventId,
      actorId: input.authority.actorId, evidenceRef: input.authority.verificationRef, occurredAt: input.occurredAt })
    return response(row, input.sourceEventId)
  })
}
