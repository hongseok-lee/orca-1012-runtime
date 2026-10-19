import type { Pool } from 'pg'
import { logicalId, counter } from '../../shared/durable-runtime/identity.ts'
import { createComputeStopEvidence } from '../durable-runtime/runtime/compute-stop-evidence.ts'
import type { PodUid, Incarnation } from '../durable-runtime/runtime/runtime-evidence.ts'
import type { OrphanCandidate } from '../durable-runtime/runtime/orphan-reconcile.ts'
import type { OrcadControllerConfig } from './orcad-controller-config.ts'

/** Read-only fallback for a genuinely deleted node; never deletes or stops a VM. */
export async function prepareOrphanComputeStop(pool: Pool, config: OrcadControllerConfig, candidate: OrphanCandidate, signal: AbortSignal) {
  const row = (await pool.query<{ cluster_identity_ref: string; project_id: string; project_number: string; observed_at: Date }>(`
    SELECT cluster_identity_ref,project_id,project_number,observed_at FROM durable_runtime.execution_target_records
    WHERE attempt_id=$1 AND runtime_unit_id=$2 AND pod_uid=$3 AND incarnation=$4 AND execution_epoch=$5 AND namespace=$6`,
  [candidate.attemptId, candidate.runtimeUnitId, candidate.podUid, candidate.incarnation, candidate.executionEpoch, config.inventory.namespace])).rows[0]
  if (!row || signal.aborted) { return null }
  const service = createComputeStopEvidence({ pool, datasetName: config.datasetName,
    clusterIdentityRef: row.cluster_identity_ref, namespace: config.inventory.namespace,
    projectId: row.project_id, projectNumber: row.project_number, timeoutMs: config.inventory.requestTimeoutMs,
    audit: { timeoutMs: config.inventory.requestTimeoutMs, tokenProvider: {
      async getAccessToken(caller) {
        const response = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
          { headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal: caller })
        if (!response.ok || response.headers.get('Metadata-Flavor') !== 'Google') { throw new Error('COMPUTE_STOP_TOKEN_UNAVAILABLE') }
        const value: unknown = await response.json()
        const token = value && typeof value === 'object' ? Reflect.get(value, 'access_token') : null
        if (typeof token !== 'string' || !token) { throw new Error('COMPUTE_STOP_TOKEN_UNAVAILABLE') }
        return token
      }
    } } })
  return service.prepare({ runtimeUnitId: logicalId('runtime-unit', candidate.runtimeUnitId),
    key: { attemptId: logicalId('attempt', candidate.attemptId), // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Exact stored key; stop collector revalidates it before Cloud I/O.
      podUid: candidate.podUid as PodUid,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Exact stored key; stop collector revalidates it before Cloud I/O.
      incarnation: candidate.incarnation as Incarnation, executionEpoch: counter('execution-epoch', candidate.executionEpoch) },
    startTime: row.observed_at.toISOString(), endTime: new Date().toISOString() }, signal)
}
