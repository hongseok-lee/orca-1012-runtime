import type { FailureObservationInput, FailureTarget, PreparedFailureObservation, PlacementObservation,
  ResourceObservation, ResourceValues, TerminationObservation, MemorySignals } from './types.ts'
import { evidenceTime, prepareFailureObservation, snapshotTarget, text } from './normalize.ts'

type ObjectValue = Record<string, unknown>
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_OBJECT')
  return value as ObjectValue
}
function optional(value: unknown): ObjectValue { return value === undefined || value === null ? {} : object(value) }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error('INVALID_ARRAY'); return value }
function stringOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return text(value, 'Kubernetes field')
}
function resourceValues(raw: unknown): ResourceValues {
  const resources = optional(raw), requests = optional(resources.requests), limits = optional(resources.limits)
  return Object.freeze({ memoryRequest: stringOrNull(requests.memory), memoryLimit: stringOrNull(limits.memory),
    cpuRequest: stringOrNull(requests.cpu), cpuLimit: stringOrNull(limits.cpu) })
}
function resourceSnapshot(container: ObjectValue, status: ObjectValue, desired: KubernetesCollectionRequest['desired'],
  original: KubernetesReadBatch['originalResources']): ResourceObservation {
  return Object.freeze({
    desired: Object.freeze({ memoryRequest: desired.memoryRequest, memoryLimit: desired.memoryLimit, cpuRequest: null, cpuLimit: null }),
    observedSpec: resourceValues(container.resources),
    observedStatus: status.resources === undefined || status.resources === null ? null : Object.freeze({
      containerId: stringOrNull(status.containerID), values: resourceValues(status.resources) }),
    // Spec and current status are diagnostic snapshots. Neither proves the
    // admission/applied plane of the original termination, especially lastState.
    admitted: original?.admitted ?? null, applied: original?.applied ?? null
  })
}
export interface KubernetesCollectionRequest {
  readonly target: FailureTarget
  readonly namespace: string
  readonly podName: string
  readonly observationId: string
  readonly sourceDedupKey: string
  readonly observedAt: string | Date
  readonly workloadKind: FailureObservationInput['workloadKind']
  readonly profileVerified: boolean
  readonly defaultLimitlessProfile: boolean
  readonly desired: { readonly memoryRequest: string | null; readonly memoryLimit: string | null }
}
export interface PlatformPodOrigin {
  readonly podUid: string
  readonly nodeUid: string
  readonly batchId: string
  readonly kind: 'SYSTEM_DAEMONSET' | 'PLATFORM_BALLOON'
  readonly provenanceRef: string
}
export interface KubernetesReadBatch {
  readonly batchId: string
  readonly pod: unknown
  readonly node: unknown
  readonly placementPods: readonly unknown[]
  // The adapter must guarantee a complete co-observation on this Node UID.
  // A cached/non-atomic/incomplete LIST is false, never a guessed isolated Node.
  readonly placementComplete: boolean
  readonly placementNodeUid: string
  readonly platformOrigins: readonly PlatformPodOrigin[]
  readonly originalResources?: Pick<ResourceObservation, 'admitted' | 'applied'> | null
  readonly originalPlacement?: PlacementObservation | null
}
// Only the authenticated workload/control-plane boundary may supply this
// transport. No kubectl shell, credential setup, mutable client singleton or
// fixture-to-verified factory is installed by this data module.
export interface ReadonlyKubernetesTransport {
  readonly sourceRef: string
  readonly authentication: 'BOUNDARY_AUTHENTICATED' | 'UNVERIFIED'
  readBatch(request: KubernetesCollectionRequest): Promise<KubernetesReadBatch>
}
const emptySignals: MemorySignals = Object.freeze({ oomKilled: false, memoryEviction: false, nodeOom: false,
  limitOom: false, heapLimit: false, childOom: false, parentAlive: null, otherTermination: false })

