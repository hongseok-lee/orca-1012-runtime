import { createHash } from 'node:crypto'
import { defaultPodAuthHttps, exchangePodAuth } from './kubernetes-pod-auth-transport.ts'
import type { KubernetesPodAuthHttps } from './kubernetes-pod-auth-types.ts'

export const WRITER_STOP_FINALIZER = 'orca.dev/writer-stop'
export type AgentPodIdentity = Readonly<{ attemptId: string; runtimeUnitId: string; podUid: string; podName: string; executionEpoch: string }>
export type AgentPodStopEvidence = Readonly<{
  kind: 'KUBERNETES_SANDBOX_TERMINATED'; proofRef: string; observedAt: string
  namespace: string; podName: string; podUid: string; resourceVersion: string; nodeName: string
  attemptId: string; runtimeUnitId: string; executionEpoch: string
  containers: readonly Readonly<{ name: string; containerId: string; finishedAt: string; exitCode: number }>[]
}>
export type AgentPodObservation = Readonly<{
  state: 'GONE' | 'PRESENT' | 'UNKNOWN' | 'STOPPED'; podName: string; podUid: string; observedAt: string; observedUid: string | null
  stopping: boolean; stopEvidence: AgentPodStopEvidence | null
}>
export type AgentPodApi = Readonly<{ apiOrigin: string; ca: Uint8Array; namespace: string; reviewer: string }>
const collected = new WeakSet<AgentPodStopEvidence>()
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value)) : {}
const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null

/** Projection is data only. Only an authenticated API exchange may issue collected stop evidence. */
export function projectAgentPodStop(pod: unknown, namespace: string, target: AgentPodIdentity, observedAt: string): AgentPodStopEvidence | null {
  const root = object(pod), metadata = object(root.metadata), spec = object(root.spec), status = object(root.status)
  const annotations = object(metadata.annotations), labels = object(metadata.labels)
  if (metadata.uid !== target.podUid || metadata.name !== target.podName || metadata.namespace !== namespace ||
      annotations['orca.dev/attempt-id'] !== target.attemptId || annotations['orca.dev/execution-epoch'] !== target.executionEpoch ||
      labels['orca.dev/runtime-unit'] !== target.runtimeUnitId || labels['orca.dev/role'] !== 'runtime-agent' ||
      !text(metadata.resourceVersion) || !text(spec.nodeName) || !text(metadata.deletionTimestamp) ||
      spec.restartPolicy !== 'Never' || spec.hostPID === true || spec.hostNetwork === true ||
      annotations['kubernetes.io/config.mirror'] !== undefined ||
      !['Succeeded', 'Failed'].includes(String(status.phase)) ||
      !Array.isArray(status.conditions) || !status.conditions.some(value => {
        const condition = object(value)
        return condition.type === 'PodReadyToStartContainers' && condition.status === 'False'
      })) { return null }
  const containers: { name: string; containerId: string; finishedAt: string; exitCode: number }[] = []
  for (const [specKey, statusKey] of [['containers', 'containerStatuses'], ['initContainers', 'initContainerStatuses'],
    ['ephemeralContainers', 'ephemeralContainerStatuses']]) {
    const definitions = spec[specKey] ?? [], statuses = status[statusKey] ?? []
    if (!Array.isArray(definitions) || !Array.isArray(statuses) || definitions.length !== statuses.length) { return null }
    for (const value of definitions) {
      const definition = object(value), matches = statuses.map(object).filter(row => row.name === definition.name)
      if (!text(definition.name) || definition.restartPolicy !== undefined || definition.restartPolicyRules !== undefined || matches.length !== 1 ||
          object(definition.securityContext).privileged === true) { return null }
      const row = matches[0], state = object(row.state), terminated = object(state.terminated)
      const id = text(terminated.containerID), finishedAt = text(terminated.finishedAt)
      if (row.started === true || state.running || state.waiting || !id || row.containerID !== id || !finishedAt ||
          !Number.isFinite(Date.parse(finishedAt)) || Date.parse(finishedAt) > Date.parse(observedAt) ||
          !Number.isInteger(terminated.exitCode) || ['ContainerStatusUnknown', 'ContainerCannotRun'].includes(String(terminated.reason))) { return null }
      containers.push({ name: String(definition.name), containerId: id, finishedAt, exitCode: Number(terminated.exitCode) })
    }
  }
  if (!containers.length || new Set(containers.map(row => row.name)).size !== containers.length) { return null }
  const facts = { kind: 'KUBERNETES_SANDBOX_TERMINATED' as const, observedAt, namespace, podName: target.podName, podUid: target.podUid,
    resourceVersion: String(metadata.resourceVersion), nodeName: String(spec.nodeName), attemptId: target.attemptId,
    runtimeUnitId: target.runtimeUnitId, executionEpoch: target.executionEpoch, containers: Object.freeze(containers.map(row => Object.freeze(row))) }
  const proofRef = `kubernetes-sandbox-stop:sha256:${createHash('sha256').update(JSON.stringify(facts)).digest('hex')}`
  return Object.freeze({ ...facts, proofRef })
}

export function isCollectedAgentPodStop(evidence: AgentPodStopEvidence): boolean { return collected.has(evidence) }

/** Missing/name-reused Pods are observations, never physical stop proofs. */
export async function observeAgentPod(api: AgentPodApi, candidate: AgentPodIdentity, signal: AbortSignal,
  transport: KubernetesPodAuthHttps = defaultPodAuthHttps): Promise<AgentPodObservation> {
  const base = { podName: candidate.podName, podUid: candidate.podUid }
  const path = `/api/v1/namespaces/${encodeURIComponent(api.namespace)}/pods/${encodeURIComponent(candidate.podName)}`
  try {
    const pod = await exchangePodAuth(transport, api.apiOrigin, api.ca, path, api.reviewer, undefined, 'POD_NOT_FOUND', signal)
    const observedAt = new Date().toISOString(), uid = text(object(object(pod).metadata).uid)
    const stopEvidence = projectAgentPodStop(pod, api.namespace, candidate, observedAt)
    if (stopEvidence) { collected.add(stopEvidence) }
    return Object.freeze({ ...base, state: !uid ? 'UNKNOWN' : uid !== candidate.podUid ? 'GONE' : stopEvidence ? 'STOPPED' : 'PRESENT',
      observedAt, observedUid: uid, stopping: !!object(object(pod).metadata).deletionTimestamp || ['Succeeded','Failed'].includes(String(object(object(pod).status).phase)), stopEvidence })
  } catch (error) {
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : null
    return Object.freeze({ ...base, state: code === 'POD_NOT_FOUND' ? 'GONE' : 'UNKNOWN', observedAt: new Date().toISOString(), observedUid: null, stopping: false, stopEvidence: null })
  }
}
