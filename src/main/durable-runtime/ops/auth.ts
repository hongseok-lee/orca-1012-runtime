import type { DeviceRegistry } from '../../runtime/device-registry'
import { fingerprintAuthenticatedPairingCredential } from '../../runtime/rpc/orchestration-mutation-executor'
import { OpsHttpError } from './errors.ts'
import { opsId } from './validation.ts'
import type { OpsActor, OpsHttpConfig } from './types.ts'
export type OpsServerScope = Readonly<{ datasetName: string; namespaceId: string; workspaceIds: readonly string[] }>
export function snapshotOpsActor(actor: OpsActor): OpsActor {
  if (!actor.principalId || !actor.authorizationRef || !actor.datasetName || !actor.namespaceId || !Array.isArray(actor.workspaceIds)) {
    throw new OpsHttpError(503, 'invalid_authentication_context', 'The server authentication context is unavailable.')
  }
  return Object.freeze({ principalId: actor.principalId, authorizationRef: actor.authorizationRef,
    datasetName: actor.datasetName, namespaceId: actor.namespaceId,
    workspaceIds: Object.freeze([...new Set(actor.workspaceIds.map(opsId))].sort()) })
}
/** Startup passes its existing registry and server-selected namespace, never client identity fields. */
export function createDeviceRegistryOpsVerifier(
  registry: Pick<DeviceRegistry, 'validateToken'>,
  scope: OpsServerScope
): OpsHttpConfig['authenticateBearer'] {
  const validate = registry.validateToken.bind(registry)
  const selected = Object.freeze({ datasetName: scope.datasetName, namespaceId: scope.namespaceId,
    workspaceIds: Object.freeze([...scope.workspaceIds]) })
  return (token) => {
    const device = validate(token)
    if (!device) { return null }
    const fingerprint = fingerprintAuthenticatedPairingCredential(token)
    return snapshotOpsActor({ ...selected, principalId: `pairing-sha256:${fingerprint}`,
      authorizationRef: `ops-pairing-sha256:${fingerprint}` })
  }
}
