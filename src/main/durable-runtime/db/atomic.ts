import { performance } from "node:perf_hooks";
import type { Pool, PoolClient } from "pg";
import { DurableTransaction, DurableDatabaseError, safeDatabaseError } from "./connection.ts";
import { lockAggregates, type AggregateLocks } from "./locks.ts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
// Principal/scope are supplied only by the authenticated and authorized domain.
// Receipt replay must be authorized too; knowing an ID/key alone is insufficient.
export type ReceiptKey = {
  principalId: string;
  sessionScope: string;
  method: string;
  operationKey: string;
};
export type ReceiptIdentity = { key: ReceiptKey; payloadHash: string };
export type ReceiptRecord = ReceiptIdentity & {
  response: JsonValue;
  recordedAt: Date;
  intakeAt: Date | null;
};
export type MutationOutcome =
  | {
      status: "COMMITTED" | "REPLAYED";
      receipt: ReceiptRecord;
      commitObservedAt: Date;
      transactionDurationMs: number;
    }
  | { status: "UNCERTAIN"; identity: ReceiptIdentity; transactionDurationMs: number };
export type ReceiptResolution =
  | { status: "FOUND"; receipt: ReceiptRecord }
  | { status: "NOT_FOUND"; identity: ReceiptIdentity }
  | { status: "UNAVAILABLE"; identity: ReceiptIdentity };

function values(identity: ReceiptIdentity): string[] {
  const { key, payloadHash } = identity;
  const result = [key.principalId, key.sessionScope, key.method, key.operationKey];
  if (
    result.some((value) => typeof value !== "string" || !value) ||
    !/^[0-9a-f]{64}$/.test(payloadHash)
  ) {
    throw new DurableDatabaseError("RECEIPT_INPUT");
  }
  return result;
}
async function readReceipt(
  tx: DurableTransaction,
  identity: ReceiptIdentity,
): Promise<ReceiptRecord | null> {
  const result = await tx.query<{
    payload_hash: string;
    response: JsonValue;
    committed_at: Date;
    intake_at: Date | null;
  }>(
    "SELECT payload_hash,response,committed_at,intake_at FROM durable_runtime.rpc_receipts WHERE principal_id=$1 AND session_scope=$2 AND method=$3 AND operation_key=$4",
    values(identity),
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.payload_hash !== identity.payloadHash)
    throw new DurableDatabaseError("RECEIPT_PAYLOAD_CONFLICT");
  return {
    ...identity,
    response: row.response,
    recordedAt: row.committed_at,
    intakeAt: row.intake_at,
  };
}

// Does not mutate or automatically rerun the business callback. NOT_FOUND after
// an uncertain COMMIT is a point-in-time observation, never proof to create a new key.
export async function resolveReceipt(
  pool: Pool,
  identity: ReceiptIdentity,
): Promise<ReceiptResolution> {
  values(identity);
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    return { status: "UNAVAILABLE", identity };
  }
  const tx = new DurableTransaction(client);
  let destroy = false;
  try {
    const receipt = await readReceipt(tx, identity);
    return receipt ? { status: "FOUND", receipt } : { status: "NOT_FOUND", identity };
  } catch (error) {
    if (error instanceof DurableDatabaseError && error.code === "RECEIPT_PAYLOAD_CONFLICT")
      throw error;
    destroy = true;
    return { status: "UNAVAILABLE", identity };
  } finally {
    tx.close();
    client.release(destroy);
  }
}

export async function runDurableMutation(
  pool: Pool,
  request: ReceiptIdentity & { locks: AggregateLocks; intakeAt?: Date },
  body: (tx: DurableTransaction) => Promise<JsonValue>,
): Promise<MutationOutcome> {
  values(request);
  const start = performance.now();
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw safeDatabaseError(error);
  }
  const tx = new DurableTransaction(client);
  let committing = false,
    destroy = false,
    released = false;
  try {
    await tx.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    let receipt = await readReceipt(tx, request);
    if (!receipt) {
      await lockAggregates(tx, request.locks);
      receipt = await readReceipt(tx, request);
    }
    const replayed = !!receipt;
    if (!receipt) {
      const response = await body(tx);
      const stored = await tx.query<{ committed_at: Date; intake_at: Date | null }>(
        "INSERT INTO durable_runtime.rpc_receipts(principal_id,session_scope,method,operation_key,payload_hash,response,intake_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING committed_at,intake_at",
        [
          ...values(request),
          request.payloadHash,
          JSON.stringify(response),
          request.intakeAt ?? null,
        ],
      );
      receipt = {
        key: request.key,
        payloadHash: request.payloadHash,
        response,
        recordedAt: stored.rows[0].committed_at,
        intakeAt: stored.rows[0].intake_at,
      };
    }
    committing = true;
    const result = await tx.query("COMMIT");
    if (result.command !== "COMMIT") throw new DurableDatabaseError("TX_NOT_COMMITTED");
    return {
      status: replayed ? "REPLAYED" : "COMMITTED",
      receipt,
      commitObservedAt: new Date(),
      transactionDurationMs: performance.now() - start,
    };
  } catch (error) {
    const safe = safeDatabaseError(error);
    // Server constraint/serialization replies prove rejection; connection loss
    // while COMMIT is in flight does not prove either rollback or commit.
    const uncertain =
      committing &&
      !/^(?:23|40|25)[A-Z0-9]{3}$/.test(safe.code) &&
      safe.code !== "TX_NOT_COMMITTED";
    if (uncertain) destroy = true;
    try {
      await client.query("ROLLBACK");
    } catch {
      destroy = true;
    }
    if (uncertain)
      return {
        status: "UNCERTAIN",
        identity: { key: request.key, payloadHash: request.payloadHash },
        transactionDurationMs: performance.now() - start,
      };
    if (safe.code === "23505" || safe.code === "40001") {
      tx.close();
      client.release(destroy);
      released = true;
      const resolution = await resolveReceipt(pool, request);
      if (resolution.status === "FOUND")
        return {
          status: "REPLAYED",
          receipt: resolution.receipt,
          commitObservedAt: new Date(),
          transactionDurationMs: performance.now() - start,
        };
    }
    throw safe;
  } finally {
    tx.close();
    if (!released) client.release(destroy);
  }
}
