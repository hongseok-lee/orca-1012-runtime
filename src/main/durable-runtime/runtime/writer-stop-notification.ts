import { randomUUID } from 'node:crypto'
import type { DurableTransaction } from '../db/connection.ts'
import { artifacts } from '../notifications/artifacts.ts'
import type { NotificationRow } from '../notifications/types.ts'

/** Same Unit lock and transaction as the writer transition; polls do not re-open an incident. */
export async function writerStopNotification(tx: DurableTransaction, unitId: string, attemptId: string,
  actorId: string, proofRef?: string): Promise<void> {
  const key = `writer-stop:${attemptId}`
  const rows = proofRef
    ? await tx.query<NotificationRow>(`UPDATE durable_runtime.notifications SET state='RESOLVED',resolved_at=clock_timestamp(),
        last_seen_at=clock_timestamp(),revision=revision+1 WHERE incident_key=$1 AND state='OPEN' RETURNING *`, [key])
    : await tx.query<NotificationRow>(`INSERT INTO durable_runtime.notifications(id,incident_key,target_ref,reason,state,first_seen_at,last_seen_at,retry_count)
        VALUES($1,$2,$3,'WRITER_STOP_UNCONFIRMED','OPEN',clock_timestamp(),clock_timestamp(),0)
        ON CONFLICT(incident_key) DO NOTHING RETURNING *`, [randomUUID(),key,JSON.stringify({runtimeUnitId:unitId})])
  for (const row of rows.rows) {
    await artifacts(tx, row, { kind: proofRef ? 'NOTIFICATION_RESOLVED' : 'NOTIFICATION_OPENED', eventId: randomUUID(), actorId,
      evidenceRef: proofRef ?? `writer-stop-unconfirmed:${attemptId}`, occurredAt: new Date() })
  }
}
