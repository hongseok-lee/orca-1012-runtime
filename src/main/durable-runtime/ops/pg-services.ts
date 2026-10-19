import { DurableDatabaseError, withDurableTransaction } from '../db/connection.ts'
import type { DurableTransaction } from '../db/connection.ts'
import type { JsonValue } from '../db/atomic.ts'
import { readReplayPage } from '../replay/read.ts'
import { listNotifications } from '../notifications/read.ts'
import { markNotificationRead } from '../notifications/mutations.ts'
import type { NotificationPrincipal, NotificationTarget, NotificationRow } from '../notifications/types.ts'
import { requestManualUnitWake } from '../lifecycle/intent.ts'
import type { UnitIntentAuthority } from '../lifecycle/types.ts'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { OpsHttpServices, OpsActor } from './types.ts'
import type { OpsPgConfig } from './pg-config.ts'
import { snapshotOpsPgConfig, requireOpsActor } from './pg-config.ts'
import { listVisibleUnitIds, requireUnitAccess, targetVisible } from './access.ts'
import { projectOpsUnit, readOpsDetailRows } from './unit.ts'
import { readOpsOperation, opsTime } from './operation.ts'
import { OpsHttpError } from './errors.ts'
import type { OpsNotification, OpsNotificationReadResult } from './contract.ts'

