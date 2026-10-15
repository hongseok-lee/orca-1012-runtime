import type { EventEmitter } from 'node:events'
import type { RequestOptions } from 'node:https'

export type KubernetesPodAuthErrorCode = 'CONFIG_INVALID' | 'INPUT_INVALID' | 'AUTHENTICATION_DENIED' |
  'TOKEN_REVIEW_INVALID' | 'AUDIENCE_MISMATCH' | 'SERVICE_ACCOUNT_MISMATCH' | 'POD_IDENTITY_MISMATCH' |
  'NODE_IDENTITY_MISMATCH' | 'RESOURCE_DELETING' | 'POD_NOT_FOUND' | 'NODE_NOT_FOUND' |
  'HTTP_FORBIDDEN' | 'HTTP_FAILED' | 'TLS_FAILED' | 'NETWORK_FAILED' | 'RESPONSE_INVALID' |
  'REVIEWER_CREDENTIAL_FAILED' | 'TIMEOUT' | 'ABORTED'

/** Deliberately contains neither response/cause nor request/credential. */
export class KubernetesPodAuthError extends Error {
  readonly code: KubernetesPodAuthErrorCode
  constructor(code: KubernetesPodAuthErrorCode) {
    super(`KUBERNETES_POD_AUTH_${code}`)
    this.name = 'KubernetesPodAuthError'
    this.code = code
  }
}

export type KubernetesPodAuthConfig = {
  readonly apiOrigin: string
  readonly ca: Uint8Array
  readonly clusterIdentityRef: string
  readonly audience: string
  readonly namespace: string
  readonly dataset: string
  readonly timeoutMs: number
  readonly readReviewerBearer: (this: Readonly<KubernetesPodAuthConfig>, signal: AbortSignal) => string | Promise<string>
}
export type KubernetesPodAuthExpected = {
  readonly serviceAccountName: string
  readonly serviceAccountUid: string
  readonly podName: string
  readonly podUid: string
  readonly runtimeUnitId: string
  readonly operationId: string
  readonly executionEpoch: string
  readonly specHash: string
  readonly nodeName?: string
  readonly nodeUid?: string
}
export type KubernetesPodAuthInput = {
  readonly podBearer: string
  readonly expected: KubernetesPodAuthExpected
}
export type AuthenticatedPodObservation = {
  readonly kind: 'AUTHENTICATED_POD_OBSERVATION'
  readonly clusterIdentityRef: string
  readonly namespace: string
  readonly dataset: string
  readonly audience: string
  readonly serviceAccount: Readonly<{ name: string; uid: string }>
  readonly pod: Readonly<{ name: string; uid: string; resourceVersion: string; runtimeUnitId: string;
    operationId: string; executionEpoch: string; specHash: string }>
  readonly node: Readonly<{ name: string; uid: string; resourceVersion: string;
    observationSource: 'KUBERNETES_API'; providerId?: string; instanceId?: string }>
  readonly evidenceDigest: string
}

// Trusted composition dependency, never a property accepted from an RPC caller.
export type PodAuthResponse = EventEmitter & { readonly statusCode?: number; destroy(): void }
export type PodAuthRequest = EventEmitter & { destroy(): void; end(body?: string): void }
export type KubernetesPodAuthHttps = {
  request(url: URL, options: RequestOptions, callback: (response: PodAuthResponse) => void): PodAuthRequest
}
