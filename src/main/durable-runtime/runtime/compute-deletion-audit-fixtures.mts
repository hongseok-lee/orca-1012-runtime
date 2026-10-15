import type { ComputeDeletionAuditInput } from './compute-deletion-audit-types.ts'

export const fixtureInput: ComputeDeletionAuditInput = {
  scope: {
    projectId: 'audit-fixture-project', projectNumber: '123456789012',
    zone: 'asia-northeast3-a', instanceName: 'fixture-owned-node',
    numericInstanceId: '1143681254863137001'
  },
  startTime: '2026-10-14T11:30:00.000000000Z',
  endTime: '2026-10-14T11:40:00.000000000Z'
}
export const privateSentinel = 'ADVERSARIAL_PRIVATE_SENTINEL_DO_NOT_RETURN'

/** Generalized G04 field shapes; no private identity, principal, token or original log is copied. */
export type AuditFixtureEntry = {
  insertId: string
  timestamp: string
  logName: string
  resource: { type: string; labels: { project_id: string; zone: string; instance_id: string } }
  operation: { id: string; producer: string; first: boolean; last: boolean }
  protoPayload: {
    '@type': string
    serviceName: string
    methodName: string
    resourceName: string
    status: Record<string, unknown>
    authenticationInfo: { principalEmail: string }
    request: { credential: string }
    response?: {
      name: string; id: string; operationType: string; targetId: string
      targetLink: string; zone: string; authenticationInfo: { token: string }
    }
  }
}

export function deletionEntries(): [AuditFixtureEntry, AuditFixtureEntry] {
  const s = fixtureInput.scope
  const operation = 'operation-123456789-fixture'
  const common = {
    logName: `projects/${s.projectId}/logs/cloudaudit.googleapis.com%2Factivity`,
    resource: { type: 'gce_instance', labels: {
      project_id: s.projectId, zone: s.zone, instance_id: s.numericInstanceId
    } },
    protoPayload: {
      '@type': 'type.googleapis.com/google.cloud.audit.AuditLog',
      serviceName: 'compute.googleapis.com', methodName: 'v1.compute.instances.delete',
      resourceName: `projects/${s.projectNumber}/zones/${s.zone}/instances/${s.instanceName}`,
      status: {} as Record<string, unknown>,
      authenticationInfo: { principalEmail: privateSentinel },
      request: { credential: privateSentinel }
    }
  }
  return [
    {
      ...structuredClone(common), insertId: 'fixture-first',
      timestamp: '2026-10-14T11:33:41.188288001Z',
      operation: { id: operation, producer: 'compute.googleapis.com', first: true, last: false },
      protoPayload: { ...structuredClone(common.protoPayload), response: {
        name: operation, id: '999999999', operationType: 'delete',
        targetId: s.numericInstanceId,
        targetLink: `https://www.googleapis.com/compute/v1/projects/${s.projectId}/zones/${s.zone}/instances/${s.instanceName}`,
        zone: `https://www.googleapis.com/compute/v1/projects/${s.projectId}/zones/${s.zone}`,
        authenticationInfo: { token: privateSentinel }
      } }
    },
    {
      ...structuredClone(common), insertId: 'fixture-last',
      timestamp: '2026-10-14T11:34:20.377841001Z',
      operation: { id: operation, producer: 'compute.googleapis.com', first: false, last: true }
    }
  ]
}
