import type { DurableTransaction } from '../db/connection.ts'
import type { GatewayContext } from './gateway/types.ts'
import type { createKubernetesPodAuthenticator } from './kubernetes-pod-auth.ts'
import type { KubernetesPodAuthExpected } from './kubernetes-pod-auth-types.ts'
import type { createComputeCreationIdentityClient } from './compute-creation-identity.ts'
import type { ExecutionTargetRecord } from './execution-target-records.ts'

export type ExecutionTargetCompositionConfiguration = Readonly<{
  clusterIdentityRef: string
  namespace: string
  dataset: string
  audience: string
  projectId: string
  projectNumber: string
  timeoutMs: number
  podAuthenticator: ReturnType<typeof createKubernetesPodAuthenticator>
  /** Explicit approved node-identity mode never manufactures a creation receipt. */
  creationObserver: ReturnType<typeof createComputeCreationIdentityClient> | 'AUTHENTICATED_KUBERNETES_NODE'
}>

export type ExecutionTargetPrepareInput = Readonly<{
  attemptId: string
  incarnation: string
  expected: KubernetesPodAuthExpected
  podBearer: string
  creationStartTime: string
  creationEndTime: string
}>

declare const preparedHandleBrand: unique symbol
/** Membership in the issuing service's private WeakMap is checked at runtime. */
export type PreparedExecutionTarget = Readonly<{
  kind: 'PREPARED_EXECUTION_TARGET'
  [preparedHandleBrand]: true
}>

export type TransactionLocalExecutionTarget = Readonly<{
  status: 'TRANSACTION_LOCAL'
  record: ExecutionTargetRecord
}>

export type ExecutionTargetComposition = Readonly<{
  prepare(input: ExecutionTargetPrepareInput, signal: AbortSignal): Promise<PreparedExecutionTarget>
  record(tx: DurableTransaction, context: GatewayContext,
    prepared: PreparedExecutionTarget): Promise<TransactionLocalExecutionTarget>
}>

export type ExecutionTargetCompositionErrorCode = 'CONFIG_INVALID' | 'INPUT_INVALID' |
  'POD_OBSERVATION_INVALID' | 'NODE_IDENTITY_INVALID' | 'CREATION_NOT_CONFIRMED' |
  'OBSERVER_FAILED' | 'ABORTED' | 'TIMEOUT' | 'PREPARED_INVALID' | 'CONTEXT_INVALID' | 'CONTEXT_SCOPE'

export class ExecutionTargetCompositionError extends Error {
  readonly code: ExecutionTargetCompositionErrorCode
  constructor(code: ExecutionTargetCompositionErrorCode) {
    super(`EXECUTION_TARGET_COMPOSITION_${code}`)
    this.name = 'ExecutionTargetCompositionError'
    this.code = code
  }
}
