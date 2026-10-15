import { createHash } from 'node:crypto'
import { auditTimestamp } from './compute-deletion-audit-input.ts'
import type { ComputeDeletionAuditInput, ComputeDeletionAuditResult } from './compute-deletion-audit-types.ts'
import type { ExecutionTargetRecord } from './execution-target-records.ts'
import type { ExecutionTarget, VerifiedPermanentComputeStop } from '../storage/evidence.ts'
import type { ComputeStoppedProof, EvidenceRef } from './runtime-evidence.ts'

import { ComputeStopBudget } from './compute-stop-evidence-budget.ts'
import { captureStopConfiguration, captureStopInput, capturedTargetAuditInput } from './compute-stop-evidence-input.ts'
import { readCommittedStopTarget } from './compute-stop-evidence-reader.ts'
import { ComputeStopEvidenceError } from './compute-stop-evidence-types.ts'
import type { ComputeStopEvidenceConfiguration, ComputeStopEvidenceInput, PreparedComputeStopEvidence } from './compute-stop-evidence-types.ts'

export { ComputeStopEvidenceError } from './compute-stop-evidence-types.ts'
export type { ComputeStopEvidenceConfiguration, ComputeStopEvidenceInput, PreparedComputeStopEvidence,
  ComputeStopEvidenceErrorCode } from './compute-stop-evidence-types.ts'

/** Trusted preparation only; no actuator, startup binding, storage mutation or complete Storage authority. */
export function createComputeStopEvidence(configuration: ComputeStopEvidenceConfiguration): Readonly<{
  prepare(input: ComputeStopEvidenceInput, signal: AbortSignal): Promise<PreparedComputeStopEvidence>
}> {
  const config = captureStopConfiguration(configuration)
  return Object.freeze({
    async prepare(original: ComputeStopEvidenceInput, signal: AbortSignal): Promise<PreparedComputeStopEvidence> {
      const budget = new ComputeStopBudget(signal, config.timeoutMs)
      try {
        budget.check()
        const input = captureStopInput(original)
        budget.check()
        const target = await readCommittedStopTarget(config, input, budget)
        budget.check()
        const auditInput = capturedTargetAuditInput(config, input, target)
        budget.check()
        const result = await budget.wait(() => config.observe(auditInput, budget.signal, budget.deadline))
        budget.check()
        const owner = issueComputeStopOwner(config.datasetName, target, auditInput, result, signal)
        try { budget.check(); return owner } catch (error) { owner.release(); throw error }
      } catch (error) {
        budget.check()
        throw error instanceof ComputeStopEvidenceError ? error : new ComputeStopEvidenceError('DB_READ_FAILED')
      } finally {
        budget.close()
      }
    }
  })
}

/** The only brand issuance site: exact committed target plus complete authenticated deletion Audit. */
function issueComputeStopOwner(datasetName: string, target: ExecutionTargetRecord,
  input: ComputeDeletionAuditInput, result: ComputeDeletionAuditResult, signal: AbortSignal): PreparedComputeStopEvidence {
  if (!result.ok || result.observation.status !== 'DELETE_OPERATION_COMPLETED') {
    throw new ComputeStopEvidenceError('AUDIT_REJECTED')
  }
  const observation = result.observation
  const first = auditTimestamp(observation.first.timestamp), last = auditTimestamp(observation.last.timestamp)
  const observed = auditTimestamp(target.observedAt), start = auditTimestamp(input.startTime), end = auditTimestamp(input.endTime)
  if (Object.entries(input.scope).some(([key, value]) => Reflect.get(observation.identity, key) !== value) ||
      observation.producer !== 'compute.googleapis.com' || !observation.operationId ||
      !observation.first.insertId || !observation.last.insertId || !/^[a-f0-9]{64}$/.test(observation.evidenceDigest) ||
      first === null || last === null || observed === null || start === null || end === null ||
      first < start || first > last || last > end || last < observed) {
    throw new ComputeStopEvidenceError('AUDIT_REJECTED')
  }
  const digest = createHash('sha256').update(JSON.stringify([
    'compute-stop-evidence-v1', datasetName, target, observation.operationId, observation.producer,
    observation.first, observation.last, observation.evidenceDigest
  ])).digest('hex')
  // SAFETY: All components come from the exact committed row and validated fixed Audit client above.
  const reference = `compute-stop:sha256:${digest}` as EvidenceRef
  const executionTarget: ExecutionTarget = Object.freeze({ attemptId: target.attemptId, podUid: target.podUid,
    incarnation: target.incarnation, executionEpoch: target.executionEpoch, nodeUid: target.nodeUid,
    computeIdentityRef: target.computeIdentityRef, numericInstanceId: target.numericInstanceId })
  // SAFETY: This private site issues only after committed target and complete exact deletion verification.
  const proof = Object.freeze({ kind: 'COMPUTE_STOPPED', evidenceRef: reference,
    observedAt: observation.last.timestamp, attemptId: target.attemptId, podUid: target.podUid,
    executionEpoch: target.executionEpoch, incarnation: target.incarnation,
    nodeUid: target.nodeUid, computeIdentityRef: target.computeIdentityRef,
    observationSource: 'COMPUTE_CONTROL_PLANE' }) as ComputeStoppedProof
  // SAFETY: The proof above and the same canonical numeric identity establish this private compute lifetime owner.
  const stopped = Object.freeze({ proof, numericInstanceId: target.numericInstanceId,
    disposition: 'DELETED_NO_REENTRY' }) as VerifiedPermanentComputeStop
  let released = false
  const alive = (): boolean => !released && !signal.aborted
  const owner: PreparedComputeStopEvidence = { reference,
    executionTarget(attemptId, podUid, incarnation, epoch) {
      return alive() && attemptId === target.attemptId && podUid === target.podUid &&
        incarnation === target.incarnation && epoch === target.executionEpoch ? executionTarget : null
    },
    executionTargetPinValid: held => alive() && held === executionTarget,
    permanentComputeStop: candidate => alive() && candidate === reference ? stopped : null,
    computeStopPinValid: held => alive() && held === stopped,
    release() { released = true }
  }
  return Object.freeze(owner)
}
