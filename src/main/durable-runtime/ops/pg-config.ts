import type { Pool } from 'pg'
import type { LifecyclePolicy } from '../lifecycle/types.ts'
import type { OpsServerScope } from './auth.ts'
import type { OpsActor } from './types.ts'
import { snapshotOpsActor } from './auth.ts'
import { OpsHttpError } from './errors.ts'
export type OpsPgConfig = Readonly<{
  pool: Pool
  scope: OpsServerScope
  streamId: string
  lifecyclePolicy: LifecyclePolicy
  controllerConnected: boolean
}>
export function snapshotOpsPgConfig(config: OpsPgConfig): OpsPgConfig {
  const scope = Object.freeze({ datasetName: config.scope.datasetName, namespaceId: config.scope.namespaceId,
    workspaceIds: Object.freeze([...config.scope.workspaceIds]) })
  if (!scope.datasetName || !scope.namespaceId || !config.streamId ||
    !Number.isSafeInteger(config.lifecyclePolicy.operationDeadlineMs) || config.lifecyclePolicy.operationDeadlineMs <= 0 ||
    (config.lifecyclePolicy.idleDurationMs !== null &&
      (!Number.isSafeInteger(config.lifecyclePolicy.idleDurationMs) || config.lifecyclePolicy.idleDurationMs <= 0))) {
    throw new OpsHttpError(503, 'invalid_configuration', 'The server operations configuration is unavailable.')
  }
  return Object.freeze({ pool: config.pool, scope, streamId: config.streamId,
    lifecyclePolicy: Object.freeze({ ...config.lifecyclePolicy }), controllerConnected: config.controllerConnected === true })
}
export function requireOpsActor(config: OpsPgConfig, value: OpsActor): OpsActor {
  const actor = snapshotOpsActor(value)
  if (actor.datasetName !== config.scope.datasetName || actor.namespaceId !== config.scope.namespaceId ||
    actor.workspaceIds.some(id => !config.scope.workspaceIds.includes(id))) {
    throw new OpsHttpError(403, 'forbidden', 'The authentication context is outside the configured namespace.')
  }
  return actor
}
