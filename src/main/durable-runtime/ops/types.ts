import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OpsCommandAdmission, OpsCommandRequest, OpsNotificationList, OpsNotificationReadRequest,
  OpsNotificationReadResult, OpsOperation, OpsReplayCursor, OpsReplayPage, OpsUiProvider, OpsUnitDetail, OpsUnitList } from './contract.ts'
/** Returned only by the startup owner's actual existing-token verifier. Never accepted in JSON. */
export type OpsActor = Readonly<{
  principalId: string
  authorizationRef: string
  datasetName: string
  namespaceId: string
  workspaceIds: readonly string[]
}>
export type OpsEventsQuery = { after: OpsReplayCursor | null; unit: string | null; limit: number }
export type OpsNotificationsQuery = { afterId: string | null; state: 'OPEN' | 'RESOLVED' | null; limit: number }
export type OpsHttpServices = {
  units(actor: OpsActor): Promise<OpsUnitList>
  unit(actor: OpsActor, id: string): Promise<OpsUnitDetail>
  operation(actor: OpsActor, id: string): Promise<OpsOperation>
  events(actor: OpsActor, query: OpsEventsQuery): Promise<OpsReplayPage>
  notifications(actor: OpsActor, query: OpsNotificationsQuery): Promise<OpsNotificationList>
  readNotification(actor: OpsActor, id: string, request: OpsNotificationReadRequest): Promise<OpsNotificationReadResult>
  command(actor: OpsActor, id: string, request: OpsCommandRequest): Promise<OpsCommandAdmission>
}
export type OpsHttpConfig = Readonly<{
  origin: string
  streamId: string
  authenticateBearer(token: string): OpsActor | null | Promise<OpsActor | null>
  services: OpsHttpServices
  ui?: OpsUiProvider
  pollIntervalMs: number
}>
/** true means owned; false delegates to the original static handler. WS upgrade is untouched. */
export type OpsHttpHandler = ((request: IncomingMessage, response: ServerResponse) => boolean) & {
  stop(): Promise<void>
}
