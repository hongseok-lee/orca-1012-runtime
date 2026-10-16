import type { Pool } from 'pg'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { runDurableTransaction } from '../db/connection.ts'
import { createAgentPodPlanner, type TrustedAgentPodRequest } from './agent-pod-plan.ts'
import { recordAgentPodPlan } from './agent-pod-plan-records.ts'
import type { GatewayContext } from './gateway/types.ts'

/** Internal trusted-server planning only. A committed record still grants no Pod or storage execution permission. */
export function createAgentPodPlanPersistence(pool: Pool, deploymentPolicy: unknown) {
  const planner = createAgentPodPlanner(deploymentPolicy)
  return Object.freeze({ record(context: GatewayContext, request: TrustedAgentPodRequest) {
    // The planner captures policy/request synchronously. Keep the existing controller brand and original Pool receiver.
    const captured = Object.freeze({ runtimeUnitId: logicalId('runtime-unit', context.runtimeUnitId),
      operationId: logicalId('operation', context.operationId),
      controller: Object.freeze({ ...context.controller, term: counter('controller-term', context.controller.term) }) })
    const plan = planner.plan(request)
    // Return the engine's original settlement/cleanup outcome, including an unconfirmed COMMIT.
    return runDurableTransaction(pool, tx => recordAgentPodPlan(tx, captured, plan))
  } })
}
