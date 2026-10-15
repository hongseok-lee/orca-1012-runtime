import type { DeviceRegistry } from '../../runtime/device-registry'
import { fingerprintAuthenticatedPairingCredential } from '../../runtime/rpc/orchestration-mutation-executor'
import { snapshotOpsActor } from './actor.ts'
import type { OpsServerScope } from './actor.ts'
import type { OpsHttpConfig } from './types.ts'
export { snapshotOpsActor } from './actor.ts'
export type { OpsServerScope } from './actor.ts'
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
