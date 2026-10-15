import assert from 'node:assert/strict'
import type { Pool, PoolClient } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { ExecutionTargetRecordRow } from '../db/execution-target-record-rows.ts'
import type { ComputeStopEvidenceConfiguration } from './compute-stop-evidence-types.ts'
import { deletionEntries, fixtureInput } from './compute-deletion-audit-fixtures.mts'
import { auditWire, type AuditWireScenario } from './compute-deletion-audit-transport-fixtures.mts'

export function stopFixtureRow(): ExecutionTargetRecordRow {
  // Synthetic SQL row only; this cast issues no production evidence or authority.
  return {
    attempt_id: '30000000-0000-4000-8000-000000000001',
    runtime_unit_id: '30000000-0000-4000-8000-000000000002', execution_epoch: '1',
    pod_uid: 'synthetic-stop-pod', incarnation: 'synthetic-stop-incarnation',
    cluster_identity_ref: 'synthetic-stop-cluster', namespace: 'synthetic-agents',
    pod_name: 'synthetic-stop-agent', pod_resource_version: 'pod-rv1',
    node_name: 'synthetic-node', node_uid: 'synthetic-node-uid', node_resource_version: 'node-rv1',
    project_id: fixtureInput.scope.projectId, project_number: fixtureInput.scope.projectNumber,
    zone: fixtureInput.scope.zone, instance_name: fixtureInput.scope.instanceName,
    numeric_instance_id: fixtureInput.scope.numericInstanceId, compute_identity_ref: 'synthetic-compute-ref',
    observed_at: new Date('2026-10-14T11:32:00.000Z'), recorded_at: new Date('2026-10-14T11:32:01.000Z'),
    kubernetes_evidence_ref: 'synthetic-pod-evidence', compute_identity_evidence_ref: 'synthetic-create-evidence',
    observation_digest: 'a'.repeat(64)
  } as ExecutionTargetRecordRow
}

export function stopFixtureInput(row = stopFixtureRow()) {
  return { runtimeUnitId: logicalId('runtime-unit', row.runtime_unit_id), key: {
    attemptId: logicalId('attempt', row.attempt_id), podUid: row.pod_uid,
    incarnation: row.incarnation, executionEpoch: counter('execution-epoch', row.execution_epoch)
  }, startTime: fixtureInput.startTime, endTime: fixtureInput.endTime }
}

export function stopDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

export type StopFixtureControl = {
  row?: ExecutionTargetRecordRow | null
  datasetRows?: { dataset_name: string }[]
  beforeConnect?: () => Promise<void>
  beforeQuery?: (sql: string) => Promise<void>
  token?: (signal: AbortSignal) => Promise<string>
  scenario?: AuditWireScenario
}

/** Pool/HTTPS transport doubles; actual readExecutionTarget and Audit evaluator run unchanged. */
export function stopFixture(control: StopFixtureControl = {}) {
  const row = control.row === undefined ? stopFixtureRow() : control.row
  const queries: string[] = [], releases: boolean[] = [], phases: string[] = []
  let connections = 0, checkedOut = 0
  const wire = auditWire(control.scenario ?? { json: { entries: deletionEntries() } })
  const clients: PoolClient[] = []
  const pool = {
    async connect() {
      assert.equal(this, pool)
      connections++
      phases.push('CONNECT')
      await control.beforeConnect?.()
      checkedOut++
      let returned = false
      const client = {
        async query(sql: string, values: unknown[] = []) {
          assert.equal(this, client)
          assert.equal(returned, false)
          queries.push(sql)
          phases.push(sql)
          await control.beforeQuery?.(sql)
          let rows: unknown[] = []
          if (sql === 'SELECT dataset_name FROM durable_runtime.dataset_metadata') {
            rows = control.datasetRows ?? [{ dataset_name: 'synthetic-stop-dataset' }]
          } else if (sql.includes('FROM durable_runtime.execution_target_records')) {
            rows = row && values[0] === row.attempt_id && values[1] === row.pod_uid &&
              values[2] === row.incarnation && values[3] === row.execution_epoch ? [row] : []
          } else {
            assert.match(sql, /^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|COMMIT|ROLLBACK)$/)
          }
          return { rows, rowCount: rows.length }
        },
        release(destroy = false) {
          assert.equal(this, client)
          assert.equal(returned, false)
          returned = true
          checkedOut--
          releases.push(destroy)
          phases.push(destroy ? 'DESTROY' : 'RELEASE')
        }
      }
      // A transport shape for source fixtures, not a real PG client or authentication issuer.
      const typed = client as unknown as PoolClient
      clients.push(typed)
      return typed
    }
  }
  const tokenProvider = { async getAccessToken(signal: AbortSignal) {
    assert.equal(this, tokenProvider)
    assert.equal(checkedOut, 0)
    phases.push('AUDIT_TOKEN')
    return control.token ? control.token(signal) : 'synthetic-stop-token'
  } }
  const configuration: { -readonly [K in keyof ComputeStopEvidenceConfiguration]: ComputeStopEvidenceConfiguration[K] } = {
    // Fixture SQL transport only; production callers must supply a server-owned Pool.
    pool: pool as unknown as Pool, datasetName: 'synthetic-stop-dataset',
    clusterIdentityRef: 'synthetic-stop-cluster', namespace: 'synthetic-agents',
    projectId: fixtureInput.scope.projectId, projectNumber: fixtureInput.scope.projectNumber,
    timeoutMs: 1000, audit: { tokenProvider, https: wire.holder }
  }
  return { configuration, pool, wire, row, clients, queries, releases, phases, tokenProvider,
    connections: () => connections, checkedOut: () => checkedOut }
}
