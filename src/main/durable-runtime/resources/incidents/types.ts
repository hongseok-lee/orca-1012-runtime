import type { IncidentId } from '../../../../shared/durable-runtime/identity.ts'
import type { FailureClass } from '../evidence/types.ts'

export type RecordFailureResult = {
  readonly status: 'RECORDED' | 'REPLAYED' | 'OBSERVATION_ONLY'
  readonly observationId: string
  readonly incidentId: IncidentId | null
  readonly currentExecution: boolean
  readonly state: 'COLLECTING' | 'CLASSIFIED' | 'BLOCKED' | null
  readonly classification: FailureClass | null
  readonly revision: string | null
  readonly reason: string | null
}
