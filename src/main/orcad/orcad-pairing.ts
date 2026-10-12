/**
 * Pairing offers for an orcad host, one per client kind.
 *
 * Why this exists: upstream orcad mints a single `scope: 'runtime'` offer. A 'runtime' credential
 * is what the desktop app and the web client need, but it is exactly the credential that is NOT
 * subject to the mobile RPC allowlist, so it cannot stand in for a phone. `orca serve` solves this
 * with `--mobile-pairing`, which swaps the one offer for a 'mobile' one; a host that must serve a
 * phone and a desktop at the same time cannot be an either/or, because the two are authenticated
 * per connection by their own device credential.
 *
 * So orcad mints one pending offer per requested scope. The device registry keeps one pending
 * device per scope (`getOrCreatePendingDevice`), so the offers are independent, both are valid at
 * once, and re-launching without a scan re-advertises the same two offers.
 */
import type { DeviceScope } from '../../shared/runtime-types'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import type { ServePairingReadiness } from '../server/serve-readiness'

export type OrcadPairingRequest = {
  noPairing?: boolean
  /** Also mint a 'mobile' offer (the phone app). */
  mobilePairing?: boolean
  /** Do not mint the 'runtime' offer (desktop app / web client). Requires `mobilePairing`. */
  noRuntimePairing?: boolean
}

export class OrcadPairingOptionsError extends Error {}

/**
 * Mobile first: when present it is the readiness payload's primary `pairing`, which keeps a reader
 * written for `orca serve --mobile-pairing` (`.pairing.url`, `.pairing.scope === 'mobile'`) working.
 */
export function resolveOrcadPairingScopes(request: OrcadPairingRequest): DeviceScope[] {
  if (request.noPairing) {
    return []
  }
  const scopes: DeviceScope[] = []
  if (request.mobilePairing) {
    scopes.push('mobile')
  }
  if (!request.noRuntimePairing) {
    scopes.push('runtime')
  }
  if (scopes.length === 0) {
    throw new OrcadPairingOptionsError(
      '--no-runtime-pairing leaves no pairing offer to create; combine it with --mobile-pairing or use --no-pairing'
    )
  }
  return scopes
}

type PairingOfferSource = Pick<OrcaRuntimeRpcServer, 'createPairingOffer'>

export function mintOrcadPairingOffers(
  rpc: PairingOfferSource,
  scopes: DeviceScope[],
  pairingAddress: string | undefined,
  today: string = new Date().toLocaleDateString()
): ServePairingReadiness[] {
  return scopes.map((scope): ServePairingReadiness => {
    const offer = rpc.createPairingOffer({
      address: pairingAddress,
      name: `${scope === 'mobile' ? 'Mobile' : 'CLI'} ${today}`,
      scope
    })
    return offer.available
      ? {
          available: true,
          url: offer.pairingUrl,
          endpoint: offer.endpoint,
          deviceId: offer.deviceId,
          webClientUrl: offer.webClientUrl,
          scope,
          qr: null
        }
      : offer
  })
}
