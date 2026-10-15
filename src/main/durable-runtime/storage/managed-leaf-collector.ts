import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import WebSocket from 'ws'
import { awaitPodAuthValue, defaultPodAuthHttps, exchangePodAuth } from '../runtime/kubernetes-pod-auth-transport.ts'
import { bearerValid } from '../runtime/kubernetes-pod-auth-projection.ts'
import { KubernetesPodAuthError } from '../runtime/kubernetes-pod-auth-types.ts'
import { captureManagedLeafConfig, managedLeafUuid } from './managed-leaf-collector-config.ts'
import { collectManagedLeafExec } from './managed-leaf-collector-exec.ts'
import { managedLeafPodIncarnation, projectManagedLeafPod } from './managed-leaf-collector-pod.ts'
import { projectManagedLeafStorage } from './managed-leaf-collector-resources.ts'
import { projectManagedLeafOutput } from './managed-leaf-collector-output.ts'
import { ManagedLeafCollectorError } from './managed-leaf-collector-types.ts'
import type { AuthenticatedManagedLeafObservation, ManagedLeafCollectorConfig, ManagedLeafCollectorDependencies } from './managed-leaf-collector-types.ts'

export { ManagedLeafCollectorError } from './managed-leaf-collector-types.ts'
export type { AuthenticatedManagedLeafObservation, ManagedLeafCollectorConfig, ManagedLeafCollectorDependencies } from './managed-leaf-collector-types.ts'

const defaults: ManagedLeafCollectorDependencies = Object.freeze({ https: defaultPodAuthHttps,
  openWebSocket: (url, protocol, options) => new WebSocket(url, protocol, options) })

/** Authenticated collection only. This factory issues no lifetime pin or StorageEvidenceAuthority brand. */
export function createManagedLeafCollector(caller: ManagedLeafCollectorConfig,
  dependencies: ManagedLeafCollectorDependencies = defaults): Readonly<{
    collect(leafId: string, signal: AbortSignal): Promise<AuthenticatedManagedLeafObservation>
  }> {
  const config = captureManagedLeafConfig(caller)
  let transport: ManagedLeafCollectorDependencies['https'], open: ManagedLeafCollectorDependencies['openWebSocket']
  try {
    const https = dependencies.https
    transport = Object.freeze({ request: https.request.bind(https) })
    open = dependencies.openWebSocket.bind(dependencies)
  } catch { throw new ManagedLeafCollectorError('CONFIG_INVALID') }
  return Object.freeze({ async collect(input: string, signal: AbortSignal) {
    const deadline = performance.now() + config.timeoutMs, leafId = managedLeafUuid(input)
    const controller = new AbortController(), abort = () => controller.abort()
    const timer = setTimeout(abort, config.timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    const check = (): void => {
      if (signal.aborted) { controller.abort(); throw new ManagedLeafCollectorError('ABORTED') }
      if (controller.signal.aborted || performance.now() >= deadline) {
        controller.abort(); throw new ManagedLeafCollectorError('TIMEOUT')
      }
    }
    const get = async (path: string): Promise<unknown> => {
      check()
      const value = await exchangePodAuth(transport, config.apiOrigin, config.ca, path, reviewer,
        undefined, 'POD_NOT_FOUND', controller.signal)
      check(); return value
    }
    let reviewer = ''
    try {
      check()
      let supply: Promise<string>
      try { supply = Promise.resolve(config.readReviewerBearer(controller.signal)) }
      catch { throw new ManagedLeafCollectorError('CREDENTIAL_FAILED') }
      reviewer = await awaitPodAuthValue(supply, controller.signal)
      check()
      if (!bearerValid(reviewer) || reviewer.trim() !== reviewer) { throw new ManagedLeafCollectorError('CREDENTIAL_FAILED') }
      const namespace = `/api/v1/namespaces/${encodeURIComponent(config.namespace)}`
      const podPath = `${namespace}/pods/${encodeURIComponent(config.podName)}`
      const pod = projectManagedLeafPod(await get(podPath), config)
      const pvc = await get(`${namespace}/persistentvolumeclaims/${encodeURIComponent(config.pvcName)}`)
      const pv = await get(`/api/v1/persistentvolumes/${encodeURIComponent(config.pvName)}`)
      const helper = await get(`${namespace}/configmaps/${encodeURIComponent(config.helperConfigMapName)}`)
      const storage = projectManagedLeafStorage(pvc, pv, helper, config)
      check()
      const stdout = await collectManagedLeafExec(open, config, leafId, reviewer, controller.signal, deadline)
      check()
      const finalPod = projectManagedLeafPod(await get(podPath), config)
      if (managedLeafPodIncarnation(pod) !== managedLeafPodIncarnation(finalPod)) { throw new ManagedLeafCollectorError('POD_CHANGED') }
      const output = projectManagedLeafOutput(stdout, config, leafId, pod), observedAt = new Date().toISOString()
      const evidenceDigest = createHash('sha256').update(JSON.stringify({ cluster: config.clusterIdentityRef,
        namespace: config.namespace, dataset: config.dataset, leafId, pod, finalPod, storage,
        candidate: output.candidate, outputDigest: output.outputDigest, observedAt })).digest('hex')
      check()
      return Object.freeze({ kind: 'AUTHENTICATED_MANAGED_LEAF_OBSERVATION', clusterIdentityRef: config.clusterIdentityRef,
        namespace: config.namespace, dataset: config.dataset, leafId, candidate: output.candidate, pod,
        finalPodResourceVersion: finalPod.resourceVersion, storage, observedAt, evidenceDigest,
        reference: `managed-leaf-observation:sha256:${evidenceDigest}`, namespacePin: false })
    } catch (error) {
      check()
      if (error instanceof ManagedLeafCollectorError) { throw error }
      if (error instanceof KubernetesPodAuthError) {
        if (error.code === 'TLS_FAILED' || error.code === 'NETWORK_FAILED' || error.code === 'RESPONSE_INVALID') {
          throw new ManagedLeafCollectorError(error.code)
        }
        if (error.code === 'REVIEWER_CREDENTIAL_FAILED') { throw new ManagedLeafCollectorError('CREDENTIAL_FAILED') }
        throw new ManagedLeafCollectorError('HTTP_FAILED')
      }
      throw new ManagedLeafCollectorError('RESPONSE_INVALID')
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort(); reviewer = ''
    }
  } })
}
