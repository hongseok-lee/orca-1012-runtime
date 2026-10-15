import { computeAuditRequestBody, snapshotAuditInput } from './compute-deletion-audit-input'
import { evaluateComputeAuditPage } from './compute-deletion-audit-parser'
import { projectComputeAuditPage } from './compute-deletion-audit-projection'
import { readComputeAuditPage, snapshotAuditTransport } from './compute-deletion-audit-transport'
import type { ComputeAuditTransportConfiguration } from './compute-deletion-audit-transport'
import type { ComputeDeletionAuditInput, ComputeDeletionAuditResult } from './compute-deletion-audit-types'
import { auditError, freezeAuditValue } from './compute-deletion-audit-types'

export type {
  ComputeDeletionScope, ComputeDeletionAuditInput, ComputeDeletionAuditResult,
  ComputeDeletionObservation, ComputeAuditErrorCode
} from './compute-deletion-audit-types'
export type { ComputeAuditTransportConfiguration } from './compute-deletion-audit-transport'

/** Pure fixture seam. No authority, PG mapping, storage lifetime pin or proof is implied. */
export function observeComputeDeletionAuditPage(
  input: ComputeDeletionAuditInput,
  page: unknown
): ComputeDeletionAuditResult {
  const copied = snapshotAuditInput(input)
  if (!copied) {
    return auditError('INVALID_INPUT')
  }
  const projected = projectComputeAuditPage(page)
  return projected.ok
    ? freezeAuditValue<ComputeDeletionAuditResult>({ ok: true, observation: evaluateComputeAuditPage(copied, projected.page) })
    : projected
}

/** Trusted composition injects a token supplier; callers cannot choose a URL or raw filter. */
export function createComputeDeletionAuditClient(config: ComputeAuditTransportConfiguration):
  Readonly<{
    observe(input: ComputeDeletionAuditInput, signal?: AbortSignal): Promise<ComputeDeletionAuditResult>
  }> {
  const transport = snapshotAuditTransport(config)
  return Object.freeze({
    async observe(input: ComputeDeletionAuditInput, signal?: AbortSignal):
      Promise<ComputeDeletionAuditResult> {
      // Copy all identity/time fields and construct the entire body before the first await.
      const copied = snapshotAuditInput(input)
      if (!copied) {
        return auditError('INVALID_INPUT')
      }
      if (!transport) {
        return auditError('INVALID_CONFIGURATION')
      }
      const body = computeAuditRequestBody(copied)
      const result = await readComputeAuditPage(transport, body, signal)
      return result.ok
        ? freezeAuditValue<ComputeDeletionAuditResult>({ ok: true, observation: evaluateComputeAuditPage(copied, result.page) })
        : result
    }
  })
}
