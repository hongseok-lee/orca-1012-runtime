import type { ComputeCreationIdentityInput } from './compute-creation-identity-types.ts'

export const creationInput: ComputeCreationIdentityInput = {
  scope: {
    projectId: 'creation-fixture-project', projectNumber: '123456789012',
    zone: 'asia-northeast3-a', instanceName: 'fixture-created-node',
    numericInstanceId: '18446744073709551615'
  },
  startTime: '2026-10-13T10:40:00.000000000Z',
  endTime: '2026-10-13T10:45:00.000000000Z'
}

export const creationSentinel = 'SYNTHETIC_CREATION_PRIVATE_FIELD_NOT_EVIDENCE'

export type CreationFixtureEntry = {
  insertId: string
  timestamp: string
  logName: string
  resource: { type: string; labels?: Record<string, unknown> }
  operation: { id: string; producer: string; first?: unknown; last?: unknown }
  protoPayload: {
    '@type'?: string
    serviceName: string
    methodName: string
    resourceName: string
    status?: unknown
    response?: Record<string, unknown> | null
    authenticationInfo: { principalEmail: string }
  }
}

/** Generalized observed shape: first response, final status {}, final response absent. */
export function creationEntries(): [CreationFixtureEntry, CreationFixtureEntry] {
  const scope = creationInput.scope, operationId = 'operation-creation-fixture'
  const common = {
    logName: `projects/${scope.projectId}/logs/cloudaudit.googleapis.com%2Factivity`,
    resource: { type: 'gce_instance', labels: {
      project_id: scope.projectId, zone: scope.zone, instance_id: scope.numericInstanceId
    } },
    protoPayload: {
      '@type': 'type.googleapis.com/google.cloud.audit.AuditLog',
      serviceName: 'compute.googleapis.com', methodName: 'v1.compute.instances.insert',
      resourceName: `projects/${scope.projectNumber}/zones/${scope.zone}/instances/${scope.instanceName}`,
      status: {}, authenticationInfo: { principalEmail: creationSentinel }
    }
  }
  return [
    {
      ...structuredClone(common), insertId: 'creation-first',
      timestamp: '2026-10-13T10:41:20.538047001Z',
      operation: { id: operationId, producer: 'compute.googleapis.com', first: true },
      protoPayload: { ...structuredClone(common.protoPayload), response: {
        name: operationId, id: '9007199254740997', operationType: 'insert',
        targetId: scope.numericInstanceId,
        targetLink: `https://www.googleapis.com/compute/v1/projects/${scope.projectId}/zones/${scope.zone}/instances/${scope.instanceName}`,
        zone: `https://www.googleapis.com/compute/v1/projects/${scope.projectId}/zones/${scope.zone}`,
        status: 'RUNNING', privateField: creationSentinel
      } }
    },
    {
      ...structuredClone(common), insertId: 'creation-last',
      timestamp: '2026-10-13T10:41:28.689939001Z',
      operation: { id: operationId, producer: 'compute.googleapis.com', last: true }
    }
  ]
}
