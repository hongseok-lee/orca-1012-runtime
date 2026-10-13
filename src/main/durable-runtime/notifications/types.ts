import type { SessionId, RuntimeUnitId, EventId, AgentId, OperationId } from '../../../shared/durable-runtime/identity.ts'
import type { MutationOutcome, JsonValue } from '../db/atomic.ts'

declare const principalBrand: unique symbol
declare const sourceAuthorityBrand: unique symbol
// Supplied by authenticated/authorized HTTP or trusted internal source adapters.
// No factory or endpoint in this module can fabricate these authorities.
export type NotificationPrincipal = string & { readonly [principalBrand]: true }
export type SourceAuthority = { actorId: string; verificationRef: string } & { readonly [sourceAuthorityBrand]: true }
export type NotificationTarget = { runtimeUnitId?: RuntimeUnitId; sessionIds?: readonly SessionId[]; operationId?: OperationId; eventId?: EventId; agentId?: AgentId }
export type Observation = {
  authority: SourceAuthority; sourceEventId: EventId; incidentKey: string; targetRef: NotificationTarget
  reasonCode: string; occurredAt: Date; retryCount: string; actionRef?: OperationId; expectedRevision?: string
}
export type ReadNotification = {
  principal: NotificationPrincipal; authorizationRef: string; operationKey: string
  notificationId: string; incidentKey: string; targetRef: NotificationTarget; expectedRevision: string
}
export type ResolveNotification = {
  authority: SourceAuthority; sourceEventId: EventId; notificationId: string; incidentKey: string
  targetRef: NotificationTarget; expectedRevision: string; occurredAt: Date
  condition: 'RECOVERED'; recoveryEvidenceRef: string
}
export type NotificationMutation = MutationOutcome
export type NotificationRow = {
  id: string; incident_key: string; target_ref: JsonValue; reason: string; state: 'OPEN' | 'RESOLVED'
  first_seen_at: Date; last_seen_at: Date; retry_count: string; read_at: Date | null; resolved_at: Date | null
  action_ref: string | null; revision: string
}
export type NotificationList = { afterId?: string; state?: 'OPEN' | 'RESOLVED'; optionalUnitFilter?: string; limit: number }
