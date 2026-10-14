/** Root P126/127 wire DTOs. IDs/counters are strings; unavailable observations are null. */
export type OpsCounter = string
export type OpsId = string
export type OpsTime = string | null
export type OpsError = { error: { code: string; message: string } }
export type OpsAction = {
  action: string
  enabled: boolean
  reason: string | null
}
export type OpsResourceQuantity = { cpuMilli: string | null; memoryBytes: string | null }
export type OpsUnit = {
  id: OpsId
  revision: OpsCounter
  intentRevision: OpsCounter
  alias: string | null
  desiredMode: string
  phase: string
  observed: 'ABSENT' | 'unverifiable' | 'PRESENT_UNVERIFIED'
  observedAt: OpsTime
  attempt: { id: OpsId; podUid: string | null; status: string; node: string | null; spot: boolean | null } | null
  resources: {
    desired: OpsResourceQuantity | null
    admitted: OpsResourceQuantity | null
    usage: OpsResourceQuantity | null
    peak: OpsResourceQuantity | null
    nextDownsizeAt: OpsTime
  }
  counts: { pendingMessages: OpsCounter; inputComponents: OpsCounter; inFlight: OpsCounter; historicalUnknown: OpsCounter }
  mounts: {
    id: OpsId; accessState: string; storageEpoch: OpsCounter
    writerAttemptId: OpsId | null
    grant: { state: string; attemptId: OpsId; storageEpoch: OpsCounter; revokedAt: OpsTime } | null
  }[]
  availableActions: OpsAction[]
}
export type OpsUnitList = { units: OpsUnit[]; observedAt: OpsTime }
export type OpsSession = { id: OpsId; lifecycle: string; revision: OpsCounter }
export type OpsTab = { id: OpsId; workspaceId: OpsId; sessionId: OpsId | null; kind: string; terminalHandle: string | null; lifecycle: string; revision: OpsCounter }
export type OpsIncident = { id: OpsId; runtimeUnitId: OpsId; state: string | null; classification: string | null; revision: OpsCounter | null; observedAt: OpsTime }
export type OpsOperation = {
  id: OpsId; runtimeUnitId: OpsId; kind: string; step: string
  revision: OpsCounter; stepRevision: OpsCounter; intentRevision: OpsCounter
  disposition: 'queued' | 'blocked' | 'failed' | 'applied' | 'unverifiable'
  reason: string | null
  result: { state: string | null } | null
  deadlineAt: OpsTime
  retryAt: OpsTime
}
export type OpsUnitDetail = { unit: OpsUnit; sessions: OpsSession[]; tabs: OpsTab[]; recentIncidents: OpsIncident[]; operations: OpsOperation[] }
export type OpsReplayCursor = { streamId: string; epoch: OpsCounter; offset: OpsCounter }
export type OpsReplayEvent = {
  cursor: OpsReplayCursor; sourceEventId: OpsId; occurredAt: string; publishedAt: string
  payload: null | boolean | number | string | OpsReplayEvent['payload'][] | { [key: string]: OpsReplayEvent['payload'] }
}
export type OpsReplayPage =
  | { status: 'PAGE'; events: OpsReplayEvent[]; nextCursor: OpsReplayCursor; highWatermark: OpsReplayCursor; minimumOffset: OpsCounter; scanned: number }
  | { status: 'RESET_REQUIRED'; currentEpoch: OpsCounter; minimumOffset: OpsCounter; latestOffset: OpsCounter; streamId: string }
export type OpsNotification = {
  id: OpsId; incidentKey: string; target: { runtimeUnitId?: OpsId; sessionIds?: OpsId[]; operationId?: OpsId; eventId?: OpsId; agentId?: OpsId }
  reason: string; state: 'OPEN' | 'RESOLVED'; revision: OpsCounter
  firstSeenAt: OpsTime; lastSeenAt: OpsTime; readAt: OpsTime; resolvedAt: OpsTime
  retryCount: OpsCounter; actionRef: OpsId | null
}
export type OpsNotificationList = { notifications: OpsNotification[]; nextAfterId: string | null }
export type OpsNotificationReadRequest = { operationId: OpsId; expectedRevision: OpsCounter }
export type OpsNotificationReadResult = {
  notificationId: OpsId; incidentKey: string; revision: OpsCounter; state: 'OPEN' | 'RESOLVED'
  readAt: OpsTime; resolvedAt: OpsTime; sourceEventId: OpsId
}
export type OpsCommandRequest = { operationId: OpsId; expectedRevision: OpsCounter; action: string; params: { expectedIntentRevision: OpsCounter } | Record<string, unknown> }
export type OpsCommandAdmission = { operationId: OpsId; status: 'accepted'; receipt: 'COMMITTED' | 'REPLAYED'; executionDisposition: 'QUEUED' | 'BLOCKED_BY_UNRESOLVED_COMMAND' }
export type OpsUiAsset = { contentType: string; body: string | Uint8Array }
/** The UI owner supplies credential-free assets; this function never receives an actor/key. */
export type OpsUiProvider = (pathname: string) => OpsUiAsset | null | Promise<OpsUiAsset | null>
export const OPS_ROUTES = {
  units: '/ops/v1/runtime-units', events: '/ops/v1/events', stream: '/ops/v1/events/stream',
  notifications: '/ops/v1/notifications', operations: '/ops/v1/operations'
} as const
