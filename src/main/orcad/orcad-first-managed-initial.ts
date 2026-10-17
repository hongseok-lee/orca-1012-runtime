import { isAbsolute, normalize } from 'node:path'
import type { Pool } from 'pg'
import { createFirstManagedInitialDispatch } from '../durable-runtime/runtime/first-managed-initial-dispatch.ts'
import { agentPodFields, agentPodInteger, agentPodText, captureAgentPodPolicy } from '../durable-runtime/runtime/agent-pod-policy.ts'
import type { ExecutorId } from '../durable-runtime/runtime/gateway/types.ts'
import type { FirstManagedBindingOwnerConfig } from '../durable-runtime/storage/first-managed-binding-owner.ts'
import { captureOrcadControllerConfig, invalidOrcadControllerConfig, OrcadControllerConfigurationError,
  parseUniqueOrcadControllerJson, readPrivateOrcadControllerConfigBytes, type OrcadControllerConfig } from './orcad-controller-config.ts'
import { readOrcadControllerCredential } from './orcad-controller-credential.ts'
import { prepareOrcadFirstColdProvider } from './orcad-first-cold-provider.ts'
import { createAgentPodPlanner } from '../durable-runtime/runtime/agent-pod-plan.ts'
import { prepareAgentPodPlan } from '../durable-runtime/runtime/agent-pod-plan-records.ts'

const deny = (code = 'CONTROLLER_FIRST_MANAGED_CONFIG'): never => invalidOrcadControllerConfig(code)
function absolute(value: unknown): string {
  const path = agentPodText(value)
  if (!isAbsolute(path) || normalize(path) !== path) { return deny() }
  return path
}
function timeout(value: unknown): number {
  const ms = agentPodInteger(value)
  if (ms > 2_147_483_647) { return deny() }
  return ms
}
// Nominal operator-configured executor reference only. The original worker
// continues to issue the real controller/claim; no verified identity is made.
function executorReference(value: unknown): value is ExecutorId {
  return typeof value === 'string' && agentPodText(value) === value
}
function requireActive(signal: AbortSignal): void {
  if (signal.aborted) { deny('CONTROLLER_FIRST_MANAGED_ABORTED') }
}
function projectedBearer(path: string, signal: AbortSignal): string {
  requireActive(signal)
  const token = readOrcadControllerCredential(path, 'TOKEN').toString('utf8').trim()
  requireActive(signal)
  if (!/^[A-Za-z0-9\-._~+/]+=*$/u.test(token)) { return deny('CONTROLLER_FIRST_MANAGED_TOKEN_FAILED') }
  return token
}

/** Trusted startup-only capture of the real composer's three callbacks. No
 * public input, identity, lease, transaction or external effect is issued. */
export function captureOrcadFirstManagedCallbacks(initial: ReturnType<typeof createFirstManagedInitialDispatch>,
  owner: Readonly<{ isClosing(): boolean; assertCurrentHost(): void }>) {
  const isClosing = owner.isClosing.bind(owner), assertCurrentHost = owner.assertCurrentHost.bind(owner)
  const planStep = initial.planStep.bind(initial), executeCommitted = initial.executeCommitted.bind(initial)
  const lookupOriginal = initial.lookupOriginal.bind(initial)
  function requireCallback(signal?: AbortSignal): void {
    if (isClosing() || signal?.aborted) { deny('CONTROLLER_FIRST_MANAGED_CLOSED') }
    assertCurrentHost()
  }
  return Object.freeze({
    planStep: (...args: Parameters<typeof planStep>) => { requireCallback(); return planStep(...args) },
    executeCommitted: (...args: Parameters<typeof executeCommitted>) => { requireCallback(args[1]); return executeCommitted(...args) },
    lookupOriginal: (...args: Parameters<typeof lookupOriginal>) => { requireCallback(args[1]); return lookupOriginal(...args) }
  })
}

/** One private target configuration. No raw token, Pool, callback, identity or
 * transport is decoded from JSON. Only the existing strict planner composes
 * policy/request; this loader supplies the original captured inventory CA. */
