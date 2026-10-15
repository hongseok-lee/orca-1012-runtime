import { performance } from 'node:perf_hooks'
import { inventoryDataset, inventoryNamespace, inventoryOpaque } from '../lifecycle/kubernetes-identity.ts'
import { authenticatedPodObservation, bearerValid, capturePodAuthInput, projectAuthenticatedNode,
  projectAuthenticatedPod, projectTokenReview } from './kubernetes-pod-auth-projection.ts'
import { awaitPodAuthValue, defaultPodAuthHttps, exchangePodAuth } from './kubernetes-pod-auth-transport.ts'
import { KubernetesPodAuthError } from './kubernetes-pod-auth-types.ts'
import type { AuthenticatedPodObservation, KubernetesPodAuthConfig, KubernetesPodAuthHttps,
  KubernetesPodAuthInput } from './kubernetes-pod-auth-types.ts'

export { KubernetesPodAuthError } from './kubernetes-pod-auth-types.ts'
export type { AuthenticatedPodObservation, KubernetesPodAuthConfig, KubernetesPodAuthExpected,
  KubernetesPodAuthInput } from './kubernetes-pod-auth-types.ts'

/** Trusted server composition only; an observation, never a RuntimePort identity brand or permit. */
export function createKubernetesPodAuthenticator(caller: KubernetesPodAuthConfig,
  transport: KubernetesPodAuthHttps = defaultPodAuthHttps): Readonly<{
    authenticatePod(input: KubernetesPodAuthInput, signal: AbortSignal): Promise<AuthenticatedPodObservation>
  }> {
  let config: Readonly<KubernetesPodAuthConfig>, ca: Buffer
  let request: KubernetesPodAuthHttps['request']
  try {
    const origin = new URL(caller.apiOrigin)
    const input = { apiOrigin: caller.apiOrigin, ca: caller.ca, clusterIdentityRef: caller.clusterIdentityRef,
      audience: caller.audience, namespace: caller.namespace, dataset: caller.dataset,
      timeoutMs: caller.timeoutMs, readReviewerBearer: caller.readReviewerBearer }
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash ||
        origin.pathname !== '/' || (input.apiOrigin !== origin.origin && input.apiOrigin !== `${origin.origin}/`) ||
        !(input.ca instanceof Uint8Array) || !input.ca.byteLength || typeof input.readReviewerBearer !== 'function' ||
        !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 2_147_483_647 ||
        typeof transport.request !== 'function') { throw new KubernetesPodAuthError('CONFIG_INVALID') }
    ca = Buffer.from(input.ca)
    config = Object.freeze({ apiOrigin: origin.origin, ca: Buffer.from(ca),
      clusterIdentityRef: inventoryOpaque(input.clusterIdentityRef), audience: inventoryOpaque(input.audience),
      namespace: inventoryNamespace(input.namespace), dataset: inventoryDataset(input.dataset),
      timeoutMs: input.timeoutMs, readReviewerBearer: input.readReviewerBearer.bind(caller) })
    request = transport.request.bind(transport)
  } catch { throw new KubernetesPodAuthError('CONFIG_INVALID') }
  const capturedTransport = Object.freeze({ request })
  const readReviewer = config.readReviewerBearer
  return Object.freeze({ async authenticatePod(callerInput: KubernetesPodAuthInput, signal: AbortSignal) {
    const input = capturePodAuthInput(callerInput), expected = input.expected
    const deadline = performance.now() + config.timeoutMs
    const controller = new AbortController()
    let expired = false
    const abort = () => controller.abort()
    const timer = setTimeout(() => { expired = true; controller.abort() }, config.timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { controller.abort() }
    const checkDeadline = (): void => {
      if (signal.aborted) { controller.abort(); throw new KubernetesPodAuthError('ABORTED') }
      if (expired || performance.now() >= deadline) {
        expired = true
        controller.abort()
        throw new KubernetesPodAuthError('TIMEOUT')
      }
      if (controller.signal.aborted) { throw new KubernetesPodAuthError('ABORTED') }
    }
    try {
      checkDeadline()
      // Promise conversion preserves synchronous supplier errors without leaking the original cause.
      let supply: Promise<string>
      try { supply = Promise.resolve(readReviewer.call(caller, controller.signal)) }
      catch { throw new KubernetesPodAuthError('REVIEWER_CREDENTIAL_FAILED') }
      const reviewer = await awaitPodAuthValue(supply, controller.signal)
      checkDeadline()
      if (!bearerValid(reviewer)) { throw new KubernetesPodAuthError('REVIEWER_CREDENTIAL_FAILED') }
      const payload = JSON.stringify({ apiVersion: 'authentication.k8s.io/v1', kind: 'TokenReview',
        spec: { token: input.podBearer, audiences: [config.audience] } })
      checkDeadline()
      const reviewValue = await exchangePodAuth(capturedTransport, config.apiOrigin, ca,
        '/apis/authentication.k8s.io/v1/tokenreviews', reviewer, payload, 'POD_NOT_FOUND', controller.signal)
      checkDeadline()
      const claims = projectTokenReview(reviewValue, config, expected)
      checkDeadline()
      const podValue = await exchangePodAuth(capturedTransport, config.apiOrigin, ca,
        `/api/v1/namespaces/${encodeURIComponent(config.namespace)}/pods/${encodeURIComponent(expected.podName)}`,
        reviewer, undefined, 'POD_NOT_FOUND', controller.signal)
      checkDeadline()
      const pod = projectAuthenticatedPod(podValue, config, expected, claims)
      checkDeadline()
      const nodeValue = await exchangePodAuth(capturedTransport, config.apiOrigin, ca,
        `/api/v1/nodes/${encodeURIComponent(claims.nodeName)}`, reviewer, undefined, 'NODE_NOT_FOUND', controller.signal)
      checkDeadline()
      const node = projectAuthenticatedNode(nodeValue, claims)
      const observation = authenticatedPodObservation(config, expected, pod, node)
      checkDeadline()
      return observation
    } catch (error) {
      if (signal.aborted) { throw new KubernetesPodAuthError('ABORTED') }
      if (expired || performance.now() >= deadline) { throw new KubernetesPodAuthError('TIMEOUT') }
      throw error instanceof KubernetesPodAuthError ? error : new KubernetesPodAuthError('RESPONSE_INVALID')
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      controller.abort()
    }
  } })
}
