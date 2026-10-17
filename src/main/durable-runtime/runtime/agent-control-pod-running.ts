import { setTimeout as pollDelay } from 'node:timers/promises'
import { defaultPodAuthHttps, exchangePodAuth } from './kubernetes-pod-auth-transport.ts'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
const fail = (): never => { throw new Error('AGENT_CODEX_CONTROL_UNCONFIRMED') }

/** Scheduling observation only. The original Pod-bound authentication and
 * grant/physical protection checks still precede every provider effect. */
export async function awaitAgentControlPodRunning(config: Readonly<{
  apiOrigin: string; namespace: string; container: string
  expected: Readonly<{ podName: string; podUid: string }>
}>, ca: Uint8Array, reviewer: string, signal: AbortSignal): Promise<void> {
  const target = `/api/v1/namespaces/${encodeURIComponent(config.namespace)}/pods/${encodeURIComponent(config.expected.podName)}`
  while (!signal.aborted) {
    const pod = await exchangePodAuth(defaultPodAuthHttps, config.apiOrigin, ca, target,
      reviewer, undefined, 'POD_NOT_FOUND', signal)
    if (!record(pod) || !record(pod.metadata) || !record(pod.status) ||
        pod.metadata.name !== config.expected.podName || pod.metadata.namespace !== config.namespace ||
        pod.metadata.uid !== config.expected.podUid || pod.metadata.deletionTimestamp != null ||
        !['Pending', 'Running'].includes(String(pod.status.phase))) { return fail() }
    const statuses = pod.status.containerStatuses
    if (statuses !== undefined && !Array.isArray(statuses)) { return fail() }
    const matches = Array.isArray(statuses) ? statuses.filter(value => record(value) && value.name === config.container) : []
    if (matches.length > 1) { return fail() }
    const container: unknown = matches[0]
    if (record(container) && record(container.state)) {
      if (container.state.terminated != null) { return fail() }
      if (pod.status.phase === 'Running' && container.ready === true && record(container.state.running)) { return }
    }
    await pollDelay(250, undefined, { signal })
  }
  return fail()
}
