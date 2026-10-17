import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import { authenticatedAgentControlValid } from './agent-codex-transport.ts'
import type { AuthenticatedAgentControl } from './agent-codex-transport.ts'
import type { ExecutionTargetObservation } from './execution-target-records.ts'
import type { EvidenceRef, RuntimeReference, VerifiedWorkloadIdentity } from './runtime-evidence.ts'

/** Issues the workload brand only for this genuine live control after actual
 * Pod-bound TokenReview and the same captured control challenge. A PG row,
 * target snapshot, auth fingerprint or caller string cannot enter this path. */
export function controlledWorkloadIdentity(control: AuthenticatedAgentControl, target: ExecutionTargetObservation): Readonly<{
  workloadIdentity: VerifiedWorkloadIdentity
  challengeResponse: RuntimeReference<'bind-challenge-response'>
}> {
  if (!authenticatedAgentControlValid(control) || target.podUid !== control.pod.pod.uid ||
      target.runtimeUnitId !== control.pod.pod.runtimeUnitId || target.executionEpoch !== control.pod.pod.executionEpoch ||
      target.incarnation !== `agent-control:${control.controlId}:${control.controlPid}:${control.startTicks}` ||
      target.nodeUid !== control.pod.node.uid) { throw new DurableDatabaseError('CONTROL_WORKLOAD_SCOPE') }
  const workloadIdentity = Object.freeze({ attemptId: target.attemptId, podUid: target.podUid,
    incarnation: target.incarnation, executionEpoch: target.executionEpoch,
    producerId: logicalId('producer', control.controlId),
    principalRef: `kubernetes-service-account:${control.pod.namespace}:${control.pod.serviceAccount.uid}` as RuntimeReference<'workload-principal'>,
    authenticationEvidenceRef: `kubernetes-pod-auth:sha256:${control.pod.evidenceDigest}` as EvidenceRef,
  }) as VerifiedWorkloadIdentity
  return Object.freeze({ workloadIdentity,
    challengeResponse: `agent-control-challenge:${control.controlId}:${control.bindChallenge}` as RuntimeReference<'bind-challenge-response'> })
}
