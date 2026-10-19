import type { LifecyclePolicy } from '../durable-runtime/lifecycle/types.ts'
import type { OrcadControllerConfig } from './orcad-controller-config.ts'
import { readPrivateOrcadControllerConfigBytes, parseUniqueOrcadControllerJson } from './orcad-controller-config.ts'
import { agentPodFields, agentPodInteger } from '../durable-runtime/runtime/agent-pod-policy.ts'
/** The existing managed-startup deployment policy owns every managed WAKE,
 * automatic or explicitly authenticated. Existing operations retain their dates. */
export function captureOrcadWakePolicy(value: unknown): LifecyclePolicy {
  const fields = agentPodFields(value, ['operationDeadlineMs', 'idleDurationMs'])
  const operationDeadlineMs = agentPodInteger(fields.get('operationDeadlineMs'))
  const idleDurationMs = fields.get('idleDurationMs') === null ? null : agentPodInteger(fields.get('idleDurationMs'))
  if (operationDeadlineMs < 1 || operationDeadlineMs > 2_147_483_647 || idleDurationMs !== null && idleDurationMs < 1) { throw new Error('CONTROLLER_WAKE_POLICY') }
  return Object.freeze({ operationDeadlineMs, idleDurationMs })
}
export function readOrcadManagedWakePolicy(config: OrcadControllerConfig | null): LifecyclePolicy | undefined {
  if (!config?.rewake) { return undefined }
  const value = parseUniqueOrcadControllerJson(readPrivateOrcadControllerConfigBytes(config.rewake.configFile).toString('utf8'))
  return captureOrcadWakePolicy(Reflect.get(value as object, 'lifecyclePolicy'))
}
