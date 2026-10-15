import { createOpsBrowserSessionAuthority, type OpsBrowserSessionAuthority } from '../durable-runtime/ops/browser-session-auth.ts'
import type { RuntimeOpsHttpConfig } from '../durable-runtime/ops/runtime-config.ts'
import { invalidOrcadOpsConfig } from './orcad-ops-config.ts'

/** Registered before Ops PG validation; connect is used only after that validation completes. */
export function createOrcadOpsBrowserSessionOwner(owner: { stop(): Promise<void> } | null) {
  const stopOwner = owner?.stop.bind(owner)
  let sessions: OpsBrowserSessionAuthority | null = null
  let stopped = false, stopping: Promise<void> | null = null
  return Object.freeze({
    assertOpen: () => { if (stopped) { invalidOrcadOpsConfig('OPS_STARTUP_UNAVAILABLE') } },
    connect: (config: RuntimeOpsHttpConfig) => {
      if (stopped || sessions) { invalidOrcadOpsConfig('OPS_STARTUP_UNAVAILABLE') }
      const authority = createOpsBrowserSessionAuthority(config.scope)
      sessions = authority
      return Object.freeze({ browserOpsAuth: Object.freeze({ origin: config.origin,
        issuePageSession: authority.issuePageSession.bind(authority) }),
      opsHttp: Object.freeze({ ...config, authenticateBrowserBearer: authority.authenticateBearer.bind(authority) }) })
    },
    stop: (): Promise<void> => {
      stopped = true
      sessions?.close()
      stopping ??= Promise.resolve().then(() => stopOwner?.())
      return stopping
    }
  })
}
