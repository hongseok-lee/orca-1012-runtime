import { bootstrapServiceAccount, captureResourceInput, credentialGuards, freeze, leastPrivilegeRbac } from './manifests.mjs'

/** Pure preparation. A real bootstrap response UID is required before guards can become installation inputs. */
export function prepareCollectorIdentity(input, bootstrapUid = null) {
  const resources = captureResourceInput(input)
  return freeze({ kind: 'UNAPPLIED_COLLECTOR_IDENTITY_PREPARATION', sourcePin: resources.rootAcceptedSourcePin,
    serviceAccount: bootstrapServiceAccount(),
    credentialGuards: bootstrapUid === null ? null : credentialGuards(bootstrapUid),
    guardsRequireBootstrapResponseUid: bootstrapUid === null,
    leastPrivilegeRbac: leastPrivilegeRbac(resources),
    applied: false, issuedTokens: 0, collectorExec: 0, enforcementVerified: false, physicalPinIssued: false })
}