function notification(row: NotificationRow): OpsNotification {
  return { id: row.id, incidentKey: row.incident_key, target: row.target_ref as OpsNotification['target'],
    reason: row.reason, state: row.state, revision: row.revision, retryCount: row.retry_count,
    firstSeenAt: opsTime(row.first_seen_at), lastSeenAt: opsTime(row.last_seen_at), readAt: opsTime(row.read_at),
    resolvedAt: opsTime(row.resolved_at), actionRef: row.action_ref }
}
function object(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new OpsHttpError(503, 'invalid_receipt', 'The stored result is unavailable.') }
  return value
}
function requireCommitted(status: string): void {
  if (status === 'UNCERTAIN') { throw new OpsHttpError(503, 'uncertain_commit', 'The commit is unconfirmed. Retry the same operation identity.') }
}
export function createPgOpsServices(input: OpsPgConfig): OpsHttpServices {
  const config = snapshotOpsPgConfig(input)
  const pool = config.pool
  const read = <T>(body: (tx: DurableTransaction) => Promise<T>): Promise<T> => withDurableTransaction(pool, async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    return body(tx)
  })
  const actorFor = (actor: OpsActor): OpsActor => requireOpsActor(config, actor)
  return Object.freeze({
    async units(value) {
      const actor = actorFor(value)
      return read(async tx => {
        const ids = await listVisibleUnitIds(tx, actor)
        const units = []
        for (const id of ids) { units.push(await projectOpsUnit(tx, actor, id, config.controllerConnected)) }
        const clock = await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
        return { units, observedAt: opsTime(clock.rows[0].now) }
      })
    },
    async unit(value, id) {
      const actor = actorFor(value)
      return read(async tx => {
        const unit = await projectOpsUnit(tx, actor, id, config.controllerConnected)
        return { unit, ...await readOpsDetailRows(tx, actor, id) }
      })
    },
    async operation(value, id) { const actor = actorFor(value); return read(tx => readOpsOperation(tx, actor, id)) },
    async events(value, query) {
      const actor = actorFor(value)
      const selected = Object.freeze({ ...query, after: query.after ? Object.freeze({ ...query.after }) : null })
      if (selected.unit) { await read(tx => requireUnitAccess(tx, actor, selected.unit!)) }
      const initial = selected.after ?? await read(async tx => {
        const head = await tx.query<{ epoch: string }>('SELECT epoch FROM durable_runtime.replay_stream_heads WHERE stream_id=$1', [config.streamId])
        return { streamId: config.streamId, epoch: head.rows[0]?.epoch ?? '0', offset: '0' }
      })
      const page = await readReplayPage(pool, { streamId: config.streamId, epoch: initial.epoch, afterOffset: initial.offset,
        optionalUnitFilter: selected.unit ?? undefined, limit: selected.limit })
      if (page.status === 'RESET_REQUIRED') { return page }
      const visible = await read(async tx => {
        const result = []
        for (const event of page.events) {
          const payload = event.payload
          if (payload && typeof payload === 'object' && !Array.isArray(payload) &&
            await targetVisible(tx, actor, payload.targetRef ?? null)) {
            result.push({ ...event, occurredAt: event.occurredAt.toISOString(), publishedAt: event.publishedAt.toISOString() })
          }
        }
        return result
      })
      // Preserve global scan, nextCursor and highWatermark even when every row is hidden.
      return { ...page, events: visible }
    },
    async notifications(value, query) {
      const actor = actorFor(value)
      const selected = Object.freeze({ ...query })
      const result = await listNotifications(pool, { afterId: selected.afterId ?? undefined,
        state: selected.state ?? undefined, limit: selected.limit })
      const visible = await read(async tx => {
        const rows: OpsNotification[] = []
        for (const row of result.notifications) { if (await targetVisible(tx, actor, row.target_ref)) { rows.push(notification(row)) } }
        return rows
      })
      return { notifications: visible, nextAfterId: result.nextAfterId }
    },
    async readNotification(value, id, request) {
      const actor = actorFor(value)
      const body = Object.freeze({ ...request })
      const row = await read(async tx => {
        const result = await tx.query<NotificationRow>('SELECT * FROM durable_runtime.notifications WHERE id=$1', [id])
        const found = result.rows[0]
        if (!found) { throw new DurableDatabaseError('OPS_NOTIFICATION_MISSING') }
        if (!(await targetVisible(tx, actor, found.target_ref))) { throw new DurableDatabaseError('OPS_TARGET_FORBIDDEN') }
        return found
      })
      // Authority is minted only after actual bearer verification + stored target authorization.
      const outcome = await markNotificationRead(pool, {
        principal: actor.principalId as NotificationPrincipal, authorizationRef: actor.authorizationRef,
        operationKey: `${actor.namespaceId}:${body.operationId}`, notificationId: id, incidentKey: row.incident_key,
        targetRef: row.target_ref as NotificationTarget, expectedRevision: body.expectedRevision
      })
      requireCommitted(outcome.status)
      if (outcome.status === 'UNCERTAIN') { throw new OpsHttpError(503, 'uncertain_commit', 'The commit is unconfirmed.') }
      const response = object(outcome.receipt.response)
      return { notificationId: String(response.notificationId), incidentKey: String(response.incidentKey),
        revision: String(response.revision), state: response.state as OpsNotificationReadResult['state'],
        readAt: response.readAt as string | null, resolvedAt: response.resolvedAt as string | null,
        sourceEventId: String(response.sourceEventId) }
    },
    async command(value, id, request) {
      const actor = actorFor(value)
      const body = Object.freeze({ ...request, params: Object.freeze({ ...request.params }) })
      await read(tx => requireUnitAccess(tx, actor, id))
      if (body.action !== 'wake') { throw new OpsHttpError(501, 'action_not_connected', 'This action is not connected.') }
      const unitId = logicalId('runtime-unit', id)
      const authority = Object.freeze({ principalId: actor.principalId, runtimeUnitId: unitId,
        scope: `ops:${actor.namespaceId}:runtime-unit:${id}` }) as UnitIntentAuthority
      const outcome = await requestManualUnitWake(pool, { authority, operationKey: body.operationId,
        desired: 'RUNNING', expectedRevision: counter('row:runtime-unit', body.expectedRevision),
        expectedIntentRevision: counter('intent-revision', body.params.expectedIntentRevision as string),
        // Fixed server policy, never re-read current revision/policy to alter a retry's semantic hash.
        policy: config.lifecyclePolicy })
      requireCommitted(outcome.status)
      if (outcome.status === 'UNCERTAIN') { throw new OpsHttpError(503, 'uncertain_commit', 'The commit is unconfirmed.') }
      const response = object(outcome.receipt.response)
      if (typeof response.operationId !== 'string' ||
        (response.executionDisposition !== 'QUEUED' && response.executionDisposition !== 'BLOCKED_BY_UNRESOLVED_COMMAND')) {
        throw new OpsHttpError(503, 'invalid_receipt', 'The stored result is unavailable.')
      }
      return { operationId: response.operationId, status: 'accepted' as const, receipt: outcome.status,
        executionDisposition: response.executionDisposition }
    }
  } satisfies OpsHttpServices)
}
