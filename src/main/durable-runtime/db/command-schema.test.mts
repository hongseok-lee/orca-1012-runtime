import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from "./connection.ts";
import { applyMigrations, readMigrations } from "./migrate.ts";
if (!(process.env.PGDATABASE ?? "").startsWith("orca_p109_")) {
  throw new Error("Owned command schema DB required");
}
const pool = createDurablePool({ max: 4 });
const query = (sql: string, args: readonly unknown[] = []) =>
  withDurableTransaction(pool, (tx) => tx.query(sql, args));
const reject = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (e: unknown) => e instanceof DurableDatabaseError && e.code === code);
await test("010 actual PG command key owner shape terminal and append-only constraints", async () => {
  try {
    await applyMigrations(
      pool,
      await readMigrations(fileURLToPath(new URL("./migrations/", import.meta.url))),
    );
    const unit = randomUUID(),
      operation = randomUUID(),
      scope = randomUUID();
    await withDurableTransaction(pool, async (tx) => {
      await tx.query(
        "INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','READY')",
        [unit],
      );
      await tx.query(
        "INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,'test-owner',1,clock_timestamp()+interval '1 minute')",
        [scope],
      );
      await tx.query(
        "INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,execution_epoch) VALUES($1,$2,'test',0,$3,1,'initial',0)",
        [operation, unit, scope],
      );
    });
    const insert =
      "INSERT INTO durable_runtime.runtime_commands(id,operation_id,runtime_unit_id,command_name,original_controller_term,step_revision,pod_target,execution_epoch,intent_revision,input_hash,input,owner_controller_term) VALUES($1,$2,$3,$4,1,0,'CREATE_WITHOUT_POD',0,0,$5,'{}',1)";
    const commands = [randomUUID(), randomUUID()];
    const outcomes = await Promise.allSettled(
      commands.map((id, i) =>
        query(insert, [id, operation, unit, i ? "bind" : "ensureAttempt", "a".repeat(64)]),
      ),
    );
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
    const id = (
      await query("SELECT id FROM durable_runtime.runtime_commands WHERE runtime_unit_id=$1", [
        unit,
      ])
    ).rows[0].id;
    await reject(
      query("UPDATE durable_runtime.runtime_commands SET expected_pod_uid='other' WHERE id=$1", [
        id,
      ]),
      "23514",
    );
    await query(
      "UPDATE durable_runtime.runtime_commands SET state='EXECUTING',executor_id='test-executor',execution_token=$2,claimed_at=clock_timestamp(),revision=revision+1 WHERE id=$1",
      [id, randomUUID()],
    );
    await reject(
      query("UPDATE durable_runtime.runtime_commands SET state='ACCEPTED' WHERE id=$1", [id]),
      "23514",
    );
    await query(
      "UPDATE durable_runtime.runtime_commands SET state='UNKNOWN',revision=revision+1 WHERE id=$1",
      [id],
    );
    await reject(
      query("UPDATE durable_runtime.runtime_commands SET state='EXECUTING' WHERE id=$1", [id]),
      "23514",
    );
    await reject(
      query("UPDATE durable_runtime.runtime_commands SET execution_token=$2 WHERE id=$1", [
        id,
        randomUUID(),
      ]),
      "23514",
    );
    await query(
      "UPDATE durable_runtime.runtime_commands SET owner_controller_term=2,state='RESOLVED',result='{}',settled_at=clock_timestamp(),revision=revision+1 WHERE id=$1",
      [id],
    );
    await reject(
      query("UPDATE durable_runtime.runtime_commands SET result='{\"other\":true}' WHERE id=$1", [
        id,
      ]),
      "23514",
    );
    await reject(query("DELETE FROM durable_runtime.runtime_commands WHERE id=$1", [id]), "23514");
    const history = randomUUID();
    await query(
      "INSERT INTO durable_runtime.runtime_command_history(id,command_id,stage,controller_term) VALUES($1,$2,'observed',2)",
      [history, id],
    );
    await reject(
      query("UPDATE durable_runtime.runtime_command_history SET stage='other' WHERE id=$1", [
        history,
      ]),
      "23514",
    );
    await reject(
      query("DELETE FROM durable_runtime.runtime_command_history WHERE id=$1", [history]),
      "23514",
    );
  } finally {
    await pool.end();
  }
});
