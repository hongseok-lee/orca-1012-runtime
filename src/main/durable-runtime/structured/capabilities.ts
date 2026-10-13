import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import type { PreparedStructuredWire, StructuredMethod } from './wire.ts'
import { snapshotStructuredJson } from './snapshot.ts'

/** These facts must describe the actual method adapter, not a Pod or a future implementation. */
export type StructuredAdapterReadiness = Readonly<{
  provider: 'claude' | 'codex'
  methods: Readonly<Partial<Record<StructuredMethod, Readonly<{ implemented: boolean; ready: boolean }>>>>
}>
export type StructuredCapabilityDecision =
  | Readonly<{ eligible: true; pendingResultsNegotiated: boolean }>
  | Readonly<{ eligible: false; reason: 'STRUCTURED_CAPABILITY_MISSING' | 'CLAUDE_CAPABILITY_MISSING' | 'METHOD_NOT_READY' }>

/** Internal eligibility only. Does not publish createSupport or start/wait for a provider. */
export function checkStructuredCapabilities(
  request: PreparedStructuredWire,
  readiness: StructuredAdapterReadiness
): StructuredCapabilityDecision {
  const snapshot = snapshotStructuredJson(readiness) as unknown as StructuredAdapterReadiness
  if ((snapshot.provider !== 'claude' && snapshot.provider !== 'codex') ||
    (Object.hasOwn(request.params, 'agent') && request.params.agent !== snapshot.provider) ||
    (Object.hasOwn(request.params, 'provider') && request.params.provider !== snapshot.provider)) {
    return Object.freeze({ eligible: false, reason: 'METHOD_NOT_READY' })
  }
  if (!request.capabilities.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)) {
    return Object.freeze({ eligible: false, reason: 'STRUCTURED_CAPABILITY_MISSING' })
  }
  if (snapshot.provider === 'claude' && !request.capabilities.includes(CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)) {
    return Object.freeze({ eligible: false, reason: 'CLAUDE_CAPABILITY_MISSING' })
  }
  const method = snapshot.methods[request.method]
  if (!method || method.implemented !== true || method.ready !== true) {
    return Object.freeze({ eligible: false, reason: 'METHOD_NOT_READY' })
  }
  return Object.freeze({
    eligible: true,
    pendingResultsNegotiated: request.capabilities.includes(AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY)
  })
}
