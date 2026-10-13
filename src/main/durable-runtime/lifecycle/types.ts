import type { Pool } from 'pg'
import type { JsonValue, MutationOutcome } from '../db/atomic.ts'
import type { OperationRow, RuntimeUnitRow } from '../db/rows.ts'
import type {
  ControllerTerm, OperationId, RowRevision, RuntimeUnitId, SessionId, IntentRevision
} from '../../../shared/durable-runtime/identity.ts'

declare const intentAuthority: unique symbol
// Supplied by authenticated Catalog/internal scope. No string-to-authority factory.
export type UnitIntentAuthority = {
  readonly [intentAuthority]: true
  readonly principalId: string
  readonly runtimeUnitId: RuntimeUnitId
  readonly scope: string
}
export type LifecyclePolicy = {
  readonly operationDeadlineMs: number
  readonly idleDurationMs: number | null
}
export type LifecycleOperation = Readonly<OperationRow> & {
  readonly kind: string
  readonly controller_scope: string
  readonly expected_pod_uid: string | null
  readonly external_resource_name: string | null
  readonly deadline_at: Date | null
  readonly retry_at: Date | null
  readonly result: JsonValue | null
}
export type UnitIntentRequest = {
  readonly authority: UnitIntentAuthority
  readonly operationKey: string
  readonly desired: 'RUNNING' | 'DELETED'
  readonly expectedRevision: RowRevision<'runtime-unit'>
  readonly expectedIntentRevision: IntentRevision
  readonly policy: LifecyclePolicy
}
export type IntentRecorded = {
  readonly runtimeUnitId: RuntimeUnitId
  readonly desired: RuntimeUnitRow['desired_mode']
  readonly intentRevision: IntentRevision
  readonly revision: RowRevision<'runtime-unit'>
  readonly operationId: OperationId
  readonly sharedIntent: boolean
  readonly executionDisposition: 'QUEUED' | 'BLOCKED_BY_UNRESOLVED_COMMAND'
}
export type MemberProjection = {
  readonly sessionId: SessionId
  readonly lifecycle: string
  readonly pendingCount: string
  readonly inFlightCount: string
  readonly historicalUnknownCount: string
}
export type UnitProjection = {
  readonly unit: Readonly<RuntimeUnitRow> & {
    readonly last_work_event_at: string | null
    readonly idle_due_at: string | null
    readonly observation_lost_at: string | null
    readonly reconcile_due_at: string | null
  }
  readonly observed: 'ABSENT' | 'unverifiable' | 'PRESENT_UNVERIFIED'
  readonly attempt: { readonly id: string; readonly podUid: string | null; readonly status: string } | null
  readonly members: readonly MemberProjection[]
  readonly operations: readonly (Omit<LifecycleOperation, 'deadline_at' | 'retry_at'> & {
    readonly deadline_at: string | null
    readonly retry_at: string | null
  })[]
}
export type IntentMutation = MutationOutcome
export type LifecyclePool = Pool
export type ControllerAuthority = {
  readonly scope: string
  readonly owner: string
  readonly term: ControllerTerm
}
