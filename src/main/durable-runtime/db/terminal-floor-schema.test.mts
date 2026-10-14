import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createDurablePool, DurableDatabaseError, safeDatabaseError, withDurableTransaction } from "./connection.ts";
import { applyMigrations, readMigrations } from "./migrate.ts";

if (!(process.env.PGDATABASE ?? "").startsWith("orca_p118_schema_")) {
  throw new Error("Owned terminal floor schema DB required");
}
const pool = createDurablePool({ max: 4 });
const query = (sql: string, args: readonly unknown[] = []) =>
  withDurableTransaction(pool, (tx) => tx.query(sql, args));
const reject = (promise: Promise<unknown>, code = "23514") =>
  assert.rejects(promise, (error: unknown) => error instanceof DurableDatabaseError && error.code === code);

await test("018 actual PG floor identity generation concurrent CAS original draft preservation and rollback", async () => {
  try {
    const migrations = await readMigrations(fileURLToPath(new URL("./migrations/", import.meta.url)));
    assert.equal(migrations.length, 18);
    const ledger = await applyMigrations(pool, migrations);
    assert.deepEqual(ledger.map(({ version, checksum }) => ({ version, checksum })),
      migrations.map(({ version, checksum }) => ({ version, checksum })));
    assert.equal((await query("SELECT current_setting('search_path') AS path")).rows[0].path, '"$user", public');
    const workspace = randomUUID(), otherWorkspace = randomUUID(), agent = randomUUID(),
      session = randomUUID(), otherSession = randomUUID(), tab = randomUUID(), otherTab = randomUUID();
    const handle = `synthetic-terminal:${tab}`, otherHandle = `synthetic-terminal:${otherTab}`;
    await withDurableTransaction(pool, async (tx) => {
      await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'synthetic','READY'),($3,$4,'synthetic-other','READY')", [workspace, workspace, otherWorkspace, otherWorkspace]);
      await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'synthetic')", [agent]);
      await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,session_fence,lifecycle) VALUES($1,$2,$3,1,'OPEN'),($4,$2,$5,1,'OPEN')", [session, agent, workspace, otherSession, otherWorkspace]);
      await tx.query("INSERT INTO durable_runtime.tabs(id,workspace_id,session_id,kind,terminal_handle,ui_order,lifecycle) VALUES($1,$2,$3,'terminal',$4,0,'OPEN'),($5,$6,$7,'terminal',$8,0,'OPEN')", [tab, workspace, session, handle, otherTab, otherWorkspace, otherSession, otherHandle]);
    });
    const floorSql = "INSERT INTO durable_runtime.terminal_input_floors(terminal_handle,session_id,floor_generation,revision,principal_id,paired_device_id,connection_id,mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8)";
    const floorArgs = [handle, session, "0", "0", "synthetic-principal-one", "synthetic-device-one", "synthetic-connection-one", "AGENT_CHAT_COMPAT"];
    await reject(query(floorSql, [handle, otherSession, ...floorArgs.slice(2)]), "23503");
    await reject(query(floorSql, ["synthetic-missing-handle", session, ...floorArgs.slice(2)]), "23503");
    for (const [index, value] of [[2, "-1"], [3, "-1"], [4, ""], [5, ""], [6, ""], [7, "unsupported"]] as const) {
      const bad = [...floorArgs]; bad[index] = value;
      await reject(query(floorSql, bad));
    }
    await query(floorSql, floorArgs);
    await reject(query(floorSql, floorArgs), "23505");
    await reject(query("UPDATE durable_runtime.terminal_input_floors SET terminal_handle=$2 WHERE terminal_handle=$1", [handle, otherHandle]));
    await reject(query("UPDATE durable_runtime.terminal_input_floors SET session_id=$2 WHERE terminal_handle=$1", [handle, otherSession]));
    for (const column of ["principal_id", "paired_device_id", "mode"]) {
      await reject(query(`UPDATE durable_runtime.terminal_input_floors SET ${column}=$2 WHERE terminal_handle=$1`, [handle, column === "mode" ? "RAW_TERMINAL" : "synthetic-other-owner"]));
    }
    const body = { version: 1, principalId: floorArgs[4], sessionId: session, mode: floorArgs[7], connectionId: floorArgs[6],
      chunks: ["synthetic-body", "\r"], pasteOpen: true, pendingDelimiter: "\u001b[20", pendingUtf8: [226, 130], streamIdentity: "synthetic-stream" };
    const attachments = [{ id: "synthetic-attachment", content: "synthetic-content" }];
    const draftSql = "INSERT INTO durable_runtime.legacy_drafts(terminal_handle,paired_device_id,floor_generation,draft_revision,body,attachments,lifecycle,updated_at) VALUES($1,$2,$3,7,$4,$5,'DRAFT',clock_timestamp())";
    await query(draftSql, [handle, floorArgs[5], "0", body, JSON.stringify(attachments)]);
    const draftRead = () => query("SELECT * FROM durable_runtime.legacy_drafts WHERE terminal_handle=$1 AND paired_device_id=$2 AND floor_generation=0", [handle, floorArgs[5]]);
    const originalDraft = (await draftRead()).rows[0];
    assert.deepEqual(originalDraft.body, body);
    assert.deepEqual(originalDraft.attachments, attachments);
    await query(draftSql, [otherHandle, floorArgs[5], "0", { historicalShape: "synthetic-unsupported-history" }, JSON.stringify([])]);
    const historicalDraft = (await query("SELECT * FROM durable_runtime.legacy_drafts WHERE terminal_handle=$1", [otherHandle])).rows[0];

    const first = await pool.connect(), second = await pool.connect();
    let pending: Promise<number | null> | undefined;
    let blockingObserved = false;
    try {
      await first.query("BEGIN"); await second.query("BEGIN");
      const firstPid = (await first.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const secondPid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const casSql = "UPDATE durable_runtime.terminal_input_floors SET revision=revision+1 WHERE terminal_handle=$1 AND floor_generation=0 AND revision=0 RETURNING revision";
      assert.equal((await first.query(casSql, [handle])).rowCount, 1);
      pending = second.query(casSql, [handle]).then((result) => result.rowCount, (error: unknown) => { throw safeDatabaseError(error); });
      for (let attempt = 0; attempt < 100; attempt++) {
        blockingObserved = (await pool.query("SELECT $1::integer=ANY(pg_blocking_pids($2::integer)) AS blocked", [firstPid, secondPid])).rows[0].blocked;
        if (blockingObserved) { break; }
        await delay(10);
      }
      assert.equal(blockingObserved, true);
      await first.query("COMMIT");
      assert.equal(await pending, 0);
      await second.query("COMMIT");
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      if (pending) { await pending.catch(() => undefined); }
      await second.query("ROLLBACK").catch(() => undefined);
      first.release(); second.release();
    }
    assert.equal((await query("SELECT revision FROM durable_runtime.terminal_input_floors WHERE terminal_handle=$1", [handle])).rows[0].revision, "1");
    await reject(query("UPDATE durable_runtime.terminal_input_floors SET connection_id='synthetic-connection-two' WHERE terminal_handle=$1", [handle]));
    const reattachSql = "UPDATE durable_runtime.terminal_input_floors SET connection_id=$2,revision=revision+1 WHERE terminal_handle=$1 AND session_id=$3 AND floor_generation=0 AND revision=$4 AND principal_id=$5 AND paired_device_id=$6 AND mode='AGENT_CHAT_COMPAT' AND connection_id=$7 RETURNING revision";
    assert.equal((await query(reattachSql, [handle, "synthetic-connection-two", session, "1", floorArgs[4], floorArgs[5], floorArgs[6]])).rowCount, 1);
    assert.equal((await query(reattachSql, [handle, "synthetic-stale-connection", session, "2", floorArgs[4], floorArgs[5], floorArgs[6]])).rowCount, 0);
    assert.deepEqual((await draftRead()).rows[0], originalDraft);
    await reject(query("UPDATE durable_runtime.terminal_input_floors SET revision=1 WHERE terminal_handle=$1", [handle]));
    await query("UPDATE durable_runtime.terminal_input_floors SET mode='RAW_TERMINAL',floor_generation=1,revision=3 WHERE terminal_handle=$1", [handle]);
    await reject(query("UPDATE durable_runtime.terminal_input_floors SET floor_generation=0 WHERE terminal_handle=$1", [handle]));
    await query("UPDATE durable_runtime.terminal_input_floors SET principal_id='synthetic-principal-two',paired_device_id='synthetic-device-two',connection_id='synthetic-connection-three',floor_generation=2,revision=4 WHERE terminal_handle=$1", [handle]);
    await query(draftSql, [handle, "synthetic-device-two", "2", { chunks: ["synthetic-isolated-owner-body"] }, JSON.stringify([])]);
    assert.deepEqual((await draftRead()).rows[0], originalDraft);
    assert.equal((await query("SELECT count(*)::integer AS count FROM durable_runtime.legacy_drafts WHERE terminal_handle=$1", [handle])).rows[0].count, 2);
    assert.deepEqual((await query("SELECT * FROM durable_runtime.legacy_drafts WHERE terminal_handle=$1", [otherHandle])).rows[0], historicalDraft);
    await reject(query("DELETE FROM durable_runtime.terminal_input_floors WHERE terminal_handle=$1", [handle]));
    const beforeRollback = (await query("SELECT * FROM durable_runtime.terminal_input_floors WHERE terminal_handle=$1", [handle])).rows[0];
    let rollbackBarrierReached = false;
    await assert.rejects(withDurableTransaction(pool, async (tx) => {
      await tx.query("UPDATE durable_runtime.terminal_input_floors SET connection_id='synthetic-rollback-connection',revision=5 WHERE terminal_handle=$1", [handle]);
      await tx.query("UPDATE durable_runtime.legacy_drafts SET body=$2,draft_revision=8,updated_at=clock_timestamp() WHERE terminal_handle=$1 AND paired_device_id=$3 AND floor_generation=0", [handle, { chunks: ["synthetic-rollback-body"] }, floorArgs[5]]);
      await tx.query(draftSql, [handle, "synthetic-rollback-device", "3", { chunks: ["synthetic-rollback-insert"] }, JSON.stringify([])]);
      rollbackBarrierReached = true;
      throw new Error("synthetic rollback barrier");
    }));
    assert.equal(rollbackBarrierReached, true);
    assert.deepEqual((await query("SELECT * FROM durable_runtime.terminal_input_floors WHERE terminal_handle=$1", [handle])).rows[0], beforeRollback);
    assert.deepEqual((await draftRead()).rows[0], originalDraft);
    assert.equal((await query("SELECT * FROM durable_runtime.legacy_drafts WHERE terminal_handle=$1 AND paired_device_id='synthetic-rollback-device'", [handle])).rowCount, 0);
    assert.deepEqual((await query("SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version")).rows, ledger);
    if (process.env.SCHEMA_RESULTS_PATH) {
      await writeFile(process.env.SCHEMA_RESULTS_PATH, JSON.stringify({ distinct_tests: 1, passed: 1, failed: 0, skipped: 0,
        source: "58af00c45327221de84c729b6d818dfbe405daf9", migration_chain: ledger, synthetic_fixture: true, concurrent_pg_blocking_observed: blockingObserved,
        scope: "018 schema FK/floor CAS/history preservation/rollback only; not authenticated reattach, draft codec, public RPC or PTY", dev013018_applied: false,
        checks: ["handle/Session FK", "identity and generation/revision monotonicity", "owner/device/mode require a new generation", "overlapping same-handle PG CAS", "same-floor connection revision CAS and stale pin rejection", "original legacy draft JSON and historical rows preserved", "atomic floor/draft rollback", "001-017 checksums unchanged"] }, null, 2), { mode: 0o600 });
    }
  } finally {
    await pool.end();
  }
});
