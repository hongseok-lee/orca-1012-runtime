import { performance } from 'node:perf_hooks'
import type { DurableTransaction } from '../db/connection.ts'
import type { GatewayContext } from './gateway/types.ts'
import { snapshotCreationInput } from './compute-creation-identity-input.ts'
import { recordExecutionTarget } from './execution-target-records.ts'
import type { ExecutionTargetObservation } from './execution-target-records.ts'
import { captureCompositionConfiguration, captureCompositionContext, captureCompositionInput } from './execution-target-composition-input.ts'
import { captureCompositionCreation, captureCompositionPod, compositionComputeScope,
  compositionObservation } from './execution-target-composition-observation.ts'
import type { ExecutionTargetComposition, ExecutionTargetCompositionConfiguration,
  ExecutionTargetPrepareInput, PreparedExecutionTarget } from './execution-target-composition-types.ts'
import { ExecutionTargetCompositionError } from './execution-target-composition-types.ts'

export { ExecutionTargetCompositionError } from './execution-target-composition-types.ts'
export type { ExecutionTargetComposition, ExecutionTargetCompositionConfiguration,
  ExecutionTargetPrepareInput, PreparedExecutionTarget,
  TransactionLocalExecutionTarget } from './execution-target-composition-types.ts'

/** Bounded waiting even when the trusted dependency ignores its AbortSignal. */
function awaitObservation(start: () => unknown, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false
    const abort = (): void => fail('ABORTED')
    function fail(code: 'ABORTED' | 'OBSERVER_FAILED'): void {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', abort)
      reject(new ExecutionTargetCompositionError(code))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    let pending: Promise<unknown>
    try {
      pending = Promise.resolve(start())
    } catch {
      fail('OBSERVER_FAILED')
      return
    }
    void pending.then(value => {
      if (!settled) {
        settled = true
        signal.removeEventListener('abort', abort)
        resolve(value)
      }
    }, () => fail('OBSERVER_FAILED'))
  })
}

/** External prepare completes before callers enter a SQL transaction. No startup wiring. */
export function createExecutionTargetComposition(
  configuration: ExecutionTargetCompositionConfiguration
): ExecutionTargetComposition {
  const config = captureCompositionConfiguration(configuration)
  const prepared = new WeakMap<PreparedExecutionTarget, Readonly<{
    observation: ExecutionTargetObservation; operationId: string
  }>>()
  return Object.freeze({
    async prepare(original: ExecutionTargetPrepareInput, signal: AbortSignal) {
      const deadline = performance.now() + config.timeoutMs
      const cancellation = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      let expired = false
      const abort = (): void => cancellation.abort()
      const check = (): void => {
        if (signal.aborted) {
          cancellation.abort()
          throw new ExecutionTargetCompositionError('ABORTED')
        }
        if (expired || performance.now() >= deadline) {
          expired = true
          cancellation.abort()
          throw new ExecutionTargetCompositionError('TIMEOUT')
        }
      }
      const arm = (): void => {
        const remaining = deadline - performance.now()
        if (remaining <= 0) {
          expired = true
          cancellation.abort()
        } else {
          timer = setTimeout(arm, Math.min(Math.ceil(remaining), 2_147_483_647))
        }
      }
      signal.addEventListener('abort', abort, { once: true })
      try {
        check()
        arm()
        const input = captureCompositionInput(original)
        check()
        const rawPod = await awaitObservation(() => config.authenticatePod(input.pod, cancellation.signal), cancellation.signal)
        check()
        const pod = captureCompositionPod(config, input, rawPod)
        const scope = compositionComputeScope(config, pod)
        const creationInput = snapshotCreationInput({ scope, startTime: input.startTime, endTime: input.endTime })
        if (!creationInput) {
          throw new ExecutionTargetCompositionError('INPUT_INVALID')
        }
        check()
        const rawCreation = await awaitObservation(() => config.observeCreation(creationInput, cancellation.signal), cancellation.signal)
        check()
        const creationDigest = captureCompositionCreation(scope, rawCreation)
        const observation = compositionObservation(config, input, pod, scope, creationDigest)
        check()
        const handle = Object.freeze({ kind: 'PREPARED_EXECUTION_TARGET' }) as PreparedExecutionTarget
        prepared.set(handle, Object.freeze({ observation, operationId: input.operationId }))
        try {
          check()
          return handle
        } catch (error) {
          prepared.delete(handle)
          throw error
        }
      } catch (error) {
        check()
        throw error instanceof ExecutionTargetCompositionError
          ? error : new ExecutionTargetCompositionError('OBSERVER_FAILED')
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        cancellation.abort()
      }
    },
    async record(tx: DurableTransaction, originalContext: GatewayContext, handle: PreparedExecutionTarget) {
      if (handle === null || typeof handle !== 'object' || !prepared.has(handle)) {
        throw new ExecutionTargetCompositionError('PREPARED_INVALID')
      }
      const held = prepared.get(handle)!
      const context = captureCompositionContext(originalContext)
      if (context.runtimeUnitId !== held.observation.runtimeUnitId || context.operationId !== held.operationId) {
        throw new ExecutionTargetCompositionError('CONTEXT_SCOPE')
      }
      const record = await recordExecutionTarget(tx, context, held.observation)
      return Object.freeze({ status: 'TRANSACTION_LOCAL', record })
    }
  })
}
