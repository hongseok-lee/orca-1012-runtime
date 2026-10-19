import { defaultPodAuthHttps, exchangePodAuth } from './kubernetes-pod-auth-transport.ts'
import type { KubernetesPodAuthHttps } from './kubernetes-pod-auth-types.ts'
import { WRITER_STOP_FINALIZER, type AgentPodApi, type AgentPodIdentity } from './agent-pod-stop-evidence.ts'

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {}
export type AgentPodRetirementResult = 'REQUESTED' | 'ABSENT' | 'CONFLICT' | 'UNKNOWN'

/** A bounded mutation response is only a request receipt, never a stop proof. */
async function mutate(api: AgentPodApi, target: AgentPodIdentity, method: 'DELETE' | 'PATCH', body: unknown,
  signal: AbortSignal, transport: KubernetesPodAuthHttps): Promise<number> {
  const path = `/api/v1/namespaces/${encodeURIComponent(api.namespace)}/pods/${encodeURIComponent(target.podName)}`
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (status: number) => { if (!settled) { settled = true; signal.removeEventListener('abort', abort); resolve(status) } }
    const req = transport.request(new URL(path, api.apiOrigin), { method, ca: Buffer.from(api.ca), rejectUnauthorized: true, agent: false,
      headers: { Authorization: `Bearer ${api.reviewer}`, 'Content-Type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' } }, res => {
      // Status is sufficient; never retain a response that can contain credentials.
      const status = res.statusCode ?? 0
      res.on('error', () => finish(0))
      finish(status); res.destroy()
    })
    function abort(): void { req.destroy(); finish(0) }
    req.on('error', () => finish(0))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    try { req.end(JSON.stringify(body)) } catch (error) { req.destroy(); signal.removeEventListener('abort', abort); reject(error) }
  })
}

export async function retireAgentPod(api: AgentPodApi, target: AgentPodIdentity, signal: AbortSignal,
  transport: KubernetesPodAuthHttps = defaultPodAuthHttps): Promise<AgentPodRetirementResult> {
  const path = `/api/v1/namespaces/${encodeURIComponent(api.namespace)}/pods/${encodeURIComponent(target.podName)}`
  try {
    const pod = object(await exchangePodAuth(transport, api.apiOrigin, api.ca, path, api.reviewer, undefined, 'POD_NOT_FOUND', signal))
    const metadata = object(pod.metadata), annotations = object(metadata.annotations), labels = object(metadata.labels)
    if (metadata.uid !== target.podUid || annotations['orca.dev/attempt-id'] !== target.attemptId ||
        annotations['orca.dev/execution-epoch'] !== target.executionEpoch || labels['orca.dev/runtime-unit'] !== target.runtimeUnitId) { return 'CONFLICT' }
    const finalizers = metadata.finalizers ?? []
    if (!Array.isArray(finalizers) || finalizers.some(value => typeof value !== 'string') || !metadata.resourceVersion) { return 'UNKNOWN' }
    if (!finalizers.includes(WRITER_STOP_FINALIZER)) {
      // A deleting legacy Pod cannot acquire a finalizer; never manufacture the lost status.
      if (metadata.deletionTimestamp) { return 'UNKNOWN' }
      const status = await mutate(api, target, 'PATCH', { metadata: { uid: target.podUid,
        resourceVersion: metadata.resourceVersion, finalizers: [...finalizers, WRITER_STOP_FINALIZER] } }, signal, transport)
      if (status !== 200) { return status === 409 ? 'CONFLICT' : 'UNKNOWN' }
    }
    if (signal.aborted) { return 'UNKNOWN' }
    const status = await mutate(api, target, 'DELETE', { apiVersion: 'v1', kind: 'DeleteOptions',
      preconditions: { uid: target.podUid } }, signal, transport)
    return status === 200 || status === 202 ? 'REQUESTED' : status === 404 ? 'ABSENT' : status === 409 ? 'CONFLICT' : 'UNKNOWN'
  } catch (error) {
    return error && typeof error === 'object' && Reflect.get(error, 'code') === 'POD_NOT_FOUND' ? 'ABSENT' : 'UNKNOWN'
  }
}

/** Call only after the exact attempt's stop proof and writer revocation have committed. */
export async function releaseAgentPodStopFinalizer(api: AgentPodApi, target: AgentPodIdentity, signal: AbortSignal,
  transport: KubernetesPodAuthHttps = defaultPodAuthHttps): Promise<boolean> {
  const path = `/api/v1/namespaces/${encodeURIComponent(api.namespace)}/pods/${encodeURIComponent(target.podName)}`
  try {
    const pod = object(await exchangePodAuth(transport, api.apiOrigin, api.ca, path, api.reviewer, undefined, 'POD_NOT_FOUND', signal))
    const metadata = object(pod.metadata)
    if (metadata.uid !== target.podUid) { return true }
    const finalizers = metadata.finalizers
    if (!Array.isArray(finalizers) || !finalizers.includes(WRITER_STOP_FINALIZER)) { return true }
    if (!metadata.deletionTimestamp || !metadata.resourceVersion) { return false }
    return await mutate(api, target, 'PATCH', { metadata: { uid: target.podUid, resourceVersion: metadata.resourceVersion,
      finalizers: finalizers.filter(value => value !== WRITER_STOP_FINALIZER) } }, signal, transport) === 200
  } catch (error) { return !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'POD_NOT_FOUND' }
}
