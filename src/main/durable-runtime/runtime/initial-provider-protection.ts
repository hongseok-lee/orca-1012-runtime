import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { DurableDatabaseError } from '../db/connection.ts'
import type { AgentPodPlanRecord } from '../db/agent-pod-plan-record-rows.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { immutableSnapshot } from '../providers/shared/recovery-renderer.ts'
import { captureFirstManagedBindingProfile } from '../storage/first-managed-binding-owner-profile.ts'
import { createFirstManagedObservationSource, requireFirstManagedObservation } from '../storage/first-managed-observation-source.ts'
import type { FirstManagedBindingOwnerConfig } from '../storage/first-managed-observation-source.ts'
import { acquireNamespaceHold, releaseNamespaceHold } from '../storage/namespace-holds.ts'
import type { NamespaceHoldInput } from '../storage/namespace-holds.ts'
import { heldManagedLeafDirectoryValid } from '../storage/managed-leaf-pin.ts'
import type { HeldManagedLeafDirectory } from '../storage/managed-leaf-pin.ts'
import { createAgentMountCollector } from '../storage/agent-mount-collector.ts'
import type { AgentMountCollectorConfig, AuthenticatedAgentMountObservation } from '../storage/agent-mount-collector-types.ts'
import { sameDirectory } from '../storage/canonical.ts'
import type { CanonicalCandidate } from '../storage/canonical.ts'
import type { ExecutionTarget, StorageEvidenceAuthority, VerifiedDirectoryEvidence, VerifiedMountEvidence } from '../storage/evidence.ts'
import { authenticatedAgentControlValid, createAgentCodexTransport } from './agent-codex-transport.ts'
import type { AgentCodexTransportConfiguration, AuthenticatedAgentControl } from './agent-codex-transport.ts'
import { createControlledExecutionTargetObserver } from './controlled-execution-target.ts'
import type { ExecutionTargetCompositionConfiguration } from './execution-target-composition-types.ts'
import type { ProviderProtectionLease, ProviderProtectionOwner } from './provider-effect-permit.ts'
import { controlledWorkloadIdentity } from './controlled-workload-identity.ts'
import type { ControlledCreationWindow } from './controlled-creation-window.ts'

const deny = (code: string): never => { throw new DurableDatabaseError(`INITIAL_PROVIDER_PROTECTION_${code}`) }

/** Actual first-cold issuer. Trusted deployment builds the original concrete
 * clients BEFORE any await; public RPC cannot supply an observation, pin-valid
 * callback, or authority implementation. A PG hold alone never reaches ISSUED.
 * Preparation failure retains all acquired resources for original-owner
 * reconciliation; neither request cancellation nor a timeout releases them. */
