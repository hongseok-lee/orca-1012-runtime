import { OpsHttpError } from './errors.ts'
import { opsId } from './validation.ts'
import type { OpsActor } from './types.ts'
export type OpsServerScope = Readonly<{ datasetName: string; namespaceId: string; workspaceIds: readonly string[] }>
export function snapshotOpsActor(actor: OpsActor): OpsActor {
  if (!actor.principalId || !actor.authorizationRef || !actor.datasetName || !actor.namespaceId || !Array.isArray(actor.workspaceIds)) {
    throw new OpsHttpError(503, 'invalid_authentication_context', 'The server authentication context is unavailable.')
  }
  return Object.freeze({ principalId: actor.principalId, authorizationRef: actor.authorizationRef,
    datasetName: actor.datasetName, namespaceId: actor.namespaceId,
    workspaceIds: Object.freeze([...new Set(actor.workspaceIds.map(opsId))].sort()) })
}
