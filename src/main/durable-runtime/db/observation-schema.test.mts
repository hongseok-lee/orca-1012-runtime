import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createDurablePool, DurableDatabaseError, safeDatabaseError, withDurableTransaction } from "./connection.ts";
import { applyMigrations, readMigrations } from "./migrate.ts";

if (!(process.env.PGDATABASE ?? "").startsWith("orca_p115_schema_")) {
  throw new Error("Owned observation schema DB required");
}
const pool = createDurablePool({ max: 4 });
const query = (sql: string, args: readonly unknown[] = []) =>
  withDurableTransaction(pool, (tx) => tx.query(sql, args));
const reject = (promise: Promise<unknown>, code = "23514") =>
  assert.rejects(promise, (error: unknown) => error instanceof DurableDatabaseError && error.code === code);

await test("016 actual PG producer triple original episode deadline concurrent uniqueness challenge and rollback", async () => {
  try {
    const migrations = await readMigrations(fileURLToPath(new URL("./migrations/", import.meta.url)));
    assert.equal(migrations.length, 16);
    const predecessor = await applyMigrations(pool, migrations.slice(0, 15));
    const ledger = await applyMigrations(pool, migrations);
    assert.deepEqual(ledger.slice(0, 15), predecessor);
    assert.deepEqual(ledger.map(({ version, checksum }) => ({ version, checksum })),
      migrations.map(({ version, checksum }) => ({ version, checksum })));
    assert.equal((await query("SELECT current_setting('search_path') AS path")).rows[0].path, '"$user", public');
    const workspace = randomUUID(), agent = randomUUID(), session = randomUUID(), unit = randomUUID(),
      otherUnit = randomUUID(), attempt = randomUUID(), otherAttempt = randomUUID(), binding = randomUUID(),
      producer = randomUUID(), episode = randomUUID(), operation = randomUUID(), wrongOperation = randomUUID();
    const pod = `synthetic-pod:${attempt}`;
    await withDurableTransaction(pool, async (tx) => {
      await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'synthetic','READY')", [workspace, workspace]);
      await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'synthetic')", [agent]);
      await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [session, agent, workspace]);
      await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT'),($2,'RUNNING','ABSENT')", [unit, otherUnit]);
      await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0),($2,0,'{}',0)", [unit, otherUnit]);
      await tx.query("INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,resource_profile_revision,effective_resources,status) VALUES($1,$2,1,'COLD',$3,0,'{}','READY'),($4,$5,1,'COLD','synthetic-other-pod',0,'{}','READY')", [attempt, unit, pod, otherAttempt, otherUnit]);
      await tx.query("INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES('synthetic',$1)", [unit]);
      await tx.query("INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state) VALUES($1,'synthetic',$2,$3,'AVAILABLE')", [binding, unit, `/synthetic/${unit}`]);
      await tx.query("INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)", [unit, session, binding]);
      // Actual owned PG producer registry rows, not a production authentication factory.
      await tx.query("INSERT INTO durable_runtime.runtime_event_producers(producer_id,incarnation,agent_id,runtime_unit_id,attempt_id,pod_uid,execution_epoch) VALUES($1,'synthetic-one',$2,$3,$4,$5,1),($1,'synthetic-two',$2,$3,$4,$5,1)", [producer, agent, unit, attempt, pod]);
      await tx.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,'synthetic',1,clock_timestamp()+interval '1 minute')", [unit]);
      await tx.query("INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,execution_epoch) VALUES($1,$2,'OBSERVATION_FENCE',0,$5,1,'FENCE_PENDING',1),($3,$4,'OBSERVATION_FENCE',0,$5,1,'FENCE_PENDING',1)", [operation, unit, wrongOperation, otherUnit, unit]);
    });
    const insert = "INSERT INTO durable_runtime.observation_episodes(id,runtime_unit_id,attempt_id,execution_epoch,pod_uid,start_source_ref,start_producer_id,start_producer_incarnation,start_watermark) VALUES($1,$2,$3,1,$4,'synthetic-loss',$5,$6,$7) RETURNING *";
    const args = (id: string) => [id, unit, attempt, pod, producer, "synthetic-one", "7"];
    await reject(query(insert, [randomUUID(), unit, attempt, "synthetic-wrong-pod", null, null, null]), "23503");
    await reject(query(insert, [randomUUID(), unit, otherAttempt, pod, null, null, null]), "23503");
    await reject(query(insert, [randomUUID(), unit, attempt, pod, producer, null, "7"]));
    await reject(query(insert, [randomUUID(), unit, attempt, pod, null, "synthetic-one", null]));
    await reject(query(insert, [randomUUID(), unit, attempt, pod, producer, "", "7"]));
    await reject(query(insert, [randomUUID(), unit, attempt, pod, producer, "synthetic-one", "-1"]));
    await reject(query(insert, [randomUUID(), unit, attempt, pod, producer, "synthetic-missing", "7"]), "23503");

    const first = await pool.connect(), second = await pool.connect();
    let pending: Promise<string> | undefined;
    let overlapObserved = false;
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");
      const firstPid = (await first.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const secondPid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await first.query(insert, args(episode));
      pending = second.query(insert, args(randomUUID())).then(() => "UNEXPECTED_SUCCESS", (error: unknown) => safeDatabaseError(error).code);
      for (let tries = 0; tries < 100; tries++) {
        const waiting = (await query("SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) AS blocked", [secondPid, firstPid])).rows[0].blocked;
        if (waiting) { overlapObserved = true; break; }
        await delay(10);
      }
      assert.equal(overlapObserved, true);
      await first.query("COMMIT");
      assert.equal(await pending, "23505");
    } finally {
      await first.query("ROLLBACK");
      if (pending) {
        await pending;
      }
      await second.query("ROLLBACK");
      first.release(); second.release();
    }
    assert.equal((await query("SELECT count(*)::integer AS count FROM durable_runtime.observation_episodes WHERE runtime_unit_id=$1", [unit])).rows[0].count, 1);
    assert.equal((await query("SELECT deadline_at=started_at+interval '6 hours' AS exact FROM durable_runtime.observation_episodes WHERE id=$1", [episode])).rows[0].exact, true);
    const original = (await query("SELECT * FROM durable_runtime.observation_episodes WHERE id=$1", [episode])).rows[0];
    for (const change of ["pod_uid='replacement'", "attempt_id='00000000-0000-0000-0000-000000000001'", "execution_epoch=2",
      "started_at=started_at-interval '1 second'", "deadline_at=deadline_at+interval '1 second'",
      "start_source_ref='replacement'", "start_producer_incarnation='synthetic-two',start_watermark=999", "start_watermark=8"]) {
      await reject(query(`UPDATE durable_runtime.observation_episodes SET ${change} WHERE id=$1`, [episode]));
    }
    const challenge = `synthetic-challenge:${episode}`, replacement = `synthetic-replacement:${episode}`;
    const challengeSql = "INSERT INTO durable_runtime.observation_challenges(id,episode_id,runtime_unit_id,attempt_id,pod_uid,execution_epoch,request_source_ref,expected_producer_id,expected_producer_incarnation,expected_watermark) VALUES($1,$2,$3,$4,$5,1,'synthetic-request',$6,$7,$8)";
    const challengeArgs = (id: string) => [id, episode, unit, attempt, pod, producer, "synthetic-one", "7"];
    await reject(query(challengeSql, [challenge, episode, unit, attempt, "synthetic-wrong-pod", producer, "synthetic-one", "7"]), "23503");
    await reject(query(challengeSql, [challenge, episode, unit, attempt, pod, producer, null, "7"]));
    await reject(query(challengeSql, [challenge, episode, unit, attempt, pod, producer, "synthetic-missing", "7"]), "23503");
    await query(challengeSql, challengeArgs(challenge));
    await reject(query(challengeSql, challengeArgs(replacement)), "23505");
    await reject(query("UPDATE durable_runtime.observation_challenges SET expected_producer_incarnation='synthetic-two',expected_watermark=999 WHERE id=$1", [challenge]));
    await reject(query("UPDATE durable_runtime.observation_challenges SET request_source_ref='replacement' WHERE id=$1", [challenge]));
    await reject(query("UPDATE durable_runtime.observation_challenges SET pod_uid='replacement' WHERE id=$1", [challenge]));
    await withDurableTransaction(pool, async (tx) => {
      await tx.query("UPDATE durable_runtime.observation_challenges SET superseded_at=clock_timestamp(),superseded_by=$2 WHERE id=$1", [challenge, replacement]);
      await tx.query(challengeSql, challengeArgs(replacement));
    });
    await reject(query("UPDATE durable_runtime.observation_challenges SET superseded_at=NULL,superseded_by=NULL WHERE id=$1", [challenge]));
    await query("UPDATE durable_runtime.observation_challenges SET consumed_at=clock_timestamp() WHERE id=$1", [replacement]);
    await reject(query("UPDATE durable_runtime.observation_challenges SET consumed_at=NULL WHERE id=$1", [replacement]));
    await reject(query("DELETE FROM durable_runtime.observation_challenges WHERE id=$1", [replacement]));
    assert.equal((await query("SELECT deadline_at FROM durable_runtime.observation_episodes WHERE id=$1", [episode])).rows[0].deadline_at.getTime(), original.deadline_at.getTime());
    await reject(query("UPDATE durable_runtime.observation_episodes SET state='RESOLVED' WHERE id=$1", [episode]));
    await query("UPDATE durable_runtime.observation_episodes SET state='RESOLVED',resolved_at=clock_timestamp(),revision=1 WHERE id=$1", [episode]);
    await reject(query("UPDATE durable_runtime.observation_episodes SET state='OPEN',resolved_at=NULL WHERE id=$1", [episode]));
    await reject(query("UPDATE durable_runtime.observation_episodes SET revision=0 WHERE id=$1", [episode]));
    await reject(query("DELETE FROM durable_runtime.observation_episodes WHERE id=$1", [episode]));
    const nextEpisode = randomUUID();
    await query(insert, [nextEpisode, unit, attempt, pod, null, null, null]);
    await reject(query("UPDATE durable_runtime.observation_episodes SET state='FENCING',fence_operation_id=$2 WHERE id=$1", [nextEpisode, wrongOperation]), "23503");
    await query("UPDATE durable_runtime.observation_episodes SET state='FENCING',fence_operation_id=$2,revision=1 WHERE id=$1", [nextEpisode, operation]);
    await reject(query("UPDATE durable_runtime.observation_episodes SET fence_operation_id=NULL WHERE id=$1", [nextEpisode]));
    await reject(query("UPDATE durable_runtime.observation_episodes SET state='BLOCKED' WHERE id=$1", [nextEpisode]));
    await query("UPDATE durable_runtime.observation_episodes SET state='BLOCKED',reason='synthetic-not-physical-proof',revision=2 WHERE id=$1", [nextEpisode]);

    const rollbackEpisode = randomUUID(), rollbackChallenge = `synthetic-rollback:${rollbackEpisode}`;
    let rollbackBarrierReached = false;
    await assert.rejects(withDurableTransaction(pool, async (tx) => {
      await tx.query(insert, [rollbackEpisode, otherUnit, otherAttempt, "synthetic-other-pod", null, null, null]);
      await tx.query(challengeSql, [rollbackChallenge, rollbackEpisode, otherUnit, otherAttempt, "synthetic-other-pod", null, null, null]);
      rollbackBarrierReached = true;
      throw new Error("synthetic rollback barrier");
    }));
    assert.equal(rollbackBarrierReached, true);
    assert.equal((await query("SELECT id FROM durable_runtime.observation_episodes WHERE id=$1", [rollbackEpisode])).rowCount, 0);
    assert.equal((await query("SELECT id FROM durable_runtime.observation_challenges WHERE id=$1", [rollbackChallenge])).rowCount, 0);
    assert.deepEqual((await query("SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version")).rows, ledger);
    if (process.env.SCHEMA_RESULTS_PATH) {
      await writeFile(process.env.SCHEMA_RESULTS_PATH, JSON.stringify({ distinct_tests: 1, passed: 1, failed: 0, skipped: 0,
        source: "4f1ecdb62365e5400398fb9f2812c1569d0c9066", migration_chain: ledger,
        pg_lock_overlap_observed: overlapObserved, synthetic_owned_registry_fixture: true,
        scope: "016 schema constraints only; not fresh recovery authentication or physical fencing", dev013017_applied: false,
        checks: ["producer nullable triple/FK/immutable incarnation", "original tuple FK", "fixed six-hour deadline", "concurrent open uniqueness", "challenge correlation/supersession", "resolution/fence/revision history", "atomic rollback", "001-015 checksums unchanged"] }, null, 2), { mode: 0o600 });
    }
  } finally {
    await pool.end();
  }
});
