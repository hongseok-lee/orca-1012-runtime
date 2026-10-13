import type {
  ControllerTerm, ExecutionEpoch, IntentRevision, LogicalId, OperationId,
  RowRevision, RuntimeUnitId, StepRevision,
} from '../../../../shared/durable-runtime/identity.ts';
import type { CommandEnvelope, ExternalCommandIdentity, RuntimeCommandName, SettledCommandReceipt } from '../command-types.ts';
import type { EvidenceRef, PayloadHash, PodUid, RuntimeReference } from '../runtime-evidence.ts';

declare const controllerIdentityBrand: unique symbol;
declare const reconciliationBrand: unique symbol;

// Supplied by a future authenticated internal boundary. No string-to-verified
// identity factory, public handler, or authentication bypass is provided.
export interface VerifiedControllerIdentity {
  readonly [controllerIdentityBrand]: true;
  readonly scope: string;
  readonly owner: string;
  readonly term: ControllerTerm;
}
export type CommandId = LogicalId<'runtime-command'>;
export type ExecutionToken = LogicalId<'runtime-command-execution'>;
export type ExecutorId = RuntimeReference<'gateway-executor'>;
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
  readonly [key: string]: JsonValue;
};
export type CommandState = 'ACCEPTED' | 'EXECUTING' | 'UNKNOWN' | 'RESOLVED' | 'REFUSED';

export interface GatewayContext {
  readonly runtimeUnitId: RuntimeUnitId;
  readonly operationId: OperationId;
  readonly controller: VerifiedControllerIdentity;
}
// Read projection of the owner-provided SQL contract. Stored references are not
// authenticated workload identity or provider/compute/storage proof objects.
export interface CommandRow {
  readonly id: CommandId;
  readonly operation_id: OperationId;
  readonly runtime_unit_id: RuntimeUnitId;
  readonly command_name: RuntimeCommandName;
  readonly original_controller_term: ControllerTerm;
  readonly step_revision: StepRevision;
  readonly pod_target: CommandEnvelope['podTarget'];
  readonly expected_pod_uid: PodUid | null;
  readonly execution_epoch: ExecutionEpoch;
  readonly intent_revision: IntentRevision;
  readonly input_hash: PayloadHash;
  readonly input: JsonValue;
  readonly state: CommandState;
  readonly owner_controller_term: ControllerTerm;
  readonly executor_id: ExecutorId | null;
  readonly execution_token: ExecutionToken | null;
  readonly revision: RowRevision<'runtime-command'>;
  readonly result: JsonValue | null;
  readonly refusal_code: string | null;
  readonly evidence_refs: readonly EvidenceRef[];
}
export interface SubmitCommand {
  readonly command: RuntimeCommandName;
  readonly envelope: CommandEnvelope;
  readonly inputHash: PayloadHash;
  readonly input: JsonValue;
  readonly predecessor: { readonly kind: 'NONE' } | {
    readonly kind: 'RECONCILED';
    readonly receipt: SettledCommandReceipt<JsonValue>;
  };
}
export type SubmitResult =
  | { readonly disposition: 'ACCEPTED' | 'REPLAYED'; readonly command: CommandRow }
  | { readonly disposition: 'BLOCKED_BY_UNRESOLVED_COMMAND'; readonly command: CommandRow; readonly newCommandAccepted: false };
export interface CommandClaim {
  readonly visibility: 'TRANSACTION_LOCAL';
  readonly commandId: CommandId;
  readonly identity: ExternalCommandIdentity;
  readonly executorId: ExecutorId;
  readonly executionToken: ExecutionToken;
  readonly controllerTerm: ControllerTerm;
}
export type ClaimResult =
  | { readonly disposition: 'CLAIMED'; readonly claim: CommandClaim; readonly command: CommandRow }
  | { readonly disposition: 'NOT_CLAIMABLE'; readonly command: CommandRow };
export type TerminalOutcome =
  | { readonly state: 'RESOLVED'; readonly result: JsonValue; readonly evidenceRefs: readonly EvidenceRef[] }
  | { readonly state: 'REFUSED'; readonly refusalCode: string; readonly evidenceRefs: readonly EvidenceRef[] };

// Only future method-specific evidence verification may produce this value.
// Evidence is bound to the original claim and target, not a newer attempt.
export interface VerifiedCommandReconciliation {
  readonly [reconciliationBrand]: true;
  readonly commandId: CommandId;
  readonly executionToken: ExecutionToken;
  readonly original: ExternalCommandIdentity;
  readonly executionEndedEvidenceRef: EvidenceRef;
  readonly outcome: TerminalOutcome;
}
