import { performance } from 'node:perf_hooks'
import { creationAuditRequestBody, snapshotCreationInput } from './compute-creation-identity-input'
import { evaluateComputeCreationPage } from './compute-creation-identity-parser'
import { projectComputeAuditPage } from './compute-deletion-audit-projection'
import { readComputeAuditPage, snapshotAuditTransport } from './compute-deletion-audit-transport'
import type { ComputeAuditTransportConfiguration } from './compute-deletion-audit-transport'
import type {
  ComputeCreationIdentityInput, ComputeCreationIdentityResult
} from './compute-creation-identity-types'
import { auditError, freezeAuditValue } from './compute-deletion-audit-types'

export type {
  ComputeCreationScope, ComputeCreationIdentityInput, ComputeCreationObservation,
  ComputeCreationIdentityResult
} from './compute-creation-identity-types'
export type { ComputeAuditTransportConfiguration } from './compute-deletion-audit-transport'

/** Pure fixture seam only; no Cloud read, workload brand or execution proof. */
export function observeComputeCreationIdentityPage(
  input: ComputeCreationIdentityInput, page: unknown
): ComputeCreationIdentityResult {
  const copied = snapshotCreationInput(input)
  if (!copied) {
    return auditError('INVALID_INPUT')
  }
  try {
    const projected = projectComputeAuditPage(page)
    return projected.ok
      ? freezeAuditValue<ComputeCreationIdentityResult>({
        ok: true, observation: evaluateComputeCreationPage(copied, projected.page)
      })
      : projected
  } catch {
    return auditError('INVALID_RESPONSE')
  }
}

/** Reuses the Audit client; the inherited first-request deadline fix must merge before tests. */
export function createComputeCreationIdentityClient(config: ComputeAuditTransportConfiguration):
  Readonly<{
    observe(input: ComputeCreationIdentityInput, signal?: AbortSignal): Promise<ComputeCreationIdentityResult>
  }> {
  const transport = snapshotAuditTransport(config)
  return Object.freeze({
    async observe(input: ComputeCreationIdentityInput, signal?: AbortSignal):
      Promise<ComputeCreationIdentityResult> {
      const deadline = performance.now() + (transport?.timeoutMs ?? 0)
      if (signal?.aborted) {
        return auditError('ABORTED')
      }
      const copied = snapshotCreationInput(input)
      if (!transport) {
        return signal?.aborted ? auditError('ABORTED') : auditError('INVALID_CONFIGURATION')
      }
      const expired = (): ComputeCreationIdentityResult | null => signal?.aborted
        ? auditError('ABORTED') : performance.now() >= deadline ? auditError('TIMEOUT') : null
      const afterCapture = expired()
      if (afterCapture) {
        return afterCapture
      }
      if (!copied) {
        return auditError('INVALID_INPUT')
      }
      const body = creationAuditRequestBody(copied)
      const beforeAwait = expired()
      if (beforeAwait) {
        return beforeAwait
      }
      // Do not restart the observer budget after synchronous capture/body construction.
      const page = await readComputeAuditPage({
        ...transport, timeoutMs: Math.max(1, Math.ceil(deadline - performance.now()))
      }, body, signal)
      const afterAwait = expired()
      if (afterAwait) {
        return afterAwait
      }
      const result = page.ok
        ? freezeAuditValue<ComputeCreationIdentityResult>({
          ok: true, observation: evaluateComputeCreationPage(copied, page.page)
        })
        : page
      return expired() ?? result
    }
  })
}
