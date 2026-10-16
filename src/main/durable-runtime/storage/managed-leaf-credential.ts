import { performance } from 'node:perf_hooks'
import { TextDecoder } from 'node:util'
import { inventoryNamespace, inventoryName, inventoryOpaque, inventoryRecord } from '../lifecycle/kubernetes-identity.ts'
import { bearerValid } from '../runtime/kubernetes-pod-auth-projection.ts'
import { awaitPodAuthValue, defaultPodAuthHttps, exchangePodAuth } from '../runtime/kubernetes-pod-auth-transport.ts'
import { KubernetesPodAuthError } from '../runtime/kubernetes-pod-auth-types.ts'
import type { KubernetesPodAuthHttps } from '../runtime/kubernetes-pod-auth-types.ts'

export type ManagedLeafCredentialCode = 'CONFIG_INVALID' | 'ISSUER_CREDENTIAL_FAILED' | 'RESPONSE_INVALID' |
  'SERVICE_ACCOUNT_MISMATCH' | 'TOKEN_EXPIRED' | 'HTTP_FORBIDDEN' | 'HTTP_FAILED' | 'TLS_FAILED' |
  'NETWORK_FAILED' | 'TIMEOUT' | 'ABORTED'

/** No token/JWT, response, CA, URL or underlying cause is retained. */
export class ManagedLeafCredentialError extends Error {
  constructor(readonly code: ManagedLeafCredentialCode) {
    super(`MANAGED_LEAF_CREDENTIAL_${code}`)
    this.name = 'ManagedLeafCredentialError'
  }
}
export type ManagedLeafCredentialConfig = Readonly<{
  apiOrigin: string; ca: Uint8Array; namespace: string; serviceAccountName: string; serviceAccountUid: string; timeoutMs: number
  readIssuerBearer(this: ManagedLeafCredentialConfig, signal: AbortSignal): string | Promise<string>
}>
type CapturedConfig = Readonly<Omit<ManagedLeafCredentialConfig, 'readIssuerBearer'> & {
  readIssuerBearer: (signal: AbortSignal) => string | Promise<string>
}>

function fail(code: ManagedLeafCredentialCode): never { throw new ManagedLeafCredentialError(code) }
function expiration(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.[0-9]{1,9})?Z$/u.test(value)) { return fail('RESPONSE_INVALID') }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)) { return fail('RESPONSE_INVALID') }
  return parsed
}
function payload(value: string): Record<string, unknown> {
  const segments = value.split('.')
  if (segments.length !== 3 || segments.some(part => !/^[A-Za-z0-9_-]+$/u.test(part))) { return fail('RESPONSE_INVALID') }
  const bytes = Buffer.from(segments[1], 'base64url')
  if (bytes.toString('base64url') !== segments[1]) { return fail('RESPONSE_INVALID') }
  return inventoryRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
}

/** Consistency of a verified-TLS API response, not independent JWT signature authentication. */
function project(value: unknown, config: CapturedConfig, remainingMs: number): string {
  try {
    const object = inventoryRecord(value), metadata = inventoryRecord(object.metadata), status = inventoryRecord(object.status)
    if (object.apiVersion !== 'authentication.k8s.io/v1' || object.kind !== 'TokenRequest') { return fail('RESPONSE_INVALID') }
    if (metadata.namespace !== config.namespace || metadata.name !== config.serviceAccountName || metadata.uid !== config.serviceAccountUid) {
      return fail('SERVICE_ACCOUNT_MISMATCH')
    }
    const token = status.token
    if (!bearerValid(token)) { return fail('RESPONSE_INVALID') }
    const claims = payload(token), kubernetes = inventoryRecord(claims['kubernetes.io']), account = inventoryRecord(kubernetes.serviceaccount)
    if (claims.sub !== `system:serviceaccount:${config.namespace}:${config.serviceAccountName}` || account.uid !== config.serviceAccountUid) {
      return fail('SERVICE_ACCOUNT_MISMATCH')
    }
    const expiresAt = expiration(status.expirationTimestamp), now = Date.now(), minimum = now + remainingMs
    if (expiresAt <= now || expiresAt < minimum) {
      return fail('TOKEN_EXPIRED')
    }
    return token
  } catch (error) {
    throw error instanceof ManagedLeafCredentialError ? error : new ManagedLeafCredentialError('RESPONSE_INVALID')
  }
}

