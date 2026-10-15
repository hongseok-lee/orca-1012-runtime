import type { request } from 'node:https'

/** Trusted operator composition only; never populated from App/RPC input. */
export type ComputeInstanceIdentityConfiguration = Readonly<{
  projectId: string
  timeoutMs: number
  readAccessToken(signal: AbortSignal): Promise<string>
  /** Fixture-only seam. Production omits this and uses node:https. */
  https?: { request: typeof request }
}>

export type ComputeInstanceIdentityInput = Readonly<{
  zone: string
  instanceName: string
  expectedNumericInstanceId: string
}>

export type ComputeInstanceIdentityErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_INPUT'
  | 'AUTH_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'REDIRECT_REJECTED'
  | 'HTTP_ERROR'
  | 'INVALID_JSON'
  | 'INVALID_RESPONSE'
  | 'INVALID_INSTANCE_KIND'
  | 'INVALID_NUMERIC_ID'
  | 'IDENTITY_MISMATCH'
  | 'INSTANCE_REPLACED'
  | 'RESPONSE_TRUNCATED'
  | 'RESPONSE_TOO_LARGE'
  | 'NETWORK_ERROR'
  | 'TLS_ERROR'
  | 'ABORTED'
  | 'TIMEOUT'

/** An observation, with no stop/proof/permit brand, timestamp or project-number assertion. */
export type ComputeInstanceIdentityObservation = Readonly<{
  status: 'COMPUTE_INSTANCE_IDENTITY_OBSERVED'
  source: 'COMPUTE_CONTROL_PLANE'
  projectId: string
  zone: string
  instanceName: string
  numericInstanceId: string
  selfLink: string
  evidenceDigest: string
}>

export type ComputeInstanceIdentityResult =
  | Readonly<{ ok: true; observation: ComputeInstanceIdentityObservation }>
  | Readonly<{ ok: false; error: Readonly<{ code: ComputeInstanceIdentityErrorCode }> }>

export type ComputeInstanceIdentityClient = Readonly<{
  observe(input: ComputeInstanceIdentityInput, signal?: AbortSignal): Promise<ComputeInstanceIdentityResult>
}>

export type CapturedComputeIdentityConfiguration = Readonly<{
  projectId: string
  timeoutMs: number
  readAccessToken: (signal: AbortSignal) => Promise<string>
  request: typeof request
}>

export function identityFailure(code: ComputeInstanceIdentityErrorCode):
  Readonly<{ ok: false; error: Readonly<{ code: ComputeInstanceIdentityErrorCode }> }> {
  return Object.freeze({ ok: false, error: Object.freeze({ code }) })
}
