import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from "./connection.ts";
import { applyMigrations, readMigrations } from "./migrate.ts";

if (!(process.env.PGDATABASE ?? "").startsWith("orca_p117_schema_")) {
  throw new Error("Owned structured schema DB required");
}
const pool = createDurablePool({ max: 2 });
const query = (sql: string, args: readonly unknown[] = []) =>
  withDurableTransaction(pool, (tx) => tx.query(sql, args));
const reject = (promise: Promise<unknown>, code = "23514") =>
  assert.rejects(promise, (error: unknown) => error instanceof DurableDatabaseError && error.code === code);

await test("017 actual PG public alias original submission identity FK dedup and rollback", async () => {
  try {
    const migrations = await readMigrations(fileURLToPath(new URL("./migrations/", import.meta.url)));
    assert.equal(migrations.length, 17);
    const ledger = await applyMigrations(pool, migrations);
    assert.deepEqual(ledger.map(({ version, checksum }) => ({ version, checksum })),
      migrations.map(({ version, checksum }) => ({ version, checksum })));
    assert.equal((await query("SELECT current_setting('search_path') AS path")).rows[0].path, '"$user", public');
    const workspace = randomUUID(), otherWorkspace = randomUUID(), agent = randomUUID(),
      session = randomUUID(), otherSession = randomUUID();
    const inputs = [randomUUID(), randomUUID(), randomUUID()], messages = [randomUUID(), randomUUID(), randomUUID()];
    const publicId = `public_session_${randomUUID().replaceAll("-", "")}`;
    const originalCreate = { worktree: "synthetic-worktree", agent: "claude", resumeFrom: "synthetic-request-intent" };
    const location = { workspaceId: workspace, executionHostId: "synthetic-host" };
    await withDurableTransaction(pool, async (tx) => {
      await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'synthetic','READY'),($3,$4,'synthetic-other','READY')", [workspace, workspace, otherWorkspace, otherWorkspace]);
      await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'synthetic')", [agent]);
      await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,session_fence,lifecycle) VALUES($1,$2,$3,1,'OPEN'),($4,$2,$5,1,'OPEN')", [session, agent, workspace, otherSession, otherWorkspace]);
      for (let i = 0; i < inputs.length; i++) {
        const principal = i === 1 ? "synthetic-principal-two" : "synthetic-principal-one";
        await tx.query("INSERT INTO durable_runtime.messages(id,session_id,seq,body_or_blob_ref,intake_status) VALUES($1,$2,$3,$4,'DURABLE')", [messages[i], session, i + 1, { orderedBody: [`synthetic-${i}`] }]);
        await tx.query("INSERT INTO durable_runtime.input_components(id,message_id,session_id,input_seq,authenticated_sender,client_operation_id,original_payload_hash,body_or_blob_ref) VALUES($1,$2,$3,$4,$5,'synthetic-same-key',repeat('a',64),$6)", [inputs[i], messages[i], session, i + 1, principal, { orderedBody: [`synthetic-${i}`] }]);
        await tx.query("INSERT INTO durable_runtime.session_events(session_id,journal_epoch,seq,event_id,source_key,body) VALUES($1,0,$2,$3,$4,$5)", [session, i + 1, randomUUID(), `synthetic-source:${inputs[i]}`, { kind: "INPUT_SUBMISSION", inputId: inputs[i] }]);
      }
    });
    const aliasSql = "INSERT INTO durable_runtime.structured_session_aliases(public_session_id,session_id,workspace_id,provider,execution_host_id,location,original_create,created_by) VALUES($1,$2,$3,'claude','synthetic-host',$4,$5,'synthetic-principal-one')";
    await reject(query(aliasSql, ["short", session, workspace, location, originalCreate]));
    await reject(query(aliasSql, ["bad.dot.session", session, workspace, location, originalCreate]));
    await reject(query(aliasSql, ["x".repeat(129), session, workspace, location, originalCreate]));
    await reject(query(aliasSql, [publicId, session, otherWorkspace, location, originalCreate]), "23503");
    await reject(query(aliasSql, [publicId, session, workspace, JSON.stringify([]), originalCreate]));
    await query(aliasSql, [publicId, session, workspace, location, originalCreate]);
    await reject(query(aliasSql, [publicId, otherSession, otherWorkspace, location, originalCreate]), "23505");
    await reject(query(aliasSql, ["another_public_session", session, workspace, location, originalCreate]), "23505");
    await reject(query("UPDATE durable_runtime.structured_session_aliases SET session_id=$2 WHERE public_session_id=$1", [publicId, otherSession]));
    await reject(query("UPDATE durable_runtime.structured_session_aliases SET original_create='{}' WHERE public_session_id=$1", [publicId]));
    await reject(query("DELETE FROM durable_runtime.structured_session_aliases WHERE public_session_id=$1", [publicId]));
    const submissionSql = "INSERT INTO durable_runtime.structured_submissions(input_id,message_id,session_id,principal_id,client_message_id,wire_payload_fingerprint,wire_fence,journal_epoch,journal_sequence,submitted_at) SELECT $1,$2,$3,$4,'synthetic-same-key',$5,$6,$7,$8,accepted_at FROM durable_runtime.input_components WHERE id=$1";
    const submitArgs = (i: number) => [inputs[i], messages[i], session, i === 1 ? "synthetic-principal-two" : "synthetic-principal-one", "a".repeat(64), "1", "0", String(i + 1)];
    const wrongMessage = submitArgs(0); wrongMessage[1] = messages[1];
    await reject(query(submissionSql, wrongMessage), "23503");
    const wrongSession = submitArgs(0); wrongSession[2] = otherSession;
    await reject(query(submissionSql, wrongSession), "23503");
    const wrongEvent = submitArgs(0); wrongEvent[7] = "999";
    await reject(query(submissionSql, wrongEvent), "23503");
    const wrongEpoch = submitArgs(0); wrongEpoch[6] = "1";
    await reject(query(submissionSql, wrongEpoch), "23503");
    for (const [index, value] of [[4, "A".repeat(64)], [5, "0"], [6, "-1"], [7, "0"]] as const) {
      const bad = submitArgs(0); bad[index] = value;
      await reject(query(submissionSql, bad));
    }
    await query(submissionSql, submitArgs(0));
    const original = (await query("SELECT * FROM durable_runtime.structured_submissions WHERE input_id=$1", [inputs[0]])).rows[0];
    await reject(query(submissionSql, submitArgs(0)), "23505");
    await reject(query(submissionSql, submitArgs(2)), "23505");
    await query(submissionSql, submitArgs(1));
    assert.equal((await query("SELECT count(*)::integer AS count FROM durable_runtime.structured_submissions WHERE session_id=$1 AND client_message_id='synthetic-same-key'", [session])).rows[0].count, 2);
    await reject(query("UPDATE durable_runtime.structured_submissions SET wire_fence=2 WHERE input_id=$1", [inputs[0]]));
    await reject(query("UPDATE durable_runtime.structured_submissions SET wire_payload_fingerprint=repeat('b',64) WHERE input_id=$1", [inputs[0]]));
    await reject(query("DELETE FROM durable_runtime.structured_submissions WHERE input_id=$1", [inputs[0]]));
    assert.deepEqual((await query("SELECT * FROM durable_runtime.structured_submissions WHERE session_id=$1 AND principal_id='synthetic-principal-one' AND client_message_id='synthetic-same-key'", [session])).rows[0], original);
    assert.deepEqual((await query("SELECT location,original_create FROM durable_runtime.structured_session_aliases WHERE public_session_id=$1", [publicId])).rows[0], { location, original_create: originalCreate });

    const rollbackInput = randomUUID(), rollbackMessage = randomUUID(), rollbackAlias = "rollback_public_session";
    let rollbackBarrierReached = false;
    await assert.rejects(withDurableTransaction(pool, async (tx) => {
      await tx.query(aliasSql, [rollbackAlias, otherSession, otherWorkspace, location, originalCreate]);
      await tx.query("INSERT INTO durable_runtime.messages(id,session_id,seq,body_or_blob_ref,intake_status) VALUES($1,$2,4,'{}','DURABLE')", [rollbackMessage, session]);
      await tx.query("INSERT INTO durable_runtime.input_components(id,message_id,session_id,input_seq,authenticated_sender,client_operation_id,original_payload_hash,body_or_blob_ref) VALUES($1,$2,$3,4,'synthetic-rollback','synthetic-same-key',repeat('a',64),'{}')", [rollbackInput, rollbackMessage, session]);
      await tx.query("INSERT INTO durable_runtime.session_events(session_id,journal_epoch,seq,event_id,source_key,body) VALUES($1,0,4,$2,$3,'{}')", [session, randomUUID(), `synthetic-rollback:${rollbackInput}`]);
      await tx.query(submissionSql, [rollbackInput, rollbackMessage, session, "synthetic-rollback", "a".repeat(64), "1", "0", "4"]);
      rollbackBarrierReached = true;
      throw new Error("synthetic rollback barrier");
    }));
    assert.equal(rollbackBarrierReached, true);
    assert.equal((await query("SELECT public_session_id FROM durable_runtime.structured_session_aliases WHERE public_session_id=$1", [rollbackAlias])).rowCount, 0);
    assert.equal((await query("SELECT input_id FROM durable_runtime.structured_submissions WHERE input_id=$1", [rollbackInput])).rowCount, 0);
    assert.equal((await query("SELECT id FROM durable_runtime.input_components WHERE id=$1", [rollbackInput])).rowCount, 0);
    assert.equal((await query("SELECT id FROM durable_runtime.messages WHERE id=$1", [rollbackMessage])).rowCount, 0);
    assert.equal((await query("SELECT seq FROM durable_runtime.session_events WHERE session_id=$1 AND seq=4", [session])).rowCount, 0);
    assert.deepEqual((await query("SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version")).rows, ledger);
    if (process.env.SCHEMA_RESULTS_PATH) {
      await writeFile(process.env.SCHEMA_RESULTS_PATH, JSON.stringify({ distinct_tests: 1, passed: 1, failed: 0, skipped: 0,
        source: "a24db99ed3184bb9cbd3b7fe70f8c85bfea8bf37", migration_chain: ledger, synthetic_fixture: true,
        scope: "017 schema FK/history/dedup constraints; not wire resolver/authentication/provider admission", dev013018_applied: false,
        checks: ["non-UUID public grammar", "alias identity and history", "input/message/session/event FK", "principal-scoped key uniqueness", "original metadata replay lookup", "atomic rollback", "001-016 checksums unchanged"] }, null, 2), { mode: 0o600 });
    }
  } finally {
    await pool.end();
  }
});
