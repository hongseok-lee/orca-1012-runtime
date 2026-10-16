import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import WebSocket from 'ws'
import { canonicalInput } from '../runtime/gateway/input.ts'
import { awaitPodAuthValue } from '../runtime/kubernetes-pod-auth-transport.ts'
import { inventoryDataset, inventoryNamespace } from '../lifecycle/kubernetes-identity.ts'
import { defaultAgentPodCreateHttps, exchangeAgentPodCreate } from '../lifecycle/agent-pod-create-transport.ts'
import { AgentPodCreateError } from '../lifecycle/agent-pod-create-types.ts'
import { captureAgentMountInput, projectAgentMountPod, projectAgentMountPvc, projectAgentMountPv,
  agentMountIncarnation, agentMountMapping } from './agent-mount-collector-projection.ts'
import { collectAgentMountExec } from './agent-mount-collector-exec.ts'
import { agentMountProbeSha256, projectAgentMountOutput } from './agent-mount-collector-probe.ts'
import { AgentMountCollectorError } from './agent-mount-collector-types.ts'
import type { AgentMountCollect, AgentMountCollectorConfig, AgentMountCollectorDependencies, AgentMountStorage } from './agent-mount-collector-types.ts'

export { AgentMountCollectorError } from './agent-mount-collector-types.ts'
export type { AgentMountCollectorConfig, AgentMountCollectorDependencies, AuthenticatedAgentMountObservation } from './agent-mount-collector-types.ts'
const defaults: AgentMountCollectorDependencies = {
  https: defaultAgentPodCreateHttps,
  openWebSocket: (url, protocol, options) => new WebSocket(url, protocol, options),
}