export async function collectKubernetesEvidence(transport: ReadonlyKubernetesTransport,
  raw: KubernetesCollectionRequest): Promise<PreparedFailureObservation> {
  // Snapshot every caller-owned string/Date/nested resource before any I/O.
  const target = snapshotTarget(raw.target), at = evidenceTime(raw.observedAt).original
  const request = Object.freeze({ target, namespace: text(raw.namespace, 'namespace'), podName: text(raw.podName, 'podName'),
    observationId: text(raw.observationId, 'observation'), sourceDedupKey: text(raw.sourceDedupKey, 'source key'),
    observedAt: at, workloadKind: raw.workloadKind, profileVerified: raw.profileVerified,
    defaultLimitlessProfile: raw.defaultLimitlessProfile,
    desired: Object.freeze({ memoryRequest: stringOrNull(raw.desired.memoryRequest), memoryLimit: stringOrNull(raw.desired.memoryLimit) }) })
  const sourceRef = text(transport.sourceRef, 'sourceRef'), authenticated = transport.authentication === 'BOUNDARY_AUTHENTICATED'
  const base: FailureObservationInput = {
    observationId: request.observationId, sourceDedupKey: request.sourceDedupKey,
    sourceKind: 'KUBERNETES', sourceRef, target, observedAt: at, sourceAuthenticated: authenticated,
    termination: null, counterTransition: null, signals: emptySignals, resources: null, placement: null,
    workloadKind: request.workloadKind, profileVerified: request.profileVerified,
    defaultLimitlessProfile: request.defaultLimitlessProfile, affectedWorkIds: [], gaps: [], evidence: null
  }
  // Validate the booleans/kinds as well as identifiers before the first await.
  prepareFailureObservation(base)
  let batch: KubernetesReadBatch
  try { batch = await transport.readBatch(request) }
  catch { return prepareFailureObservation({ ...base, gaps: ['KUBERNETES_READ_FAILED'], evidence: { readStatus: 'FAILED' } }) }
  const gaps: string[] = []
  try {
    const batchId = text(batch.batchId, 'batchId'), pod = object(batch.pod), meta = object(pod.metadata)
    const spec = object(pod.spec), status = optional(pod.status)
    const podUid = text(meta.uid, 'Pod UID'), resourceVersion = text(meta.resourceVersion, 'resourceVersion')
    if (podUid !== target.podUid || meta.namespace !== request.namespace || meta.name !== request.podName) {
      return prepareFailureObservation({ ...base, gaps: ['POD_IDENTITY_MISMATCH'], evidence: { podUid, resourceVersion } })
    }
    const specs = array(spec.containers).map(object).filter(c => c.name === target.containerName)
    const statuses = array(status.containerStatuses ?? []).map(object).filter(c => c.name === target.containerName)
    let resources: ResourceObservation | null = null, termination: TerminationObservation | null = null
    let restartCount: number | null = null, currentContainerId: string | null = null
    if (target.containerName === null || specs.length !== 1 || statuses.length !== 1) gaps.push('CONTAINER_STATUS_INCOMPLETE_OR_DUPLICATE')
    else {
      const c = statuses[0], state = optional(c.state), last = optional(c.lastState)
      resources = resourceSnapshot(specs[0], c, request.desired, batch.originalResources)
      restartCount = Number.isSafeInteger(c.restartCount) && Number(c.restartCount) >= 0 ? Number(c.restartCount) : null
      if (restartCount === null) gaps.push('RESTART_STATUS_INCOMPLETE')
      currentContainerId = stringOrNull(c.containerID)
      const candidates = [ ['CURRENT', state.terminated], ['LAST', last.terminated] ] as const
      for (const [kind, rawTermination] of candidates) {
        if (!rawTermination) continue
        const t = object(rawTermination), id = stringOrNull(t.containerID)
        // lastState.containerID belongs to the OLD execution; status.containerID
        // belongs to the current execution and is never used to fill this gap.
        if (id === null || target.incarnation === null) { gaps.push('TERMINATION_IDENTITY_INCOMPLETE'); continue }
        if (id !== target.runtimeContainerId) continue
        if (termination) { gaps.push('DUPLICATE_TERMINATION_MATCH'); termination = null; break }
        const reason = stringOrNull(t.reason)
        termination = Object.freeze({ state: kind, containerId: id, incarnation: target.incarnation,
          processIdentity: null, finishedAt: evidenceTime(text(t.finishedAt, 'finishedAt')).original,
          startedAt: t.startedAt ? evidenceTime(text(t.startedAt, 'startedAt')).original : null,
          exitCode: typeof t.exitCode === 'number' ? t.exitCode : null, signal: typeof t.signal === 'number' ? t.signal : null,
          reason: reason && ['OOMKilled','Completed','Error','ContainerCannotRun'].includes(reason) ? reason : 'UNRECOGNIZED_REASON' })
      }
      if (!termination) gaps.push('ORIGINAL_TERMINATION_NOT_OBSERVED')
    }
    const node = object(batch.node), nodeMeta = object(node.metadata), nodeUid = text(nodeMeta.uid, 'Node UID')
    let placement: PlacementObservation | null = null
    if (nodeMeta.name !== spec.nodeName || nodeUid !== batch.placementNodeUid) gaps.push('PLACEMENT_NODE_IDENTITY_MISMATCH')
    else {
      const otherUsers: string[] = [], platform: string[] = [], unknown: string[] = [], seen = new Set<string>()
      let hasTarget = false, complete = batch.placementComplete === true
      for (const rawPod of batch.placementPods) {
        const item = object(rawPod), im = object(item.metadata), is = object(item.spec), uid = text(im.uid, 'placement Pod UID')
        if (seen.has(uid)) { complete = false; gaps.push('DUPLICATE_PLACEMENT_POD'); continue }
        seen.add(uid)
        if (is.nodeName !== nodeMeta.name) { unknown.push(uid); complete = false; continue }
        if (uid === target.podUid) { hasTarget = true; continue }
        const origins = batch.platformOrigins.filter(o => o.podUid === uid && o.nodeUid === nodeUid && o.batchId === batchId &&
          ['SYSTEM_DAEMONSET','PLATFORM_BALLOON'].includes(o.kind) && typeof o.provenanceRef === 'string' && o.provenanceRef.length > 0)
        if (origins.length === 1) platform.push(uid)
        // Namespace/name/DaemonSet ownership alone never exclude a user Pod.
        else otherUsers.push(uid)
      }
      if (!hasTarget) { complete = false; gaps.push('PLACEMENT_TARGET_MISSING') }
      placement = Object.freeze({ batchId, nodeUid, targetPodUid: target.podUid, complete,
        otherUserPodUids: Object.freeze(otherUsers), platformPodUids: Object.freeze(platform), unknownPodUids: Object.freeze(unknown), provenance: null })
      if (!complete) gaps.push('PLACEMENT_GAP')
    }
    const evicted = status.reason === 'Evicted'
    const message = typeof status.message === 'string' ? status.message : ''
    const memoryEviction = evicted && /(?:resource:\s*memory\b|memory[- ]?pressure\b)/i.test(message)
    const otherEviction = evicted && /(?:ephemeral-storage|disk[- ]?pressure|resource:\s*(?:disk|pid)\b)/i.test(message)
    if (evicted && !memoryEviction && !otherEviction) gaps.push('EVICTION_RESOURCE_UNKNOWN')
    // Preserve allowlisted status identity, never env, credentials, full Pod,
    // arbitrary message/termination stderr or exception contents.
    if (!batch.originalResources?.applied) gaps.push('ORIGINAL_APPLIED_RESOURCES_UNPROVEN')
    if (!batch.originalPlacement) gaps.push('ORIGINAL_PLACEMENT_UNPROVEN')
    const currentPlacement = placement
    return prepareFailureObservation({ ...base, termination, resources, placement: batch.originalPlacement ?? placement, gaps,
      signals: { ...emptySignals, oomKilled: termination?.reason === 'OOMKilled', memoryEviction, otherTermination: otherEviction },
      evidence: { batchId, podUid, resourceVersion, nodeUid, currentContainerId, restartCount,
        podPhase: typeof status.phase === 'string' ? status.phase : null,
        podReason: evicted ? 'Evicted' : null, evictionResource: memoryEviction ? 'memory' : otherEviction ? 'non-memory' : null,
        terminationState: termination?.state ?? null, originalContainerId: termination?.containerId ?? null,
        originalFinishedAt: termination?.finishedAt ?? null,
        currentPlacement: currentPlacement ? { batchId: currentPlacement.batchId, nodeUid: currentPlacement.nodeUid,
          complete: currentPlacement.complete, otherUserPodUids: currentPlacement.otherUserPodUids,
          platformPodUids: currentPlacement.platformPodUids, unknownPodUids: currentPlacement.unknownPodUids } : null } })
  } catch {
    return prepareFailureObservation({ ...base, gaps: ['KUBERNETES_RESPONSE_INCOMPLETE'], evidence: { readStatus: 'INVALID' } })
  }
}

