import type {
  OperationId,
  RuntimeUnitId,
  SessionId,
} from "../../../shared/durable-runtime/identity.ts";
import { DurableDatabaseError, type DurableTransaction } from "./connection.ts";

export type StorageDomainKey = {
  backendId: string;
  exportId: string;
};
export type AggregateLocks = {
  sessionIds?: readonly SessionId[];
  runtimeUnitIds?: readonly RuntimeUnitId[];
  storageDomains?: readonly StorageDomainKey[];
  operationIds?: readonly OperationId[];
};

async function lockRows(
  tx: DurableTransaction,
  rank: number,
  table: string,
  ids: readonly string[],
): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    tx.advanceLock(rank, id);
    const result = await tx.query(
      `SELECT id FROM durable_runtime.${table} WHERE id=$1 FOR UPDATE`,
      [id],
    );
    if (result.rowCount !== 1) {
      throw new DurableDatabaseError("LOCK_TARGET_MISSING");
    }
  }
}

// Sessions -> Runtime Units -> storage domains -> operations, each lexically ordered.
export async function lockAggregates(tx: DurableTransaction, locks: AggregateLocks): Promise<void> {
  await lockRows(tx, 1, "sessions", locks.sessionIds ?? []);
  await lockRows(tx, 2, "runtime_units", locks.runtimeUnitIds ?? []);
  const domains = new Map(
    (locks.storageDomains ?? []).map((domain) => [
      JSON.stringify([domain.backendId, domain.exportId]),
      domain,
    ]),
  );
  for (const [key, domain] of [...domains].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    tx.advanceLock(3, key);
    const result = await tx.query(
      "SELECT backend_id FROM durable_runtime.storage_domains WHERE backend_id=$1 AND export_id=$2 FOR UPDATE",
      [domain.backendId, domain.exportId],
    );
    if (result.rowCount !== 1) {
      throw new DurableDatabaseError("LOCK_TARGET_MISSING");
    }
  }
  await lockRows(tx, 4, "operations", locks.operationIds ?? []);
}
