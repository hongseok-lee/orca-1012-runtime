import type { JsonValue } from '../db/atomic.ts'
import type { AgentPodPlanRecord } from '../db/agent-pod-plan-record-rows.ts'
import type { KubernetesPodAuthHttps } from '../runtime/kubernetes-pod-auth-types.ts'

export type AgentPodCreateCode = 'CONFIG_INVALID' | 'INPUT_INVALID' | 'PLAN_INVALID' | 'POD_CONFLICT' |
  'CREDENTIAL_FAILED' | 'HTTP_FORBIDDEN' | 'HTTP_FAILED' | 'TLS_FAILED' | 'NETWORK_FAILED' |
  'RESPONSE_INVALID' | 'TIMEOUT' | 'ABORTED' | 'CONFLICT_LOOKUP_ABSENT'

/** No response, request, bearer, URL or underlying cause is retained. */
export class AgentPodCreateError extends Error {
  constructor(readonly code: AgentPodCreateCode) {
    super(`AGENT_POD_CREATE_${code}`)
    this.name = 'AgentPodCreateError'
  }
}

export type AgentPodCreateConfig = Readonly<{
  apiOrigin: string; ca: Uint8Array; namespace: string; dataset: string; timeoutMs: number
  readBearerToken: (this: AgentPodCreateConfig, signal: AbortSignal) => string | Promise<string>
}>
export type AgentPodCreateInput = Readonly<{
  record: AgentPodPlanRecord
  mode: 'LOOKUP_ONLY' | 'CREATE_ONCE'
  /** Remaining budget of the same operation, never a fresh per-exchange budget. */
  remainingMs: number
}>
export type AgentPodCreateHttps = KubernetesPodAuthHttps
export type AgentPodCreateObservation = Readonly<{
  kind: 'AGENT_POD_CREATE_OBSERVATION'
  disposition: 'FOUND' | 'CREATED' | 'ABSENT' | 'UNKNOWN' | 'CONFLICT'
  planDigest: string; namespace: string; name: string
  pod: Readonly<{ uid: string; resourceVersion: string; desiredResources: JsonValue; admittedResources: JsonValue }> | null
  postAttempts: 0 | 1
  reason?: AgentPodCreateCode
  readinessObserved: false; physicalPinVerified: false
}>
