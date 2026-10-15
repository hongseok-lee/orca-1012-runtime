import assert from 'node:assert/strict'
import { DurableTransaction } from '../db/connection.ts'
import type { PoolClient } from 'pg'
import type { GatewayContext } from './gateway/types.ts'
import type { AuthenticatedPodObservation, KubernetesPodAuthInput } from './kubernetes-pod-auth-types.ts'
import { expected, podToken } from './kubernetes-pod-auth-fixtures.mts'
import type { ComputeCreationIdentityInput, ComputeCreationIdentityResult } from './compute-creation-identity-types.ts'
import type { ExecutionTargetCompositionConfiguration } from './execution-target-composition-types.ts'

/** Synthetic trusted observer doubles; never an actual Pod/Cloud authentication. */
export const compositionScope = Object.freeze({ clusterIdentityRef: 'fixture-cluster', namespace: 'agents',
  dataset: 'fixture-dataset', audience: 'orca-runtime', projectId: 'fixture-project', projectNumber: '123456789012' })
export const compositionNode = Object.freeze({ zone: 'asia-northeast3-a', instanceName: 'fixture-vm-name',
  numericInstanceId: '18446744073709551615' })

export function compositionInput() {
  return { attemptId: '30000000-0000-4000-8000-000000000001', incarnation: 'synthetic-incarnation',
    podBearer: podToken, expected: { ...expected(), nodeName: 'agent-node', nodeUid: 'node-uid' },
    creationStartTime: '2026-10-15T00:00:00.000Z', creationEndTime: '2026-10-15T00:01:00.000Z' }
}
export function compositionPod(input: KubernetesPodAuthInput): AuthenticatedPodObservation {
  const e = input.expected
  return { kind: 'AUTHENTICATED_POD_OBSERVATION', ...compositionScope,
    serviceAccount: { name: e.serviceAccountName, uid: e.serviceAccountUid },
    pod: { name: e.podName, uid: e.podUid, resourceVersion: 'synthetic-pod-rv',
      runtimeUnitId: e.runtimeUnitId, operationId: e.operationId, executionEpoch: e.executionEpoch, specHash: e.specHash },
    node: { name: 'agent-node', uid: 'node-uid', resourceVersion: 'synthetic-node-rv',
      observationSource: 'KUBERNETES_API',
      providerId: `gce://${compositionScope.projectId}/${compositionNode.zone}/${compositionNode.instanceName}`,
      instanceId: compositionNode.numericInstanceId }, evidenceDigest: 'a'.repeat(64) }
}
export function compositionCreation(input: ComputeCreationIdentityInput): ComputeCreationIdentityResult {
  return { ok: true, observation: { status: 'CREATE_OPERATION_COMPLETED', source: 'CLOUD_AUDIT_LOGS',
    identity: { ...input.scope }, operationId: 'synthetic-creation-operation', producer: 'compute.googleapis.com',
    first: { insertId: 'synthetic-creation-first', timestamp: input.startTime },
    last: { insertId: 'synthetic-creation-last', timestamp: input.endTime }, evidenceDigest: 'b'.repeat(64) } }
}
type PodCall = ExecutionTargetCompositionConfiguration['podAuthenticator']['authenticatePod']
type CreationCall = ExecutionTargetCompositionConfiguration['creationObserver']['observe']
export function compositionDoubles(control: { pod?: PodCall; creation?: CreationCall } = {}) {
  const calls: { kind: 'pod' | 'creation'; input: KubernetesPodAuthInput | ComputeCreationIdentityInput;
    signal: AbortSignal | undefined }[] = []
  const pod = { async authenticatePod(input: KubernetesPodAuthInput, signal: AbortSignal) {
    assert.equal(this, pod)
    calls.push({ kind: 'pod', input, signal })
    return control.pod ? control.pod(input, signal) : compositionPod(input)
  } }
  const creation = { async observe(input: ComputeCreationIdentityInput, signal?: AbortSignal) {
    assert.equal(this, creation)
    calls.push({ kind: 'creation', input, signal })
    return control.creation ? control.creation(input, signal) : compositionCreation(input)
  } }
  const configuration: { -readonly [K in keyof ExecutionTargetCompositionConfiguration]:
    ExecutionTargetCompositionConfiguration[K] } = {
    ...compositionScope, timeoutMs: 1000, podAuthenticator: pod, creationObserver: creation
  }
  return { configuration, calls, pod, creation }
}

export function compositionDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

/** SQL transport double only. Actual record/gateway/transaction methods run unchanged.
 * This is not PG lease/FK qualification; the separate PG callback covers real SQL. */
export function compositionTransaction(context: GatewayContext, beforeFirstQuery?: () => void) {
  const scope = context.controller.scope, unitId = context.runtimeUnitId, operationId = context.operationId
  const owner = context.controller.owner, term = context.controller.term
  const queries: { sql: string; values: readonly unknown[] }[] = []
  let row: Record<string, unknown> | null = null
  const client = { async query(sql: string, values: readonly unknown[] = []) {
    queries.push({ sql, values: [...values] })
    if (queries.length === 1) {
      beforeFirstQuery?.()
    }
    let rows: Record<string, unknown>[]
    if (sql.startsWith('SELECT id FROM durable_runtime.runtime_units')) {
      assert.equal(values[0], unitId)
      rows = [{ id: unitId }]
    } else if (sql.startsWith('SELECT id FROM durable_runtime.operations')) {
      assert.equal(values[0], operationId)
      rows = [{ id: operationId }]
    } else if (sql.includes('SELECT controller_scope')) {
      assert.deepEqual(values, [operationId, unitId])
      rows = [{ controller_scope: scope }]
    } else if (sql.startsWith('SELECT scope FROM durable_runtime.controller_leases')) {
      assert.equal(values[0], scope)
      if (values.length === 3) {
        assert.deepEqual(values, [scope, owner, term])
      }
      rows = [{ scope }]
    } else if (sql.includes('INSERT INTO durable_runtime.execution_target_records')) {
      const value = (index: number): string => {
        assert.equal(typeof values[index], 'string')
        return String(values[index])
      }
      row = { attempt_id: value(4), runtime_unit_id: value(5), execution_epoch: value(6),
        pod_uid: value(7), incarnation: value(8), cluster_identity_ref: value(9), namespace: value(10),
        pod_name: value(11), pod_resource_version: value(12), node_name: value(13), node_uid: value(14),
        node_resource_version: value(15), project_id: value(16), project_number: value(17), zone: value(18),
        instance_name: value(19), numeric_instance_id: value(20), compute_identity_ref: value(21),
        observed_at: new Date(value(22)), kubernetes_evidence_ref: value(23),
        compute_identity_evidence_ref: value(24), observation_digest: value(25),
        recorded_at: new Date('2026-10-15T00:02:00.000Z') }
      rows = [row]
    } else if (sql.includes('FROM durable_runtime.execution_target_records')) {
      rows = row ? [row] : []
    } else {
      throw new Error('Unexpected synthetic SQL')
    }
    return { rows, rowCount: rows.length }
  } }
  // Only a fixture PoolClient transport shape, not a verified controller issuer.
  return { tx: new DurableTransaction(client as unknown as PoolClient), queries }
}