export function prepareOrcadFirstManagedInitial(original: OrcadControllerConfig, pool: Pool, capturedCA: Uint8Array, auditToken?: string) {
  const config = captureOrcadControllerConfig(original)
  if (!config.firstManagedInitial) { return null }
  try {
    if (!(capturedCA instanceof Uint8Array) || capturedCA.byteLength === 0) { return deny() }
    const raw = agentPodFields(parseUniqueOrcadControllerJson(
      readPrivateOrcadControllerConfigBytes(config.firstManagedInitial.configFile).toString('utf8')),
    ['policy', 'request', 'policyRevision', 'sessionId', 'actorId', 'originalAuditId', 'pinId', 'binding',
      'executorId', 'ownerTokenFile', 'acceptedProfileFile', 'expectedProfileDigest', 'podTokenFile', 'podTimeoutMs', 'credential', 'collector'])
    const policy = raw.get('policy'), request = raw.get('request'), policyScope = captureAgentPodPolicy(policy)
    if (policyScope.namespace !== config.inventory.namespace || policyScope.dataset !== config.inventory.dataset) {
      return deny('CONTROLLER_FIRST_MANAGED_SCOPE')
    }
    const b = agentPodFields(raw.get('binding'), ['bindingId', 'expectedRevision', 'storageEpoch'])
    const c = agentPodFields(raw.get('credential'), ['serviceAccountName', 'serviceAccountUid', 'issuerTokenFile', 'timeoutMs'])
    const collector = agentPodFields(raw.get('collector'), ['clusterIdentityRef', 'backendId', 'exportId', 'namespace', 'dataset',
      'podName', 'podUid', 'containerName', 'imageDigest', 'pvcName', 'pvcUid', 'pvName', 'pvUid', 'csiDriver', 'volumeHandle',
      'helperConfigMapName', 'helperConfigMapUid', 'helperSha256', 'exportsSha256', 'timeoutMs'])
    if (collector.get('namespace') !== config.inventory.namespace || collector.get('dataset') !== config.inventory.dataset) {
      return deny('CONTROLLER_FIRST_MANAGED_SCOPE')
    }
    const pinId = agentPodText(raw.get('pinId')), ownerTokenFile = absolute(raw.get('ownerTokenFile'))
    const acceptedProfileFile = absolute(raw.get('acceptedProfileFile')), podTokenFile = absolute(raw.get('podTokenFile'))
    const issuerTokenFile = absolute(c.get('issuerTokenFile')), executorId = raw.get('executorId')
    if (!executorReference(executorId)) { return deny() }
    const ca = Buffer.from(capturedCA), { apiOrigin, namespace, dataset } = config.inventory
    const firstManagedDirectory: FirstManagedBindingOwnerConfig = Object.freeze({
      acceptedProfileBytes: readPrivateOrcadControllerConfigBytes(acceptedProfileFile),
      expectedProfileDigest: agentPodText(raw.get('expectedProfileDigest')),
      credential: Object.freeze({ apiOrigin, ca: Buffer.from(ca), namespace,
        serviceAccountName: agentPodText(c.get('serviceAccountName')), serviceAccountUid: agentPodText(c.get('serviceAccountUid')),
        timeoutMs: timeout(c.get('timeoutMs')), readIssuerBearer: (signal: AbortSignal) => projectedBearer(issuerTokenFile, signal) }),
      collector: Object.freeze({ apiOrigin, ca: Buffer.from(ca), namespace, dataset,
        clusterIdentityRef: agentPodText(collector.get('clusterIdentityRef')), backendId: agentPodText(collector.get('backendId')),
        exportId: agentPodText(collector.get('exportId')), podName: agentPodText(collector.get('podName')),
        podUid: agentPodText(collector.get('podUid')), containerName: agentPodText(collector.get('containerName')),
        imageDigest: agentPodText(collector.get('imageDigest')), pvcName: agentPodText(collector.get('pvcName')),
        pvcUid: agentPodText(collector.get('pvcUid')), pvName: agentPodText(collector.get('pvName')),
        pvUid: agentPodText(collector.get('pvUid')), csiDriver: agentPodText(collector.get('csiDriver')),
        volumeHandle: agentPodText(collector.get('volumeHandle')), helperConfigMapName: agentPodText(collector.get('helperConfigMapName')),
        helperConfigMapUid: agentPodText(collector.get('helperConfigMapUid')), helperSha256: agentPodText(collector.get('helperSha256')),
        exportsSha256: agentPodText(collector.get('exportsSha256')), timeoutMs: timeout(collector.get('timeoutMs')) }) })
    const cold = prepareOrcadFirstColdProvider(config, pool, ca, { sessionId: agentPodText(raw.get('sessionId')),
      planDigest: prepareAgentPodPlan(createAgentPodPlanner(policy).plan(request)).planDigest, directory: firstManagedDirectory }, auditToken)
    return createFirstManagedInitialDispatch({ pool, policy, request, ...(cold ? { cold } : {}),
      policyRevision: agentPodText(raw.get('policyRevision')), sessionId: agentPodText(raw.get('sessionId')),
      actorId: agentPodText(raw.get('actorId')), originalAuditId: agentPodText(raw.get('originalAuditId')), pinId,
      binding: Object.freeze({ bindingId: agentPodText(b.get('bindingId')), expectedRevision: agentPodText(b.get('expectedRevision')),
        storageEpoch: agentPodText(b.get('storageEpoch')) }), executorId, externalBudgetMs: config.policy.externalBudgetMs,
      async readOwnerToken(expectedPinId: string, signal: AbortSignal) {
        requireActive(signal)
        if (expectedPinId !== pinId) { return deny('CONTROLLER_FIRST_MANAGED_PIN') }
        // Preserve exact saved token text. Whitespace/control bytes fail closed;
        // this private token is never generated, replaced, trimmed or published.
        const token = agentPodText(readPrivateOrcadControllerConfigBytes(ownerTokenFile).toString('utf8'))
        requireActive(signal)
        if (token.length < 32 || token.length > 512) { return deny('CONTROLLER_FIRST_MANAGED_TOKEN_FAILED') }
        return token
      },
      firstManagedDirectory, podConfig: Object.freeze({ apiOrigin, ca: Buffer.from(ca), namespace, dataset,
        timeoutMs: timeout(raw.get('podTimeoutMs')), readBearerToken: (signal: AbortSignal) => projectedBearer(podTokenFile, signal) }) })
  } catch (error) {
    if (error instanceof OrcadControllerConfigurationError) { throw error }
    return deny()
  }
}
