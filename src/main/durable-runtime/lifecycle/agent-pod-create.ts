import { performance } from 'node:perf_hooks'
import { awaitPodAuthValue } from '../runtime/kubernetes-pod-auth-transport.ts'
import { inventoryDataset, inventoryNamespace } from './kubernetes-identity.ts'
import { captureAgentPodCreateInput, projectAgentPodCreate } from './agent-pod-create-projection.ts'
import { defaultAgentPodCreateHttps, exchangeAgentPodCreate } from './agent-pod-create-transport.ts'
import { AgentPodCreateError } from './agent-pod-create-types.ts'
import type { AgentPodCreateConfig, AgentPodCreateHttps, AgentPodCreateInput, AgentPodCreateObservation } from './agent-pod-create-types.ts'

export { AgentPodCreateError } from './agent-pod-create-types.ts'
export type { AgentPodCreateConfig, AgentPodCreateInput, AgentPodCreateObservation } from './agent-pod-create-types.ts'

/** Server-internal effect transport, not a claim/COMMIT/grant/physical-pin issuer. No controller caller yet. */
export function createAgentPodCreateTransport(caller: AgentPodCreateConfig,
  originalTransport: AgentPodCreateHttps = defaultAgentPodCreateHttps) {
  let config: AgentPodCreateConfig, ca: Buffer, transport: AgentPodCreateHttps
  try {
    const input = { apiOrigin: caller.apiOrigin, ca: caller.ca, namespace: caller.namespace, dataset: caller.dataset,
      timeoutMs: caller.timeoutMs, readBearerToken: caller.readBearerToken }, origin = new URL(input.apiOrigin)
    const request = originalTransport.request
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
        input.apiOrigin !== origin.origin && input.apiOrigin !== `${origin.origin}/` ||
        !(input.ca instanceof Uint8Array) || !input.ca.byteLength || typeof input.readBearerToken !== 'function' ||
        typeof request !== 'function' || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 2_147_483_647) {
      throw new AgentPodCreateError('CONFIG_INVALID')
    }
    ca = Buffer.from(input.ca)
    // Keep the original credential method and its receiver, with a separate internal CA copy.
    config = Object.freeze({ ...input, apiOrigin: origin.origin, ca: Buffer.from(ca),
      namespace: inventoryNamespace(input.namespace), dataset: inventoryDataset(input.dataset),
      readBearerToken: input.readBearerToken.bind(caller) })
    transport = Object.freeze({ request: request.bind(originalTransport) })
  } catch { throw new AgentPodCreateError('CONFIG_INVALID') }
  const readBearerToken = config.readBearerToken
  const collectionPath = `/api/v1/namespaces/${encodeURIComponent(config.namespace)}/pods`
  return Object.freeze({ async observeOrCreate(original: AgentPodCreateInput, signal: AbortSignal): Promise<AgentPodCreateObservation> {
    const started = performance.now()
    const input = captureAgentPodCreateInput(original, config.namespace, config.dataset)
    const controller = new AbortController(), duration = Math.min(config.timeoutMs, input.remainingMs), deadline = started + duration
    let expired = false, postAttempts: 0 | 1 = 0
    const abort = () => controller.abort()
    const timer = setTimeout(() => { expired = true; controller.abort() }, duration)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { controller.abort() }
    function check(): void {
      if (signal.aborted) { throw new AgentPodCreateError('ABORTED') }
      if (expired || performance.now() >= deadline) { controller.abort(); throw new AgentPodCreateError('TIMEOUT') }
      if (controller.signal.aborted) { throw new AgentPodCreateError('ABORTED') }
    }
    function result(disposition: AgentPodCreateObservation['disposition'], pod: AgentPodCreateObservation['pod'] = null,
      reason?: AgentPodCreateObservation['reason']): AgentPodCreateObservation {
      return Object.freeze({ kind: 'AGENT_POD_CREATE_OBSERVATION', disposition, planDigest: input.planDigest,
        namespace: input.namespace, name: input.name, pod, postAttempts, ...(reason ? { reason } : {}),
        readinessObserved: false, physicalPinVerified: false })
    }
    function project(value: unknown, disposition: 'FOUND' | 'CREATED'): AgentPodCreateObservation {
      let pod: AgentPodCreateObservation['pod'] = null
      let conflict = false
      try { pod = projectAgentPodCreate(value, input) } catch (error) {
        if (error instanceof AgentPodCreateError && error.code === 'RESPONSE_INVALID') { throw error }
        conflict = true
      }
      check()
      return conflict ? result('CONFLICT', null, 'POD_CONFLICT') : result(disposition, pod)
    }
    try {
      check()
      let supply: Promise<string>
      try { supply = Promise.resolve(readBearerToken.call(config, controller.signal)) }
      catch { throw new AgentPodCreateError('CREDENTIAL_FAILED') }
      let bearer: string
      try { bearer = await awaitPodAuthValue(supply, controller.signal) }
      catch { check(); throw new AgentPodCreateError('CREDENTIAL_FAILED') }
      check()
      if (typeof bearer !== 'string' || !/^[A-Za-z0-9\-._~+/]+=*$/u.test(bearer)) { throw new AgentPodCreateError('CREDENTIAL_FAILED') }
      const originalPath = `${collectionPath}/${encodeURIComponent(input.name)}`
      const first = await exchangeAgentPodCreate(transport, config.apiOrigin, ca, originalPath, bearer, undefined, controller.signal)
      check()
      if (first.status === 200) { return project(first.value, 'FOUND') }
      if (input.mode === 'LOOKUP_ONLY') { return result('ABSENT') }
      check()
      postAttempts = 1
      const created = await exchangeAgentPodCreate(transport, config.apiOrigin, ca, collectionPath, bearer, input.body, controller.signal)
      check()
      if (created.status === 201) { return project(created.value, 'CREATED') }
      // Only 409 reaches here; recover the original name once, never create another name/attempt.
      const recovered = await exchangeAgentPodCreate(transport, config.apiOrigin, ca, originalPath, bearer, undefined, controller.signal)
      check()
      return recovered.status === 200 ? project(recovered.value, 'FOUND') : result('UNKNOWN', null, 'CONFLICT_LOOKUP_ABSENT')
    } catch (error) {
      let failure = error instanceof AgentPodCreateError ? error : new AgentPodCreateError('RESPONSE_INVALID')
      if (signal.aborted) { failure = new AgentPodCreateError('ABORTED') }
      else if (expired || performance.now() >= deadline) { failure = new AgentPodCreateError('TIMEOUT') }
      if (postAttempts === 1) { return result('UNKNOWN', null, failure.code) }
      throw failure
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort()
    }
  } })
}