export function createInitialProviderProtection(pool: Pool, deployment: Readonly<{
  directory: FirstManagedBindingOwnerConfig
  agent: AgentCodexTransportConfiguration
  mounts: AgentMountCollectorConfig
  execution: ExecutionTargetCompositionConfiguration
  nfsServer: string
}>) {
  const accepted = captureFirstManagedBindingProfile(deployment.directory.acceptedProfileBytes, deployment.directory.expectedProfileDigest)
  const source = createFirstManagedObservationSource(deployment.directory, accepted)
  const agent = createAgentCodexTransport(deployment.agent)
  const collector = createAgentMountCollector(deployment.mounts)
  const observer = createControlledExecutionTargetObserver(deployment.execution)
  const nfsServer = deployment.nfsServer
  if (typeof nfsServer !== 'string' || !nfsServer || nfsServer.trim() !== nfsServer) { return deny('DEPLOYMENT') }
  const connect = pool.connect.bind(pool), borrowed: Pool = Object.create(pool, { connect: { value: connect, configurable: true } })
  let phase: 'UNUSED' | 'ACQUIRING' | 'ISSUED' | 'RELEASING' | 'RELEASED' | 'RETAINED' = 'UNUSED'
  let holder: HeldManagedLeafDirectory | null = null, control: AuthenticatedAgentControl | null = null
  let hold: NamespaceHoldInput | null = null, held = false, release: Promise<void> | undefined
  let holdAttempted = false
  let lease: ProviderProtectionLease | null = null
  let observedMount: AuthenticatedAgentMountObservation | null = null

  function lostPart(): string | null {
    if (phase !== 'ISSUED') { return 'PHASE' }
    if (!held || holder === null || !heldManagedLeafDirectoryValid(holder)) { return 'HELD_LEAF' }
    if (control === null || !authenticatedAgentControlValid(control)) { return `CONTROL_${control?.lossReason() ?? 'NONE'}` }
    return null
  }
  function live(): boolean { return lostPart() === null }
  function releaseOriginal(): Promise<void> {
    if (release) { return release }
    release = (async () => {
      if (!held || !hold || !control || !holder || phase !== 'ISSUED') { return deny('RELEASE_NOT_OWNED') }
      phase = 'RELEASING'
      // Stop proof comes from the ORIGINAL control/native process tree, not a
      // boolean from a caller or disappearance of a lease/Pod/Map entry.
      if (!await control.close()) { phase = 'RETAINED'; return deny('STOP_UNCONFIRMED') }
      try { await holder.release() }
      catch { phase = 'RETAINED'; return deny('DIRECTORY_RELEASE_UNCONFIRMED') }
      const result = await releaseNamespaceHold(borrowed, hold)
      if (!result.database.ok || result.database.commitOutcome !== 'ACKNOWLEDGED' || result.database.cleanupFailed ||
          !['RELEASED', 'ALREADY_RELEASED'].includes(result.disposition?.status ?? '')) {
        phase = 'RETAINED'; return deny('NAMESPACE_RELEASE_UNCONFIRMED')
      }
      held = false; phase = 'RELEASED'
    })().catch(error => { phase = 'RETAINED'; throw error })
    return release
  }

  return Object.freeze({
    phase: () => phase,
    control: () => control,
    mountObservation: () => observedMount,
    retainedNamespacePin: () => holdAttempted && phase !== 'RELEASED' ? hold?.pinId ?? null : null,
    async prepare(original: Readonly<{
      plan: AgentPodPlanRecord
      bindingId: string; originalDirectoryReference: string; originalDirectory: CanonicalCandidate
      pinId: string; ownerToken: string; actorId: string
    }> & ControlledCreationWindow, signal: AbortSignal): Promise<ProviderProtectionOwner> {
      if (phase !== 'UNUSED') { return deny('ALREADY_ATTEMPTED') }
      phase = 'ACQUIRING'
      const input = immutableSnapshot(original), plan = input.plan.plan
      const bindingId = logicalId('storage-binding', input.bindingId)
      const protectedMounts = plan.mountExpectations.protected
      if (protectedMounts.length !== 1 || protectedMounts[0].bindingId !== bindingId ||
          protectedMounts[0].mode !== 'RW' || protectedMounts[0].clientPath !== '/agent' ||
          protectedMounts[0].server !== nfsServer || protectedMounts[0].serverPath !==
            `/exports/runtime-domains/${accepted.record.profile.datasetName}/${protectedMounts[0].leafId}` ||
          plan.pod.metadata.namespace !== accepted.record.collector.namespace ||
          plan.pod.metadata.labels['orca.dev/dataset'] !== accepted.record.profile.datasetName ||
          !input.originalDirectoryReference || input.originalDirectory.canonicalDirectory !==
            `/${accepted.record.profile.datasetName}/${protectedMounts[0].leafId}`) { return deny('SCOPE') }
      hold = Object.freeze({ ...accepted.record.profile, digest: accepted.namespaceDigest,
        pinId: logicalId('storage-namespace-pin', input.pinId), ownerToken: input.ownerToken, actorId: input.actorId })
      try {
        holdAttempted = true
        const acquired = await acquireNamespaceHold(borrowed, hold)
        if (!acquired.database.ok || acquired.database.commitOutcome !== 'ACKNOWLEDGED' || acquired.database.cleanupFailed ||
            acquired.disposition?.status !== 'ACQUIRED') { return deny('NAMESPACE_NOT_NEW') }
        held = true
        holder = await source.acquireHeld(protectedMounts[0].leafId, signal)
        requireFirstManagedObservation(accepted.record, holder.observation, protectedMounts[0].leafId)
        if (!sameDirectory(holder.observation.candidate, input.originalDirectory)) { return deny('DIRECTORY_CHANGED') }
        control = await agent.prepare(signal)
        if (control.pod.pod.operationId !== plan.identity.operationId || control.pod.pod.runtimeUnitId !== plan.identity.unitId ||
            control.pod.pod.name !== plan.identity.resourceName || control.pod.pod.specHash !== plan.identity.specHash) {
          return deny('CONTROL_SCOPE')
        }
        const executionRecord = await observer.observe(control, { ...input, attemptId: plan.identity.attemptId }, signal)
        observedMount = await collector.collectControlled(input.plan, executionRecord.podUid, control, signal)
        const mounted = observedMount.mounts.find(item => item.kind === 'protected' && item.key === protectedMounts[0].key)
        const mapping = observedMount.storage.find(item => item.expected.kind === 'protected' && item.expected.key === protectedMounts[0].key)
        if (!mounted || !mapping || mounted.clientPath !== '/agent' || mounted.mode !== 'RW' || mounted.superMode !== 'RW' ||
            mapping.expected.serverPath !== protectedMounts[0].serverPath ||
            !mapping.expected.serverPath.endsWith(`/${protectedMounts[0].leafId}`) ||
            control.root.device !== mounted.clientStat.device || control.root.inode !== mounted.clientStat.inode ||
            mounted.clientStat.inode !== holder.observation.candidate.inode ||
            observedMount.pod.uid !== control.pod.pod.uid || observedMount.pod.nodeName !== control.pod.node.name ||
            executionRecord.runtimeUnitId !== plan.identity.unitId || executionRecord.podName !== plan.identity.resourceName ||
            executionRecord.executionEpoch !== plan.identity.executionEpoch) { return deny('MOUNT_SCOPE') }
        const target: ExecutionTarget = Object.freeze({ attemptId: executionRecord.attemptId, podUid: executionRecord.podUid,
          incarnation: executionRecord.incarnation, executionEpoch: executionRecord.executionEpoch,
          nodeUid: executionRecord.nodeUid, computeIdentityRef: executionRecord.computeIdentityRef, numericInstanceId: executionRecord.numericInstanceId })
        const workload = controlledWorkloadIdentity(control, executionRecord)
        // Brands are issued only here after concrete held server FD, actual Pod
        // authentication/control FD, same mount and original Compute verifier.
        const directory = Object.freeze({ evidenceRef: input.originalDirectoryReference, topologyPinId: hold.pinId,
          candidate: holder.observation.candidate }) as VerifiedDirectoryEvidence
        const mount = Object.freeze({ evidenceRef: `held-agent-mount:${randomUUID()}`, directory: directory.candidate,
          target, mode: 'RW' as const, actualReadOnly: false }) as VerifiedMountEvidence
        const authority: StorageEvidenceAuthority = Object.freeze({
          directory: ref => live() && ref === directory.evidenceRef ? directory : null,
          directoryPinValid: value => live() && value === directory,
          mount: ref => live() && ref === mount.evidenceRef ? mount : null,
          mountPinValid: value => live() && value === mount,
          executionTarget: (attempt, pod, incarnation, epoch) => live() && attempt === target.attemptId && pod === target.podUid &&
            incarnation === target.incarnation && epoch === target.executionEpoch ? target : null,
          executionTargetPinValid: value => live() && value === target,
          permanentComputeStop: () => null, computeStopPinValid: () => false,
        })
        lease = Object.freeze({ authority, target, executionRecord, workloadIdentity: workload.workloadIdentity,
          bindChallengeResponse: workload.challengeResponse,
          mounts: Object.freeze([Object.freeze({ bindingId, clientRoot: '/agent', evidence: mount })]), release: releaseOriginal })
        phase = 'ISSUED'
        if (!live()) { return deny(`LIFETIME_LOST_${lostPart()}`) }
        return Object.freeze({ takePreparedProtection() {
          if (!live() || !lease) { return deny(`LIFETIME_LOST_${lostPart() ?? 'LEASE'}`) }
          return lease
        } })
      } catch (error) { phase = 'RETAINED'; throw error }
    },
  })
}
