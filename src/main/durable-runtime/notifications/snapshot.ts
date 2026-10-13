import type { NotificationTarget, Observation, ReadNotification, ResolveNotification, SourceAuthority } from './types.ts'

// Copy before the first await. Validation and every subsequent key/hash/lock/
// SQL/artifact consume this owned copy, never the caller's mutable objects.
function target(value: NotificationTarget): Readonly<NotificationTarget> {
  return Object.freeze({ runtimeUnitId: value.runtimeUnitId,
    sessionIds: value.sessionIds === undefined ? undefined : Object.freeze([...value.sessionIds]),
    operationId: value.operationId, eventId: value.eventId, agentId: value.agentId })
}
function authority(value: SourceAuthority): Readonly<SourceAuthority> {
  // A faithful snapshot of the already trusted adapter authority, not a
  // factory that creates or authenticates an authority from arbitrary strings.
  return Object.freeze({ ...value })
}
function occurred(value: Date): Date {
  // Object.freeze alone does not freeze Date's internal time; clone first so
  // caller setTime/setUTC* calls have no reference to this owned Date.
  return Object.freeze(new Date(value.getTime()))
}
export function snapshotObservation(value: Observation): Readonly<Observation> {
  return Object.freeze({ authority: authority(value.authority), sourceEventId: value.sourceEventId,
    incidentKey: value.incidentKey, targetRef: target(value.targetRef), reasonCode: value.reasonCode,
    occurredAt: occurred(value.occurredAt), retryCount: value.retryCount,
    actionRef: value.actionRef, expectedRevision: value.expectedRevision })
}
export function snapshotRead(value: ReadNotification): Readonly<ReadNotification> {
  return Object.freeze({ principal: value.principal, authorizationRef: value.authorizationRef,
    operationKey: value.operationKey, notificationId: value.notificationId, incidentKey: value.incidentKey,
    targetRef: target(value.targetRef), expectedRevision: value.expectedRevision })
}
export function snapshotResolve(value: ResolveNotification): Readonly<ResolveNotification> {
  return Object.freeze({ authority: authority(value.authority), sourceEventId: value.sourceEventId,
    notificationId: value.notificationId, incidentKey: value.incidentKey, targetRef: target(value.targetRef),
    expectedRevision: value.expectedRevision, occurredAt: occurred(value.occurredAt),
    condition: value.condition, recoveryEvidenceRef: value.recoveryEvidenceRef })
}