/** Internal composition only. No cache, retry, bound Pod, physical proof or public credential issuer. */
export function createManagedLeafCredentialReader(caller: ManagedLeafCredentialConfig,
  originalTransport: KubernetesPodAuthHttps = defaultPodAuthHttps): Readonly<{ readReviewerBearer(signal: AbortSignal): Promise<string> }> {
  let config: CapturedConfig, ca: Buffer, transport: KubernetesPodAuthHttps
  try {
    const input = { apiOrigin: caller.apiOrigin, ca: caller.ca, namespace: caller.namespace, serviceAccountName: caller.serviceAccountName,
      serviceAccountUid: caller.serviceAccountUid, timeoutMs: caller.timeoutMs, readIssuerBearer: caller.readIssuerBearer }
    const origin = new URL(input.apiOrigin), request = originalTransport.request
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
        input.apiOrigin !== origin.origin && input.apiOrigin !== `${origin.origin}/` ||
        !(input.ca instanceof Uint8Array) || !input.ca.byteLength || typeof input.readIssuerBearer !== 'function' || typeof request !== 'function' ||
        !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 2_147_483_647) { return fail('CONFIG_INVALID') }
    ca = Buffer.from(input.ca)
    config = Object.freeze({ ...input, apiOrigin: origin.origin, ca: Buffer.from(ca), namespace: inventoryNamespace(input.namespace),
      serviceAccountName: inventoryName(input.serviceAccountName), serviceAccountUid: inventoryOpaque(input.serviceAccountUid),
      readIssuerBearer: input.readIssuerBearer.bind(caller) })
    transport = Object.freeze({ request: request.bind(originalTransport) })
  } catch { throw new ManagedLeafCredentialError('CONFIG_INVALID') }
  const readIssuer = config.readIssuerBearer
  const path = `/api/v1/namespaces/${encodeURIComponent(config.namespace)}/serviceaccounts/${encodeURIComponent(config.serviceAccountName)}/token`
  const body = JSON.stringify({ apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest',
    metadata: { name: config.serviceAccountName, namespace: config.namespace, uid: config.serviceAccountUid },
    spec: { audiences: [], expirationSeconds: 600 } })

  return Object.freeze({ async readReviewerBearer(signal: AbortSignal): Promise<string> {
    const deadline = performance.now() + config.timeoutMs, controller = new AbortController()
    let expired = false
    const abort = () => controller.abort()
    const timer = setTimeout(() => { expired = true; controller.abort() }, Math.max(0, deadline - performance.now()))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { controller.abort() }
    function remaining(): number {
      if (signal.aborted) { return fail('ABORTED') }
      const budget = deadline - performance.now()
      if (expired || budget <= 0) { controller.abort(); return fail('TIMEOUT') }
      if (controller.signal.aborted) { return fail('ABORTED') }
      return budget
    }
    try {
      remaining()
      let supply: Promise<string>
      try { supply = Promise.resolve(readIssuer(controller.signal)) }
      catch { return fail('ISSUER_CREDENTIAL_FAILED') }
      let issuer: string
      try { issuer = await awaitPodAuthValue(supply, controller.signal) }
      catch { remaining(); return fail('ISSUER_CREDENTIAL_FAILED') }
      remaining()
      if (!bearerValid(issuer)) { return fail('ISSUER_CREDENTIAL_FAILED') }
      const response = await exchangePodAuth(transport, config.apiOrigin, ca, path, issuer, body, 'POD_NOT_FOUND', controller.signal)
      const token = project(response, config, remaining())
      remaining()
      return token
    } catch (error) {
      if (signal.aborted) { return fail('ABORTED') }
      if (expired || performance.now() >= deadline) { return fail('TIMEOUT') }
      if (error instanceof ManagedLeafCredentialError) { throw error }
      if (error instanceof KubernetesPodAuthError) {
        if (['HTTP_FORBIDDEN', 'HTTP_FAILED', 'TLS_FAILED', 'NETWORK_FAILED'].includes(error.code)) {
          switch (error.code) {
            case 'HTTP_FORBIDDEN': return fail('HTTP_FORBIDDEN')
            case 'HTTP_FAILED': return fail('HTTP_FAILED')
            case 'TLS_FAILED': return fail('TLS_FAILED')
            case 'NETWORK_FAILED': return fail('NETWORK_FAILED')
          }
        }
      }
      return fail('RESPONSE_INVALID')
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort()
    }
  } })
}
