import pg from "pg";
import type { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from "pg";

export class DurableDatabaseError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Durable database operation failed (${code})`);
    this.name = "DurableDatabaseError";
    this.code = code;
  }
}

export function safeDatabaseError(error: unknown): DurableDatabaseError {
  if (error instanceof DurableDatabaseError) {
    return error;
  }
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  return new DurableDatabaseError(
    typeof code === "string" && /^[A-Z0-9]{5}$/.test(code) ? code : "DB_FAILURE",
  );
}

export function createDurablePool(
  config: PoolConfig,
  onError?: (error: DurableDatabaseError) => void,
): Pool {
  const pool = new pg.Pool({
    ...config,
    types: {
      getTypeParser(oid, format) {
        if (oid === 20 && format !== "binary") {
          return (value: string) => value;
        }
        return pg.types.getTypeParser(oid, format);
      },
    },
  });
  // Active clients can emit a transport error while no query is in flight.
  // Attach a sanitized listener before checkout; queries still reject and a
  // failed rollback/uncertain COMMIT destroys the connection.
  pool.on("connect", (client) =>
    client.on("error", (error) => onError?.(safeDatabaseError(error))),
  );
  pool.on("error", (error) => onError?.(safeDatabaseError(error)));
  return pool;
}

export class DurableTransaction {
  private readonly client: PoolClient;
  private active = true;
  private lockRank = 0;
  private lastKey = "";
  private readonly heldLocks = new Map<number, Set<string>>();

  constructor(client: PoolClient) {
    this.client = client;
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    if (!this.active) {
      throw new DurableDatabaseError("TX_CLOSED");
    }
    try {
      return await this.client.query<Row>(sql, [...values]);
    } catch (error) {
      throw safeDatabaseError(error);
    }
  }

  isLockHeld(rank: number, key: string): boolean {
    if (!this.active) {
      throw new DurableDatabaseError("TX_CLOSED");
    }
    return this.heldLocks.get(rank)?.has(key) ?? false;
  }

  // The lock helper calls this only after SQL succeeded and found its row.
  markLockAcquired(rank: number, key: string): void {
    if (!this.active) {
      throw new DurableDatabaseError("TX_CLOSED");
    }
    const keys = this.heldLocks.get(rank) ?? new Set<string>();
    keys.add(key);
    this.heldLocks.set(rank, keys);
  }

  advanceLock(rank: number, key: string): void {
    if (this.isLockHeld(rank, key)) {
      return;
    }
    if (rank < this.lockRank || (rank === this.lockRank && key < this.lastKey)) {
      throw new DurableDatabaseError("LOCK_ORDER");
    }
    this.lockRank = rank;
    this.lastKey = key;
  }

  close(): void {
    this.active = false;
  }
}

export type DurableTransactionFailure = Readonly<{
  ok: false;
  settlement: "NOT_STARTED" | "ROLLED_BACK" | "UNCONFIRMED";
  commitOutcome: "NOT_ATTEMPTED" | "UNKNOWN" | "NOT_COMMITTED";
  error: DurableDatabaseError;
  cleanupFailed: boolean;
}>;
export type DurableTransactionResult<T> = Readonly<{
  ok: true;
  settlement: "COMMITTED";
  commitOutcome: "ACKNOWLEDGED";
  value: T;
  cleanupFailed: boolean;
}> | DurableTransactionFailure;

function commandAcknowledged(result: unknown, command: string): boolean {
  return typeof result === "object" && result !== null && !Array.isArray(result) &&
    "command" in result && result.command === command;
}

// Trusted body callbacks must not end or replace the transaction boundary.
// SQL-only callback contract: external effects belong to a later durable operation.
export async function runDurableTransaction<T>(
  pool: Pool,
  body: (tx: DurableTransaction) => Promise<T>,
): Promise<DurableTransactionResult<T>> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    return Object.freeze({ ok: false, settlement: "NOT_STARTED", commitOutcome: "NOT_ATTEMPTED",
      error: safeDatabaseError(error), cleanupFailed: false });
  }
  const tx = new DurableTransaction(client);
  let destroy = false, commitAttempted = false, cleanupFailed = false;
  let outcome: DurableTransactionResult<T>;
  try {
    const begun = await tx.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    if (!commandAcknowledged(begun, "BEGIN")) {
      throw new DurableDatabaseError("TX_BEGIN_UNCONFIRMED");
    }
    const value = await body(tx);
    commitAttempted = true;
    const committed = await tx.query("COMMIT");
    if (commandAcknowledged(committed, "ROLLBACK")) {
      outcome = { ok: false, settlement: "ROLLED_BACK", commitOutcome: "NOT_COMMITTED",
        error: new DurableDatabaseError("TX_NOT_COMMITTED"), cleanupFailed: false };
    } else {
      if (!commandAcknowledged(committed, "COMMIT")) {
        throw new DurableDatabaseError("TX_COMMIT_UNCONFIRMED");
      }
      outcome = { ok: true, settlement: "COMMITTED", commitOutcome: "ACKNOWLEDGED", value, cleanupFailed: false };
    }
  } catch (error) {
    const firstError = safeDatabaseError(error);
    let settlement: "ROLLED_BACK" | "UNCONFIRMED" = "ROLLED_BACK";
    try {
      const rolledBack = await client.query("ROLLBACK");
      if (!commandAcknowledged(rolledBack, "ROLLBACK")) {
        throw new DurableDatabaseError("TX_ROLLBACK_UNCONFIRMED");
      }
    } catch {
      destroy = true;
      settlement = "UNCONFIRMED";
    }
    outcome = { ok: false, settlement, commitOutcome: commitAttempted ? "UNKNOWN" : "NOT_ATTEMPTED",
      error: firstError, cleanupFailed: false };
  } finally {
    tx.close();
    try {
      client.release(destroy);
    } catch {
      cleanupFailed = true;
    }
  }
  return Object.freeze({ ...outcome, cleanupFailed });
}

export async function withDurableTransaction<T>(
  pool: Pool,
  body: (tx: DurableTransaction) => Promise<T>,
): Promise<T> {
  const outcome = await runDurableTransaction(pool, body);
  if (!outcome.ok) {
    throw outcome.error;
  }
  // Preserve rejection on cleanup failure, while never exposing its raw cause.
  if (outcome.cleanupFailed) {
    throw new DurableDatabaseError("DB_FAILURE");
  }
  return outcome.value;
}
