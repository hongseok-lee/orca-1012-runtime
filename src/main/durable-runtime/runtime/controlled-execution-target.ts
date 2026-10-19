import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { captureControlledCreationWindow } from './controlled-creation-window.ts'
import type { ControlledCreationWindow } from './controlled-creation-window.ts'
import { authenticatedAgentControlValid } from './agent-codex-transport.ts'
import type { AuthenticatedAgentControl } from './agent-codex-transport.ts'
import { captureCompositionConfiguration } from './execution-target-composition-input.ts'
import { captureCompositionPod, compositionComputeScope, captureCompositionCreation, captureCompositionNodeIdentity, compositionObservation } from './execution-target-composition-observation.ts'
import type { CompositionScopeInput } from './execution-target-composition-observation.ts'
import type { ExecutionTargetCompositionConfiguration } from './execution-target-composition-types.ts'
import { ExecutionTargetCompositionError } from './execution-target-composition-types.ts'

/** Reuses the original Pod/Node projections and explicit identity source.
 * The Pod authentication is already owned by the live private control, so it is
 * not repeated and its bearer never leaves that boundary. The audit mode checks
 * historical creation; node mode records only the authenticated Node identity.
 * this flat result is not a physical pin or permanent-stop proof. */
export function createControlledExecutionTargetObserver(configuration: ExecutionTargetCompositionConfiguration) {
  const config = captureCompositionConfiguration(configuration)
  return Object.freeze({ async observe(control: AuthenticatedAgentControl, original: Readonly<{
    attemptId: string
  }> & ControlledCreationWindow, signal: AbortSignal) {
  if (!authenticatedAgentControlValid(control) || signal.aborted) { throw new ExecutionTargetCompositionError('PREPARED_INVALID') }
  const observed = control.pod
  const { startTime, endTime } = captureControlledCreationWindow(original, observed.node)
  const input: CompositionScopeInput = Object.freeze({ attemptId: logicalId('attempt', original.attemptId),
    incarnation: `agent-control:${control.controlId}:${control.controlPid}:${control.startTicks}`,
    runtimeUnitId: logicalId('runtime-unit', observed.pod.runtimeUnitId), operationId: logicalId('operation', observed.pod.operationId),
    executionEpoch: counter('execution-epoch', observed.pod.executionEpoch), startTime, endTime,
    pod: Object.freeze({ expected: Object.freeze({ serviceAccountName: observed.serviceAccount.name,
      serviceAccountUid: observed.serviceAccount.uid, podName: observed.pod.name, podUid: observed.pod.uid,
      runtimeUnitId: observed.pod.runtimeUnitId, operationId: observed.pod.operationId, executionEpoch: observed.pod.executionEpoch,
      specHash: observed.pod.specHash, nodeName: observed.node.name, nodeUid: observed.node.uid }) }) })
  const pod = captureCompositionPod(config, input, observed), scope = compositionComputeScope(config, pod)
  const identity = config.observeCreation
    ? captureCompositionCreation(scope, await config.observeCreation({ scope, startTime, endTime }, signal))
    : captureCompositionNodeIdentity(pod)
  if (signal.aborted || !authenticatedAgentControlValid(control)) { throw new ExecutionTargetCompositionError('PREPARED_INVALID') }
  return compositionObservation(config, input, pod, scope, identity)
  } })
}
