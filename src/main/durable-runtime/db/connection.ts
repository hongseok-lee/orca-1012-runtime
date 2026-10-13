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
  pool.on("error", (error) => onError?.(safeDatabaseError(error)));
  return pool;
}

export class DurableTransaction {
  private readonly client: PoolClient;
  private active = true;
  private lockRank = 0;
  private lastKey = "";

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

  advanceLock(rank: number, key: string): void {
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

// SQL-only callback contract: external effects belong to a later durable operation.
export async function withDurableTransaction<T>(
  pool: Pool,
  body: (tx: DurableTransaction) => Promise<T>,
): Promise<T> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw safeDatabaseError(error);
  }
  const tx = new DurableTransaction(client);
  let destroy = false;
  try {
    await tx.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await body(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      destroy = true;
    }
    throw safeDatabaseError(error);
  } finally {
    tx.close();
    client.release(destroy);
  }
}
