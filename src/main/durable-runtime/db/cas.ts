import type {
  AttemptId,
  ControllerTerm,
  ExecutionEpoch,
  GrantId,
  IntentRevision,
  OperationId,
  RowRevision,
  RuntimeUnitId,
  SessionFence,
  SessionId,
  StepRevision,
  StorageBindingId,
  StorageEpoch,
} from "../../../shared/durable-runtime/identity.ts";
import { DurableDatabaseError, type DurableTransaction } from "./connection.ts";
import { lockAggregates, type StorageDomainKey } from "./locks.ts";

async function oneChange(
  tx: DurableTransaction,
  sql: string,
  values: readonly unknown[],
): Promise<void> {
  const result = await tx.query(sql, values);
  if (result.rowCount !== 1) {
    throw new DurableDatabaseError("STALE_CAS");
  }
}

export async function advanceSessionFence(
  tx: DurableTransaction,
  args: {
    sessionId: SessionId;
    expectedFence: SessionFence;
    expectedRevision: RowRevision<"session">;
    nextFence: SessionFence;
  },
): Promise<void> {
  await oneChange(
    tx,
    `UPDATE durable_runtime.sessions SET session_fence=$4,revision=revision+1
    WHERE id=$1 AND session_fence=$2 AND revision=$3 AND $4::bigint>session_fence`,
    [args.sessionId, args.expectedFence, args.expectedRevision, args.nextFence],
  );
}

export async function claimExecutionAttempt(
  tx: DurableTransaction,
  args: {
    runtimeUnitId: RuntimeUnitId;
    expectedEpoch: ExecutionEpoch;
    expectedIntentRevision: IntentRevision;
    expectedRevision: RowRevision<"runtime-unit">;
    nextEpoch: ExecutionEpoch;
    attemptId: AttemptId;
  },
): Promise<void> {
  await oneChange(
    tx,
    `UPDATE durable_runtime.runtime_units SET execution_epoch=$5,active_attempt_id=$6,revision=revision+1
    WHERE id=$1 AND execution_epoch=$2 AND intent_revision=$3 AND revision=$4 AND $5::bigint>execution_epoch
    AND EXISTS(SELECT 1 FROM durable_runtime.attempts a WHERE a.id=$6 AND a.runtime_unit_id=$1 AND a.execution_epoch=$5)`,
    [
      args.runtimeUnitId,
      args.expectedEpoch,
      args.expectedIntentRevision,
      args.expectedRevision,
      args.nextEpoch,
      args.attemptId,
    ],
  );
}

export async function renewControllerLease(
  tx: DurableTransaction,
  args: {
    scope: string;
    owner: string;
    expectedTerm: ControllerTerm;
    expectedRevision: RowRevision<"controller">;
    expiresAt: Date;
  },
): Promise<void> {
  await oneChange(
    tx,
    `UPDATE durable_runtime.controller_leases SET expires_at=$5,revision=revision+1
    WHERE scope=$1 AND owner=$2 AND term=$3 AND revision=$4 AND expires_at>clock_timestamp()
    AND $5::timestamptz>clock_timestamp()`,
    [args.scope, args.owner, args.expectedTerm, args.expectedRevision, args.expiresAt],
  );
}

export async function advanceOperationStep(
  tx: DurableTransaction,
  args: {
    operationId: OperationId;
    runtimeUnitId: RuntimeUnitId;
    expectedIntentRevision: IntentRevision;
    executionEpoch: ExecutionEpoch;
    controllerScope: string;
    controllerTerm: ControllerTerm;
    controllerOwner: string;
    expectedUnitRevision: RowRevision<"runtime-unit">;
    expectedStepRevision: StepRevision;
    expectedRevision: RowRevision<"operation">;
    expectedPodUid: string | null;
    nextStep: string;
  },
): Promise<void> {
  await oneChange(
    tx,
    `UPDATE durable_runtime.operations o SET step=$10,step_revision=o.step_revision+1,revision=o.revision+1
    FROM durable_runtime.runtime_units u, durable_runtime.controller_leases c
    WHERE o.id=$1 AND o.runtime_unit_id=$2 AND u.id=o.runtime_unit_id
    AND o.intent_revision=$3 AND u.intent_revision=$3 AND o.execution_epoch=$4 AND u.execution_epoch=$4
    AND o.controller_scope=$5 AND c.scope=$5 AND o.controller_term=$6 AND c.term=$6 AND c.owner=$11 AND c.expires_at>clock_timestamp()
    AND o.step_revision=$7 AND o.revision=$8 AND o.expected_pod_uid IS NOT DISTINCT FROM $9::text
    AND u.revision=$12 AND ($9::text IS NULL OR EXISTS(SELECT 1 FROM durable_runtime.attempts a WHERE a.id=u.active_attempt_id AND a.pod_uid=$9))`,
    [
      args.operationId,
      args.runtimeUnitId,
      args.expectedIntentRevision,
      args.executionEpoch,
      args.controllerScope,
      args.controllerTerm,
      args.expectedStepRevision,
      args.expectedRevision,
      args.expectedPodUid,
      args.nextStep,
      args.controllerOwner,
      args.expectedUnitRevision,
    ],
  );
}

export async function advanceStorageEpoch(
  tx: DurableTransaction,
  args: {
    storageBindingId: StorageBindingId;
    domain: StorageDomainKey;
    expectedEpoch: StorageEpoch;
    expectedRevision: RowRevision<"storage-binding">;
    nextEpoch: StorageEpoch;
  },
): Promise<void> {
  await lockAggregates(tx, { storageDomains: [args.domain] });
  await oneChange(
    tx,
    `UPDATE durable_runtime.storage_bindings SET epoch=$6,revision=revision+1
    WHERE id=$1 AND backend_id=$2 AND export_id=$3 AND epoch=$4 AND revision=$5 AND $6::bigint>epoch`,
    [
      args.storageBindingId,
      args.domain.backendId,
      args.domain.exportId,
      args.expectedEpoch,
      args.expectedRevision,
      args.nextEpoch,
    ],
  );
}

export async function revokeExecutionGrant(
  tx: DurableTransaction,
  args: {
    grantId: GrantId;
    runtimeUnitId: RuntimeUnitId;
    attemptId: AttemptId;
    executionEpoch: ExecutionEpoch;
    expectedRevision: RowRevision<"execution-grant">;
    stoppedProofRef: string;
  },
): Promise<void> {
  await oneChange(
    tx,
    `UPDATE durable_runtime.execution_grants SET state='REVOKED',revoked_at=clock_timestamp(),stopped_proof_ref=$6,revision=revision+1
    WHERE id=$1 AND runtime_unit_id=$2 AND attempt_id=$3 AND execution_epoch=$4 AND revision=$5 AND state='REVOKING' AND nullif($6::text,'') IS NOT NULL`,
    [
      args.grantId,
      args.runtimeUnitId,
      args.attemptId,
      args.executionEpoch,
      args.expectedRevision,
      args.stoppedProofRef,
    ],
  );
}
