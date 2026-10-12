import type { PairingOfferUnavailableReason } from '../runtime/runtime-rpc'
import type { OrcadHealth } from '../orcad/orcad-health'

export type ServePairingUnavailableReason = PairingOfferUnavailableReason | 'disabled_by_operator'

export type ServePairingReadiness =
  | {
      available: true
      url: string
      endpoint: string
      deviceId: string
      webClientUrl: string | null
      scope: 'runtime' | 'mobile'
      qr: string | null
    }
  | {
      available: false
      reason: ServePairingUnavailableReason
      guidance: string
    }

export type ServeReadiness = {
  runtimeId: string
  boundEndpoint: string | null
  advertisedEndpoint: string | null
  managedWslCliReconciliation: 'pending' | 'settled' | 'failed'
  pairing: ServePairingReadiness
  /**
   * Further offers minted for other client scopes in the same launch (orcad `--mobile-pairing`
   * mints 'mobile' and 'runtime' together). Additive: `pairing` stays the primary offer.
   */
  additionalPairings?: ServePairingReadiness[]
  /**
   * Build identity, Node ABI and the cross-process terminal-daemon self-test.
   *
   * Optional because the Electron `--serve` host does not publish one yet; readers must
   * treat its absence as "not reported", never as healthy. Additive, so an older client
   * parsing this payload is unaffected.
   */
  health?: OrcadHealth
}

export type ServeReadinessOutput =
  | { mode: 'human' | 'json' }
  | { mode: 'recipe-json'; projectRoot: string }

type ReadinessWrite = (output: string) => Promise<void>

export class ServeReadinessPublisher {
  private state: 'pending' | 'publishing' | 'published' | 'failed' = 'pending'

  constructor(private readonly write: ReadinessWrite = writeStdout) {}

  async publish(readiness: ServeReadiness, output: ServeReadinessOutput): Promise<void> {
    if (this.state !== 'pending') {
      throw new Error(`Serve readiness publication already ${this.state}`)
    }
    this.state = 'publishing'
    try {
      await this.write(`${renderServeReadiness(readiness, output)}\n`)
      this.state = 'published'
    } catch (error) {
      this.state = 'failed'
      throw error
    }
  }
}

export function renderServeReadiness(
  readiness: ServeReadiness,
  output: ServeReadinessOutput
): string {
  if (output.mode === 'recipe-json') {
    if (!readiness.pairing.available) {
      throw new Error(
        `Recipe JSON output requires runtime pairing: ${readiness.pairing.reason}. ${readiness.pairing.guidance}`
      )
    }
    return JSON.stringify({
      schemaVersion: 1,
      pairingCode: readiness.pairing.url,
      projectRoot: output.projectRoot
    })
  }
  if (output.mode === 'json') {
    return JSON.stringify({
      type: 'orca_server_ready',
      schemaVersion: 1,
      runtimeId: readiness.runtimeId,
      endpoint: readiness.boundEndpoint,
      boundEndpoint: readiness.boundEndpoint,
      advertisedEndpoint: readiness.advertisedEndpoint,
      managedWslCliReconciliation: readiness.managedWslCliReconciliation,
      pairing: readiness.pairing,
      ...(readiness.additionalPairings?.length
        ? { additionalPairings: readiness.additionalPairings }
        : {}),
      ...(readiness.health ? { health: readiness.health } : {})
    })
  }
  return renderHumanReadiness(readiness)
}

function renderHumanReadiness(readiness: ServeReadiness): string {
  const lines = [
    'Orca server ready',
    `Bound endpoint: ${readiness.boundEndpoint ?? 'websocket unavailable'}`,
    `Advertised endpoint: ${readiness.advertisedEndpoint ?? 'unavailable'}`
  ]
  if (readiness.health) {
    const daemon = readiness.health.terminalDaemon
    lines.push(
      `Build: ${readiness.health.buildVersion} (${readiness.health.buildHash}), Node ` +
        `${readiness.health.nodeVersion} ABI ${readiness.health.nodeAbi}`
    )
    lines.push(
      `Terminal daemon: ${daemon.state} — PTY self-test ${daemon.selfTest.ok ? 'passed' : 'FAILED'}` +
        ` (${daemon.selfTest.coverage}: ${daemon.selfTest.verdict})` +
        `; terminals survive an orcad restart: ${daemon.ownsFreshSessions ? 'yes' : 'NO'}`
    )
  }
  const offers = [readiness.pairing, ...(readiness.additionalPairings ?? [])]
  for (const [index, pairing] of offers.entries()) {
    if (pairing.available) {
      if (pairing.webClientUrl) {
        lines.push(`Web client URL: ${pairing.webClientUrl}`)
      }
      if (pairing.scope === 'mobile' && pairing.qr) {
        lines.push(`Mobile pairing QR:\n${pairing.qr}`)
      }
      // Why unlabelled for the primary: existing readers match the literal `Pairing URL:` line.
      lines.push(
        index === 0 ? `Pairing URL: ${pairing.url}` : `Pairing URL (${pairing.scope}): ${pairing.url}`
      )
    } else {
      lines.push(`Pairing unavailable: ${pairing.reason}`)
      lines.push(`Pairing guidance: ${pairing.guidance}`)
    }
  }
  return lines.join('\n')
}

function writeStdout(output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(output, (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}
