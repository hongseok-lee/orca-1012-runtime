import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { canonicalCreationUint64 } from './compute-creation-identity-input.ts'
import { auditTimestamp, snapshotAuditInput } from './compute-deletion-audit-input.ts'
import { createComputeDeletionAuditClient } from './compute-deletion-audit.ts'
import type { ExecutionTargetRecord } from './execution-target-records.ts'
import { ComputeStopEvidenceError } from './compute-stop-evidence-types.ts'
import type { ComputeStopEvidenceConfiguration, ComputeStopEvidenceInput } from './compute-stop-evidence-types.ts'

export function stopText<T extends string>(value: T): T {
  if (typeof value !== 'string' || !value || value.trim() !== value ||
      Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error('Invalid text')
  }
  return value
}

export function captureStopConfiguration(original: ComputeStopEvidenceConfiguration) {
  try {
    const pool = original.pool, connect = pool.connect
    const datasetName = stopText(original.datasetName), clusterIdentityRef = stopText(original.clusterIdentityRef)
    const namespace = stopText(original.namespace), projectId = stopText(original.projectId)
    const projectNumber = stopText(original.projectNumber), timeoutMs = original.timeoutMs
    const audit = original.audit, provider = audit.tokenProvider, token = provider.getAccessToken
    const transport = audit.https, request = transport?.request
    const auditTimeout = audit.timeoutMs, maxResponseBytes = audit.maxResponseBytes
    if (typeof connect !== 'function' || typeof token !== 'function' ||
        (transport !== undefined && typeof request !== 'function') ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647 ||
        (auditTimeout !== undefined && (!Number.isSafeInteger(auditTimeout) || auditTimeout <= 0 || auditTimeout > 2_147_483_647)) ||
        (maxResponseBytes !== undefined && (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0)) ||
        !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) || !/^[1-9][0-9]*$/.test(projectNumber)) {
      throw new Error('Invalid configuration')
    }
    const client = createComputeDeletionAuditClient({
      tokenProvider: { getAccessToken: signal => token.call(provider, signal) },
      timeoutMs: auditTimeout ?? timeoutMs, maxResponseBytes,
      ...(transport && request ? { https: { request: request.bind(transport) } } : {})
    })
    return Object.freeze({ connect: connect.bind(pool), datasetName, clusterIdentityRef,
      namespace, projectId, projectNumber, timeoutMs, observe: client.observe.bind(client) })
  } catch {
    throw new ComputeStopEvidenceError('INVALID_CONFIGURATION')
  }
}

export type CapturedStopConfiguration = ReturnType<typeof captureStopConfiguration>

export function captureStopInput(original: ComputeStopEvidenceInput): ComputeStopEvidenceInput {
  try {
    const key = original.key
    const runtimeUnitId = logicalId('runtime-unit', original.runtimeUnitId)
    const attemptId = logicalId('attempt', key.attemptId), podUid = stopText(key.podUid)
    const incarnation = stopText(key.incarnation), executionEpoch = counter('execution-epoch', key.executionEpoch)
    const startTime = stopText(original.startTime), endTime = stopText(original.endTime)
    const start = auditTimestamp(startTime), end = auditTimestamp(endTime)
    if (start === null || end === null || start > end) {
      throw new Error('Invalid time window')
    }
    return Object.freeze({ runtimeUnitId, key: Object.freeze({ attemptId, podUid, incarnation, executionEpoch }),
      startTime, endTime })
  } catch {
    throw new ComputeStopEvidenceError('INVALID_INPUT')
  }
}

export function capturedTargetAuditInput(config: CapturedStopConfiguration,
  input: ComputeStopEvidenceInput, target: ExecutionTargetRecord) {
  const key = input.key
  if (target.runtimeUnitId !== input.runtimeUnitId || target.attemptId !== key.attemptId ||
      target.podUid !== key.podUid || target.incarnation !== key.incarnation || target.executionEpoch !== key.executionEpoch ||
      target.clusterIdentityRef !== config.clusterIdentityRef || target.namespace !== config.namespace ||
      target.projectId !== config.projectId || target.projectNumber !== config.projectNumber ||
      !canonicalCreationUint64(target.numericInstanceId) ||
      auditTimestamp(target.observedAt) === null || auditTimestamp(target.recordedAt) === null) {
    throw new ComputeStopEvidenceError('TARGET_MISMATCH')
  }
  const auditInput = snapshotAuditInput({ scope: {
    projectId: target.projectId, projectNumber: target.projectNumber, zone: target.zone,
    instanceName: target.instanceName, numericInstanceId: target.numericInstanceId
  }, startTime: input.startTime, endTime: input.endTime })
  if (!auditInput) {
    throw new ComputeStopEvidenceError('TARGET_MISMATCH')
  }
  return auditInput
}
