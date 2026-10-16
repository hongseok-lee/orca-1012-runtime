import type { AttemptId, ExecutionEpoch, IntentRevision, OperationId, RuntimeUnitId } from '../../../shared/durable-runtime/identity.ts'
import type { DurableTransaction } from './connection.ts'
import type { GatewayContext } from '../runtime/gateway/types.ts'
import type { UnauthorizedAgentPodPlan } from '../runtime/agent-pod-plan.ts'

export type AgentPodPlanRecord = Readonly<{
  plan: UnauthorizedAgentPodPlan
  planDigest: string
  recordedAt: string
}>
/** Transaction-local result; only the caller's transaction engine confirms COMMIT. */
export type AgentPodPlanWriteResult = Readonly<{
  disposition: 'RECORDED' | 'REPLAYED'
  record: AgentPodPlanRecord
}>
export type RecordAgentPodPlan = (tx: DurableTransaction, context: GatewayContext,
  plan: UnauthorizedAgentPodPlan) => Promise<AgentPodPlanWriteResult>
export type ReadAgentPodPlan = (tx: DurableTransaction, operationId: OperationId) => Promise<AgentPodPlanRecord | null>

export type AgentPodPlanRow = {
  operation_id: OperationId; runtime_unit_id: RuntimeUnitId; dataset_name: string
  attempt_id: AttemptId; execution_epoch: ExecutionEpoch; intent_revision: IntentRevision
  namespace: string; resource_name: string; spec_hash: string; pod_spec_sha256: string
  plan_digest: string; plan: unknown; recorded_at: Date
}
