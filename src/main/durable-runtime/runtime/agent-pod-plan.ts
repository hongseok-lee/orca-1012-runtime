import { createHash } from 'node:crypto'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { AgentPodPlanError, agentPodArray, agentPodFields, agentPodInteger, agentPodName, agentPodPath,
  agentPodText, agentPodUuid, agentPodWithin, captureAgentPodPolicy } from './agent-pod-policy.ts'
import type { CapturedAgentPodPolicy } from './agent-pod-policy.ts'

export type TrustedAgentPodRequest = Readonly<{
  identity: Readonly<{ unitId: string; operationId: string; attemptId: string; executionEpoch: string; intentRevision: string; specHash: string }>
  protectedBindings: readonly Readonly<{ bindingId: string; leafId: string; claimName: string; claimUid: string; pvUid: string; serverPath: string; mode: 'RO' | 'RW' }>[]
  profile: Readonly<{ revision: string; cpuMilli: number; memoryMi: number; ephemeralMi: number; temporaryMi: number }>
}>

function captureRequest(value: unknown, policy: CapturedAgentPodPolicy) {
  const input = agentPodFields(value, ['identity', 'protectedBindings', 'profile'])
  const ids = agentPodFields(input.get('identity'), ['unitId', 'operationId', 'attemptId', 'executionEpoch', 'intentRevision', 'specHash'])
  const specHash = agentPodText(ids.get('specHash'))
  if (!/^[0-9a-f]{64}$/u.test(specHash)) { throw new AgentPodPlanError('INPUT_INVALID') }
  const identity = Object.freeze({ unitId: logicalId('runtime-unit', agentPodUuid(ids.get('unitId'))),
    operationId: logicalId('operation', agentPodUuid(ids.get('operationId'))), attemptId: logicalId('attempt', agentPodUuid(ids.get('attemptId'))),
    executionEpoch: counter('execution-epoch', agentPodText(ids.get('executionEpoch'))),
    intentRevision: counter('intent-revision', agentPodText(ids.get('intentRevision'))), specHash })
  const bindings = agentPodArray(input.get('protectedBindings'))
  // The Session model permits multiple bindings. This first /agent planner cannot silently omit them.
  if (bindings.length !== 1) { throw new AgentPodPlanError('PROTECTED_BINDING_COUNT_UNSUPPORTED') }
  const b = agentPodFields(bindings[0], ['bindingId', 'leafId', 'claimName', 'claimUid', 'pvUid', 'serverPath', 'mode'])
  const mode = b.get('mode')
  if (mode !== 'RO' && mode !== 'RW') { throw new AgentPodPlanError('INPUT_INVALID') }
  const protectedBinding = Object.freeze({ bindingId: logicalId('storage-binding', agentPodUuid(b.get('bindingId'))),
    leafId: agentPodUuid(b.get('leafId')), claimName: agentPodName(b.get('claimName')), claimUid: agentPodUuid(b.get('claimUid')),
    pvUid: agentPodUuid(b.get('pvUid')), serverPath: agentPodPath(b.get('serverPath')), mode })
  if (protectedBinding.serverPath !== `${policy.protectedExportRoot}/${protectedBinding.leafId}` ||
      protectedBinding.claimName === policy.shared.claimName || protectedBinding.claimUid === policy.shared.claimUid ||
      protectedBinding.pvUid === policy.shared.pvUid || agentPodWithin(protectedBinding.serverPath, policy.shared.serverPath) ||
      agentPodWithin(policy.shared.serverPath, protectedBinding.serverPath)) { throw new AgentPodPlanError('MOUNT_SCOPE_INVALID') }
  const p = agentPodFields(input.get('profile'), ['revision', 'cpuMilli', 'memoryMi', 'ephemeralMi', 'temporaryMi'])
  const profile = Object.freeze({ revision: counter('profile-revision', agentPodText(p.get('revision'))),
    cpuMilli: agentPodInteger(p.get('cpuMilli')), memoryMi: agentPodInteger(p.get('memoryMi')),
    ephemeralMi: agentPodInteger(p.get('ephemeralMi')), temporaryMi: agentPodInteger(p.get('temporaryMi')) })
  if (profile.temporaryMi > profile.ephemeralMi) { throw new AgentPodPlanError('INPUT_INVALID') }
  return Object.freeze({ identity, protectedBinding, profile })
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Pure trusted-server planner. No API call, proof issuer, grant transition or readiness result. */
export function createAgentPodPlanner(deploymentPolicy: unknown) {
  const policy = captureAgentPodPolicy(deploymentPolicy)
  return Object.freeze({ plan(value: TrustedAgentPodRequest | unknown) {
    try {
      const request = captureRequest(value, policy), { identity, protectedBinding, profile } = request
      const protectedReadOnly = protectedBinding.mode === 'RO'
      const spec = Object.freeze({ restartPolicy: 'Never', terminationGracePeriodSeconds: 25,
        hostNetwork: false, automountServiceAccountToken: false,
        nodeSelector: Object.freeze({ 'cloud.google.com/gke-spot': 'true', 'kubernetes.io/arch': 'amd64' }),
        tolerations: Object.freeze([
          Object.freeze({ key: 'cloud.google.com/gke-spot', operator: 'Equal', value: 'true', effect: 'NoSchedule' }),
          Object.freeze({ key: 'kubernetes.io/arch', operator: 'Equal', value: 'amd64', effect: 'NoSchedule' })]),
        securityContext: Object.freeze({ runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000,
          seccompProfile: Object.freeze({ type: 'RuntimeDefault' }) }),
        affinity: Object.freeze({ podAntiAffinity: Object.freeze({ requiredDuringSchedulingIgnoredDuringExecution: Object.freeze([
          Object.freeze({ topologyKey: 'kubernetes.io/hostname', namespaces: Object.freeze([policy.namespace]), labelSelector: Object.freeze({}) })]) }) }),
        containers: Object.freeze([Object.freeze({ name: 'agent', image: policy.image, imagePullPolicy: 'IfNotPresent',
          command: policy.entrypoint.command, args: policy.entrypoint.args, workingDir: policy.paths.checkout,
          env: Object.freeze([Object.freeze({ name: 'HOME', value: policy.paths.home }),
            Object.freeze({ name: 'CLAUDE_CONFIG_DIR', value: policy.paths.claudeState }),
            Object.freeze({ name: 'CODEX_HOME', value: policy.paths.codexState })]),
          resources: Object.freeze({ requests: Object.freeze({ cpu: `${profile.cpuMilli}m`, memory: `${profile.memoryMi}Mi`,
            'ephemeral-storage': `${profile.ephemeralMi}Mi` }), limits: Object.freeze({ 'ephemeral-storage': `${profile.ephemeralMi}Mi` }) }),
          securityContext: Object.freeze({ allowPrivilegeEscalation: false, privileged: false, readOnlyRootFilesystem: true,
            capabilities: Object.freeze({ drop: Object.freeze(['ALL']) }) }),
          volumeMounts: Object.freeze([Object.freeze({ name: 'protected', mountPath: '/agent', readOnly: protectedReadOnly }),
            Object.freeze({ name: 'shared', mountPath: '/shared', readOnly: false }), Object.freeze({ name: 'temporary', mountPath: '/tmp' })]) })]),
        volumes: Object.freeze([Object.freeze({ name: 'protected', persistentVolumeClaim: Object.freeze({ claimName: protectedBinding.claimName, readOnly: protectedReadOnly }) }),
          Object.freeze({ name: 'shared', persistentVolumeClaim: Object.freeze({ claimName: policy.shared.claimName, readOnly: false }) }),
          Object.freeze({ name: 'temporary', emptyDir: Object.freeze({ sizeLimit: `${profile.temporaryMi}Mi` }) })]) })
      const pod = Object.freeze({ apiVersion: 'v1', kind: 'Pod', metadata: Object.freeze({
        name: `orca-agent-${digest(identity).slice(0, 32)}`, namespace: policy.namespace,
        labels: Object.freeze({ 'orca.dev/role': 'runtime-agent', 'orca.dev/dataset': policy.dataset, 'orca.dev/runtime-unit': identity.unitId }),
        annotations: Object.freeze({ 'orca.dev/operation-id': identity.operationId, 'orca.dev/attempt-id': identity.attemptId,
          'orca.dev/execution-epoch': identity.executionEpoch, 'orca.dev/intent-revision': identity.intentRevision,
          // This is the trusted logical desired-spec hash, not a newly issued authority proof.
          'orca.dev/spec-hash': identity.specHash, 'orca.dev/resource-profile-revision': profile.revision }) }), spec })
      const mountExpectations = Object.freeze({ protected: Object.freeze({ ...protectedBinding, server: policy.nfsServer, clientPath: '/agent' }),
        shared: Object.freeze({ ...policy.shared, server: policy.nfsServer, clientPath: '/shared', mode: 'RW' }) })
      return Object.freeze({ kind: 'UNAUTHORIZED_PLAN', identity, pod, mountExpectations, podSpecSHA256: digest(spec),
        readinessObserved: false, storageGrantIssued: false, physicalPinIssued: false })
    } catch (error) {
      if (error instanceof AgentPodPlanError) { throw error }
      throw new AgentPodPlanError('INPUT_INVALID')
    }
  } })
}

export type UnauthorizedAgentPodPlan = ReturnType<ReturnType<typeof createAgentPodPlanner>['plan']>
