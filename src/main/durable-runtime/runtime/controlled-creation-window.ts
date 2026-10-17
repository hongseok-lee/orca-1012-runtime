import type { AuthenticatedPodObservation } from './kubernetes-pod-auth-types.ts'
import { auditTimestamp } from './compute-deletion-audit-input.ts'
import { ExecutionTargetCompositionError } from './execution-target-composition-types.ts'

export type ControlledCreationWindow = Readonly<{
  creationStartTime: string; creationEndTime: string; creationWindow?: never
}> | Readonly<{
  creationWindow: 'AUTHENTICATED_NODE'; creationStartTime?: never; creationEndTime?: never
}>

/** Search anchor only. The original exact Compute Audit verifier still has to
 * observe its own first/last operation and numeric instance identity. */
export function captureControlledCreationWindow(input: ControlledCreationWindow, node: AuthenticatedPodObservation['node']) {
  const fail = (): never => { throw new ExecutionTargetCompositionError('INPUT_INVALID') }
  if (input.creationWindow !== undefined) {
    if (input.creationWindow !== 'AUTHENTICATED_NODE' || input.creationStartTime !== undefined || input.creationEndTime !== undefined ||
        node.observationSource !== 'KUBERNETES_API' || typeof node.creationTimestamp !== 'string') { return fail() }
    const anchor = auditTimestamp(node.creationTimestamp)
    if (anchor === null) { return fail() }
    const iso = (value: bigint): string => {
      let seconds = value / 1_000_000_000n, fraction = value % 1_000_000_000n
      if (fraction < 0n) { seconds--; fraction += 1_000_000_000n }
      return new Date(Number(seconds * 1000n)).toISOString().replace('.000Z',
        `.${fraction.toString().padStart(9, '0')}Z`)
    }
    const startTime = iso(anchor - 3_600_000_000_000n), endTime = iso(anchor + 600_000_000_000n)
    return Object.freeze({ startTime, endTime })
  }
  const startTime = input.creationStartTime, endTime = input.creationEndTime
  if (typeof startTime !== 'string' || typeof endTime !== 'string') { return fail() }
  const start = auditTimestamp(startTime), end = auditTimestamp(endTime)
  if (start === null || end === null || start > end) { return fail() }
  return Object.freeze({ startTime, endTime })
}
