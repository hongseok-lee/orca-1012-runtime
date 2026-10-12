import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodePairingOffer } from '../../shared/pairing'
import { DeviceRegistry } from '../runtime/device-registry'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { makeStore } from '../runtime/paired-client-navigation-test-harness'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { renderServeReadiness } from '../server/serve-readiness'
import { parseArgs } from './orcad-entry'
import {
  mintOrcadPairingOffers,
  OrcadPairingOptionsError,
  resolveOrcadPairingScopes
} from './orcad-pairing'

describe('resolveOrcadPairingScopes', () => {
  it('keeps upstream behaviour by default: one runtime offer', () => {
    expect(resolveOrcadPairingScopes({})).toEqual(['runtime'])
  })

  it('--mobile-pairing adds the phone offer and keeps the desktop one, mobile primary', () => {
    expect(resolveOrcadPairingScopes({ mobilePairing: true })).toEqual(['mobile', 'runtime'])
  })

  it('--mobile-pairing --no-runtime-pairing is phone only', () => {
    expect(resolveOrcadPairingScopes({ mobilePairing: true, noRuntimePairing: true })).toEqual([
      'mobile'
    ])
  })

  it('--no-pairing mints nothing, even with --mobile-pairing', () => {
    expect(resolveOrcadPairingScopes({ noPairing: true, mobilePairing: true })).toEqual([])
  })

  it('rejects a request that would leave no offer at all', () => {
    expect(() => resolveOrcadPairingScopes({ noRuntimePairing: true })).toThrow(
      OrcadPairingOptionsError
    )
  })
})

describe('parseArgs pairing flags', () => {
  it('parses the flags and fails fast on a contradictory pair', () => {
    expect(parseArgs(['--mobile-pairing'])).toEqual({ mobilePairing: true })
    expect(parseArgs(['--mobile-pairing', '--no-runtime-pairing'])).toEqual({
      mobilePairing: true,
      noRuntimePairing: true
    })
    expect(() => parseArgs(['--no-runtime-pairing'])).toThrow('--no-runtime-pairing')
  })
})

describe('mintOrcadPairingOffers against a real device registry', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orcad-pairing-'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  async function startServer(): Promise<OrcaRuntimeRpcServer> {
    const rpc = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(makeStore() as never),
      userDataPath: dir,
      enableWebSocket: true,
      wsPort: 0,
      pinnedBindHost: '127.0.0.1'
    })
    await rpc.start()
    return rpc
  }

  it('mints a mobile and a runtime offer whose embedded scopes differ and whose devices persist', async () => {
    const rpc = await startServer()
    try {
      const offers = mintOrcadPairingOffers(rpc, ['mobile', 'runtime'], '127.0.0.1:6768', 'D')
      expect(offers).toHaveLength(2)
      const decoded = offers.map((offer) => {
        if (!offer.available) {
          throw new Error(`unexpected unavailable offer: ${offer.reason}`)
        }
        return { offer, parsed: decodePairingOffer(offer.url) }
      })
      expect(decoded.map((entry) => entry.offer.scope)).toEqual(['mobile', 'runtime'])
      expect(decoded.map((entry) => entry.parsed?.scope)).toEqual(['mobile', 'runtime'])
      expect(new Set(decoded.map((entry) => entry.parsed?.deviceToken)).size).toBe(2)

      // The credentials, not the URL, decide what a connection may do: the registry the server
      // authenticates against must hold one device per scope.
      const registry = new DeviceRegistry(dir)
      const byScope = Object.fromEntries(
        decoded.map(({ offer }) => [offer.scope, registry.getDevice(offer.deviceId)?.scope])
      )
      expect(byScope).toEqual({ mobile: 'mobile', runtime: 'runtime' })
    } finally {
      await rpc.stop()
    }
  })

  it('re-advertises the same pending offer per scope until one is scanned', async () => {
    const rpc = await startServer()
    try {
      const first = mintOrcadPairingOffers(rpc, ['mobile', 'runtime'], '127.0.0.1:6768', 'D')
      const second = mintOrcadPairingOffers(rpc, ['mobile', 'runtime'], '127.0.0.1:6768', 'D')
      expect(second.map((o) => o.available && o.deviceId)).toEqual(
        first.map((o) => o.available && o.deviceId)
      )
    } finally {
      await rpc.stop()
    }
  })

  it('publishes the extra offer without disturbing the primary line existing readers match', async () => {
    const rpc = await startServer()
    try {
      const [primary, extra] = mintOrcadPairingOffers(rpc, ['mobile', 'runtime'], '127.0.0.1:6768')
      const readiness = {
        runtimeId: 'r',
        boundEndpoint: null,
        advertisedEndpoint: null,
        managedWslCliReconciliation: 'settled' as const,
        pairing: primary!,
        additionalPairings: [extra!]
      }
      const json = JSON.parse(renderServeReadiness(readiness, { mode: 'json' }))
      expect(json.pairing.scope).toBe('mobile')
      expect(json.additionalPairings[0].scope).toBe('runtime')
      const human = renderServeReadiness(readiness, { mode: 'human' })
      expect(human).toMatch(/^Pairing URL: /m)
      expect(human).toMatch(/^Pairing URL \(runtime\): /m)
      const single = JSON.parse(
        renderServeReadiness({ ...readiness, additionalPairings: undefined }, { mode: 'json' })
      )
      expect('additionalPairings' in single).toBe(false)
    } finally {
      await rpc.stop()
    }
  })
})