/** Authenticated consumer snapshots only. No physical issuer, transaction hold, provider or controller activation. */
export function createAgentMountCollector(caller: AgentMountCollectorConfig, dependencies: AgentMountCollectorDependencies = defaults): Readonly<{ collect: AgentMountCollect }> {
  let config: AgentMountCollectorConfig, captured: AgentMountCollectorDependencies, ca: Buffer
  try {
    const input = { apiOrigin: caller.apiOrigin, ca: caller.ca, namespace: caller.namespace, dataset: caller.dataset,
      timeoutMs: caller.timeoutMs, readReviewerBearer: caller.readReviewerBearer }, origin = new URL(input.apiOrigin)
    const https = dependencies.https, request = https.request, open = dependencies.openWebSocket
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
        input.apiOrigin !== origin.origin && input.apiOrigin !== `${origin.origin}/` ||
        !(input.ca instanceof Uint8Array) || !input.ca.byteLength || typeof input.readReviewerBearer !== 'function' ||
        typeof request !== 'function' || typeof open !== 'function' || !Number.isSafeInteger(input.timeoutMs) ||
        input.timeoutMs <= 0 || input.timeoutMs > 2_147_483_647) { throw new AgentMountCollectorError('CONFIG_INVALID') }
    ca = Buffer.from(input.ca)
    config = Object.freeze({ ...input, apiOrigin: origin.origin, ca: Buffer.from(ca),
      namespace: inventoryNamespace(input.namespace), dataset: inventoryDataset(input.dataset),
      readReviewerBearer: input.readReviewerBearer.bind(caller) })
    captured = Object.freeze({ https: Object.freeze({ request: request.bind(https) }), openWebSocket: open.bind(dependencies) })
  } catch { throw new AgentMountCollectorError('CONFIG_INVALID') }
  const reader = config.readReviewerBearer
  return Object.freeze({ collect: async (record, podUid, signal) => {
    const deadline = performance.now() + config.timeoutMs
    // Detach all original plan, path and UID data before the first credential await.
    const input = captureAgentMountInput(record, podUid, config), controller = new AbortController()
    let expired = false, bearer = ''
    const abort = () => controller.abort()
    const timer = setTimeout(() => { expired = true; controller.abort() }, Math.max(0, deadline - performance.now()))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { controller.abort() }
    function check(): void {
      if (signal.aborted) { throw new AgentMountCollectorError('ABORTED') }
      if (expired || performance.now() >= deadline) { controller.abort(); throw new AgentMountCollectorError('TIMEOUT') }
      if (controller.signal.aborted) { throw new AgentMountCollectorError('ABORTED') }
    }
    async function get(path: string): Promise<unknown> {
      check()
      const response = await exchangeAgentPodCreate(captured.https, config.apiOrigin, ca, path, bearer, undefined, controller.signal)
      check()
      if (response.status !== 200) { throw new AgentMountCollectorError('HTTP_FAILED') }
      return response.value
    }
    const namespaced = `/api/v1/namespaces/${encodeURIComponent(config.namespace)}`
    const podPath = `${namespaced}/pods/${encodeURIComponent(input.original.name)}`
    async function storage(): Promise<readonly AgentMountStorage[]> {
      const result: AgentMountStorage[] = []
      for (const expected of input.mounts) {
        const pvc = projectAgentMountPvc(await get(`${namespaced}/persistentvolumeclaims/${encodeURIComponent(expected.claimName)}`), expected, config.namespace)
        const pv = await get(`/api/v1/persistentvolumes/${encodeURIComponent(pvc.volumeName)}`)
        result.push(projectAgentMountPv(pv, pvc, expected, config.namespace))
      }
      check()
      return Object.freeze(result)
    }
    try {
      check()
      let supply: Promise<string>
      try { supply = Promise.resolve(reader.call(config, controller.signal)) }
      catch { throw new AgentMountCollectorError('CREDENTIAL_FAILED') }
      try { bearer = await awaitPodAuthValue(supply, controller.signal) }
      catch { check(); throw new AgentMountCollectorError('CREDENTIAL_FAILED') }
      check()
      if (typeof bearer !== 'string' || !/^[A-Za-z0-9\-._~+/]+=*$/u.test(bearer)) { throw new AgentMountCollectorError('CREDENTIAL_FAILED') }
      const pod = projectAgentMountPod(await get(podPath), input), first = await storage()
      const text = await collectAgentMountExec(captured.openWebSocket, { ...config, ca: Buffer.from(ca) }, input, bearer, controller.signal, deadline)
      check()
      const mounts = projectAgentMountOutput(text, input.mounts)
      check()
      const last = await storage()
      if (first.some((value, index) => agentMountMapping(value) !== agentMountMapping(last[index]))) { throw new AgentMountCollectorError('STORAGE_CHANGED') }
      const finalPod = projectAgentMountPod(await get(podPath), input)
      if (agentMountIncarnation(pod) !== agentMountIncarnation(finalPod)) { throw new AgentMountCollectorError('POD_CHANGED') }
      const evidence = { kind: 'AUTHENTICATED_AGENT_MOUNT_OBSERVATION' as const, namespace: config.namespace, dataset: config.dataset,
        planDigest: input.original.planDigest, pod, finalPod, storage: first, finalStorage: last, mounts,
        observedAt: new Date().toISOString(), probeDigest: agentMountProbeSha256,
        namespacePin: false as const, writerGrantIssued: false as const, providerReady: false as const }
      const evidenceDigest = createHash('sha256').update(canonicalInput({ ...evidence,
        storage: [...first], finalStorage: [...last], mounts: [...mounts] })).digest('hex')
      check()
      return Object.freeze({ ...evidence, evidenceDigest, reference: `agent-mount-sha256:${evidenceDigest}` })
    } catch (error) {
      check()
      if (error instanceof AgentMountCollectorError) { throw error }
      if (error instanceof AgentPodCreateError) {
        switch (error.code) {
          case 'HTTP_FORBIDDEN': case 'HTTP_FAILED': case 'TLS_FAILED': case 'NETWORK_FAILED': case 'RESPONSE_INVALID':
          case 'ABORTED': case 'TIMEOUT': throw new AgentMountCollectorError(error.code)
        }
      }
      throw new AgentMountCollectorError('RESPONSE_INVALID')
    } finally {
      bearer = ''; clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort()
    }
  } })
}
