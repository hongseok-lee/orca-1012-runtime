import { randomUUID } from 'node:crypto'
import { counter, type ControllerTerm, type RowRevision } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError } from '../db/connection.ts'

export const CONTROLLER_SCOPE = 'orca-serve:orca-1012-dev-v1' as const
export const CONTROLLER_DATASET = 'orca-1012-dev-v1' as const

/** Construction represents a new process, never restoration of an old owner. */
export class ControllerInstance {
  readonly scope: typeof CONTROLLER_SCOPE
  readonly processId: string
  readonly owner: string

  constructor(scope: typeof CONTROLLER_SCOPE) {
    if (scope !== CONTROLLER_SCOPE) {throw new DurableDatabaseError('CONTROLLER_SCOPE')}
    this.scope = scope
    this.processId = randomUUID()
    this.owner = `${scope}:${this.processId}`
    Object.freeze(this)
  }
}

export type LeasePolicy = { readonly revision: string; readonly durationMs: number }
export type ExpectedLease = { readonly term: ControllerTerm; readonly revision: RowRevision<'controller'> }
export type LeaseIdentity = ExpectedLease & { readonly scope: string; readonly owner: string }
export type LeaseRecord = LeaseIdentity & { readonly expiresAt: string }

export function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {throw new DurableDatabaseError('CONTROLLER_BUDGET')}
  return value
}

export function snapshotPolicy(caller: LeasePolicy): LeasePolicy {
  const policy = Object.freeze({ revision: caller.revision, durationMs: caller.durationMs })
  if (typeof policy.revision !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(policy.revision)) {
    throw new DurableDatabaseError('CONTROLLER_POLICY')
  }
  positiveInteger(policy.durationMs)
  return policy
}

export function snapshotInstance(caller: ControllerInstance): Readonly<Pick<ControllerInstance, 'scope' | 'owner'>> {
  const instance = Object.freeze({ scope: caller.scope, owner: caller.owner })
  if (!(caller instanceof ControllerInstance) || instance.scope !== CONTROLLER_SCOPE ||
      instance.owner !== `${instance.scope}:${caller.processId}` ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(caller.processId)) {
    throw new DurableDatabaseError('CONTROLLER_INSTANCE')
  }
  return instance
}

export function snapshotExpected(caller: ExpectedLease): ExpectedLease {
  return Object.freeze({ term: counter('controller-term', caller.term),
    revision: counter('row:controller', caller.revision) })
}

export function snapshotIdentity(caller: LeaseIdentity): LeaseIdentity {
  const { scope, owner } = caller
  if (scope !== CONTROLLER_SCOPE || typeof owner !== 'string' || !owner.startsWith(`${scope}:`)) {
    throw new DurableDatabaseError('CONTROLLER_IDENTITY')
  }
  return Object.freeze({ scope, owner, ...snapshotExpected(caller) })
}