export interface PodSampleRequest {
  readonly namespace: string
  readonly podName: string
  readonly podUid: string
  readonly containerName: string
  readonly observedAt: string | Date
  readonly workloadKind: FailureObservationInput['workloadKind']
}
export interface ReadonlyPodSampleTransport {
  readPod(request: PodSampleRequest): Promise<unknown>
}
// Development Pods have no durable Unit/attempt binding. A diagnostic sample
// must not manufacture those UUIDs or insert a fictional incident target.
export async function collectUnboundPodSample(transport: ReadonlyPodSampleTransport, raw: PodSampleRequest) {
  const request = Object.freeze({ namespace: text(raw.namespace, 'namespace'), podName: text(raw.podName, 'Pod name'),
    podUid: text(raw.podUid, 'Pod UID'), containerName: text(raw.containerName, 'container name'),
    observedAt: evidenceTime(raw.observedAt).original, workloadKind: raw.workloadKind })
  if (!['AGENT','SERVE','PG','NFS','DEV','TEST','BUILD','UNKNOWN'].includes(request.workloadKind)) throw new Error('EVIDENCE_INPUT:kind')
  try {
    const pod = object(await transport.readPod(request)), meta = object(pod.metadata), spec = object(pod.spec), status = optional(pod.status)
    if (meta.uid !== request.podUid || meta.name !== request.podName || meta.namespace !== request.namespace) throw new Error('POD_IDENTITY_MISMATCH')
    const specs = array(spec.containers).map(object).filter(c => c.name === request.containerName)
    const statuses = array(status.containerStatuses ?? []).map(object).filter(c => c.name === request.containerName)
    const c = statuses.length === 1 ? statuses[0] : null
    const terminated = (value: unknown) => {
      if (!value) return null
      const t = object(value)
      return Object.freeze({ containerId: stringOrNull(t.containerID), finishedAt: t.finishedAt ? evidenceTime(text(t.finishedAt, 'finishedAt')).original : null,
        exitCode: typeof t.exitCode === 'number' ? t.exitCode : null,
        reason: t.reason === 'OOMKilled' ? 'OOMKilled' : t.reason === 'Completed' ? 'Completed' : 'OTHER_OR_UNKNOWN' })
    }
    return Object.freeze({ status: 'OBSERVED' as const, request,
      resourceVersion: text(meta.resourceVersion, 'resourceVersion'), nodeName: stringOrNull(spec.nodeName),
      runtimeContainerId: c ? stringOrNull(c.containerID) : null,
      restartCount: c && Number.isSafeInteger(c.restartCount) ? Number(c.restartCount) : null,
      currentTermination: c ? terminated(optional(c.state).terminated) : null,
      lastTermination: c ? terminated(optional(c.lastState).terminated) : null,
      desiredSpecResources: specs.length === 1 ? resourceValues(specs[0].resources) : null,
      currentAppliedStatus: c?.resources === undefined || c?.resources === null ? null : Object.freeze({
        containerId: stringOrNull(c.containerID), values: resourceValues(c.resources) }),
      logicalBinding: null, resolution: 'TARGET_UNRESOLVED' as const, automaticGrowthCandidate: false,
      exclusionReason: request.workloadKind !== 'AGENT' ? 'NON_AGENT_WORKLOAD' : 'UNIT_ATTEMPT_AUTHENTICATION_MISSING', authority: 'DATA_ONLY' as const })
  } catch {
    return Object.freeze({ status: 'UNKNOWN' as const, request, logicalBinding: null,
      resolution: 'TARGET_UNRESOLVED' as const, automaticGrowthCandidate: false,
      exclusionReason: 'READ_OR_IDENTITY_FAILED', authority: 'DATA_ONLY' as const })
  }
}
