declare const identityBrand: unique symbol
declare const counterBrand: unique symbol

export type LogicalId<Kind extends string> = string & { readonly [identityBrand]: Kind }
export type WorkspaceId = LogicalId<'workspace'>
export type AgentId = LogicalId<'agent'>
export type SessionId = LogicalId<'session'>
export type TabId = LogicalId<'tab'>
export type RuntimeUnitId = LogicalId<'runtime-unit'>
export type AttemptId = LogicalId<'attempt'>
export type MessageId = LogicalId<'message'>
export type InputId = LogicalId<'input'>
export type DeliveryAttemptId = LogicalId<'delivery-attempt'>
export type OperationId = LogicalId<'operation'>
export type EventId = LogicalId<'event'>
export type ContextRecordId = LogicalId<'context-record'>
export type StorageBindingId = LogicalId<'storage-binding'>
export type SnapshotId = LogicalId<'snapshot'>
export type GrantId = LogicalId<'grant'>
export type ResourceProfileId = LogicalId<'resource-profile'>
export type IncidentId = LogicalId<'incident'>
export type RecoveryEpisodeId = LogicalId<'recovery-episode'>
export type NotificationId = LogicalId<'notification'>
export type ProducerId = LogicalId<'producer'>

// Decimal strings preserve PostgreSQL BIGINT precision at JSON/driver boundaries.
export type Counter<Kind extends string> = string & { readonly [counterBrand]: Kind }
export type SessionFence = Counter<'session-fence'>
export type ExecutionEpoch = Counter<'execution-epoch'>
export type ControllerTerm = Counter<'controller-term'>
export type StorageEpoch = Counter<'storage-epoch'>
export type RowRevision<Aggregate extends string> = Counter<`row:${Aggregate}`>
export type IntentRevision = Counter<'intent-revision'>
export type StepRevision = Counter<'step-revision'>
export type ContextRevision = Counter<'context-revision'>
export type CancelRevision = Counter<'cancel-revision'>
export type MessageRevision = Counter<'message-revision'>
export type ProfileRevision = Counter<'profile-revision'>
export type Sequence<Stream extends string> = Counter<`sequence:${Stream}`>

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const decimalPattern = /^(0|[1-9][0-9]*)$/
const maximumBigint = 9223372036854775807n

export function logicalId<Kind extends string>(kind: Kind, value: string): LogicalId<Kind> {
  if (!kind || !uuidPattern.test(value)) throw new Error('Invalid durable logical identity')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Canonical UUID syntax checked above; kind supplies the nominal brand.
  return value as LogicalId<Kind>
}

export function counter<Kind extends string>(kind: Kind, value: string | bigint): Counter<Kind> {
  const decimal = typeof value === 'bigint' ? value.toString() : value
  if (!kind || !decimalPattern.test(decimal) || BigInt(decimal) > maximumBigint) {
    throw new Error('Invalid durable BIGINT counter')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Nonnegative signed BIGINT decimal range checked above; kind supplies the brand.
  return decimal as Counter<Kind>
}

export function incrementCounter<Kind extends string>(kind: Kind, value: Counter<Kind>): Counter<Kind> {
  return counter(kind, BigInt(value) + 1n)
}
