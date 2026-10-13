import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from "./connection.ts";
import { applyMigrations, readMigrations } from "./migrate.ts";
if (!(process.env.PGDATABASE ?? "").startsWith("orca_p105_")) {
  throw new Error("Owned input schema DB required");
}
const pool = createDurablePool({ max: 2 });
const query = (sql: string, args: readonly unknown[] = []) =>
  withDurableTransaction(pool, (tx) => tx.query(sql, args));
const reject = (promise: Promise<unknown>) =>
  assert.rejects(promise, (e: unknown) => e instanceof DurableDatabaseError && e.code === "23514");
await test("012 actual PG sealed backfill internal kind irreversible boundary and revision guard", async () => {
  try {
    const migrations = await readMigrations(
      fileURLToPath(new URL("./migrations/", import.meta.url)),
    );
    await applyMigrations(
      pool,
      migrations.filter((m) => !m.version.startsWith("012-")),
    );
    const workspace = randomUUID(),
      agent = randomUUID(),
      session = randomUUID(),
      sealed = randomUUID(),
      general = randomUUID(),
      command = randomUUID();
    await withDurableTransaction(pool, async (tx) => {
      await tx.query(
        "INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'test','READY')",
        [workspace, workspace],
      );
      await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'synthetic')", [
        agent,
      ]);
      await tx.query(
        "INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')",
        [session, agent, workspace],
      );
      await tx.query(
        "INSERT INTO durable_runtime.messages(id,session_id,seq,revision,sealed_revision,sealed_payload_hash,body_or_blob_ref,intake_status) VALUES($1,$2,1,1,1,$3,'{}','DISPATCH_INTENT')",
        [sealed, session, "a".repeat(64)],
      );
    });
    await applyMigrations(pool, migrations);
    assert.equal(
      (await query("SELECT merge_closed FROM durable_runtime.messages WHERE id=$1", [sealed]))
        .rows[0].merge_closed,
      true,
    );
    await query(
      "INSERT INTO durable_runtime.messages(id,session_id,seq,revision,body_or_blob_ref,intake_status) VALUES($1,$2,2,1,'{}','DURABLE')",
      [general, session],
    );
    const row = (
      await query("SELECT input_kind,merge_closed FROM durable_runtime.messages WHERE id=$1", [
        general,
      ])
    ).rows[0];
    assert.deepEqual(row, { input_kind: "GENERAL", merge_closed: false });
    await query(
      "INSERT INTO durable_runtime.messages(id,session_id,seq,revision,input_kind,body_or_blob_ref,intake_status) VALUES($1,$2,3,1,'COMMAND','{}','DURABLE')",
      [command, session],
    );
    assert.equal(
      (await query("SELECT merge_closed FROM durable_runtime.messages WHERE id=$1", [command]))
        .rows[0].merge_closed,
      true,
    );
    await reject(
      query("UPDATE durable_runtime.messages SET input_kind='QUESTION_RESPONSE' WHERE id=$1", [
        general,
      ]),
    );
    await reject(query("UPDATE durable_runtime.messages SET revision=0 WHERE id=$1", [general]));
    await query(
      "UPDATE durable_runtime.messages SET merge_closed=true,revision=revision+1 WHERE id=$1",
      [general],
    );
    await reject(
      query("UPDATE durable_runtime.messages SET merge_closed=false WHERE id=$1", [general]),
    );
    await reject(
      query("UPDATE durable_runtime.messages SET merge_closed=false WHERE id=$1", [sealed]),
    );
    await reject(
      query(
        "UPDATE durable_runtime.messages SET body_or_blob_ref='{\"changed\":true}' WHERE id=$1",
        [sealed],
      ),
    );
  } finally {
    await pool.end();
  }
});
