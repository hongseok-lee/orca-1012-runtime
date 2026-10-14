import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from "./connection.ts";
import { applyMigrations, readMigrations } from "./migrate.ts";

if (!(process.env.PGDATABASE ?? "").startsWith("orca_p122_schema_")) {
  throw new Error("Owned resource allocation schema DB required");
}
const pool = createDurablePool({ max: 2 });
const query = (sql: string, args: readonly unknown[] = []) =>
  withDurableTransaction(pool, (tx) => tx.query(sql, args));
const reject = (promise: Promise<unknown>, code = "23514") =>
  assert.rejects(promise, (error: unknown) => error instanceof DurableDatabaseError && error.code === code);

await test("019 actual PG original resource plans composite FK revision history dedup and rollback", async () => {
  try {
    const migrations = await readMigrations(fileURLToPath(new URL("./migrations/", import.meta.url)));
    assert.equal(migrations.length, 19);
    const ledger = await applyMigrations(pool, migrations);
    assert.deepEqual(ledger.map(({ version, checksum }) => ({ version, checksum })),
      migrations.map(({ version, checksum }) => ({ version, checksum })));
    for (const relation of ["resource_policy_versions", "resource_budget_scopes", "resource_unit_state", "resource_operation_plans", "resource_growth_ledger", "resource_reservation_accounting"]) {
      assert.equal((await query(`SELECT count(*)::integer AS count FROM durable_runtime.${relation}`)).rows[0].count, 0);
    }
    const policySql = "INSERT INTO durable_runtime.resource_policy_versions(policy_revision,policy,policy_digest) VALUES(9,$1,repeat('a',64))";
    for (const policy of [{ revision: 9 }, { revision: "09" }, { revision: "8" }, {}]) {
      await reject(query(policySql, [policy]));
    }
    await query(policySql, [{ revision: "9", syntheticFixture: true }]);
    await reject(query("UPDATE durable_runtime.resource_policy_versions SET policy_digest=repeat('b',64) WHERE policy_revision=9"));
    await reject(query("DELETE FROM durable_runtime.resource_policy_versions WHERE policy_revision=9"));
    const scope = `synthetic-scope:${randomUUID()}`, otherScope = `synthetic-scope:${randomUUID()}`;
    const scopeSql = "INSERT INTO durable_runtime.resource_budget_scopes(scope,dataset_name,budget_domain_id,memory_limit_bytes,cpu_limit_millicores,configuration,evidence_ref) VALUES($1,$2,$3,$4,10000,$5,'synthetic-budget-evidence')";
    await reject(query(scopeSql, [scope, "synthetic-missing-dataset", "synthetic-shared-domain", "9007199254740993", {}]), "23503");
    await query(scopeSql, [scope, "orca-1012-dev-v1", "synthetic-shared-domain", "9007199254740993", {}]);
    await reject(query(scopeSql, [otherScope, "orca-1012-dev-v1", "synthetic-shared-domain", "9007199254740993", {}]), "23505");
    await query(scopeSql, [otherScope, "orca-1012-dev-v1", "synthetic-other-domain", "1024", {}]);
    assert.equal((await query("SELECT memory_limit_bytes FROM durable_runtime.resource_budget_scopes WHERE scope=$1", [scope])).rows[0].memory_limit_bytes, "9007199254740993");
    await reject(query("UPDATE durable_runtime.resource_budget_scopes SET memory_limit_bytes=-1,revision=1 WHERE scope=$1", [scope]));
    await reject(query("UPDATE durable_runtime.resource_budget_scopes SET memory_limit_bytes=$2,revision=1 WHERE scope=$1", [scope, "9223372036854775808"]), "22003");
    await reject(query("UPDATE durable_runtime.resource_budget_scopes SET memory_limit_bytes=1024 WHERE scope=$1", [scope]));
    assert.equal((await query("UPDATE durable_runtime.resource_budget_scopes SET configuration=$2,revision=1 WHERE scope=$1 AND revision=0", [scope, { syntheticChangedConfiguration: true }])).rowCount, 1);
    assert.equal((await query("UPDATE durable_runtime.resource_budget_scopes SET revision=2 WHERE scope=$1 AND revision=0", [scope])).rowCount, 0);
    await reject(query("UPDATE durable_runtime.resource_budget_scopes SET revision=0 WHERE scope=$1", [scope]));
    await reject(query("UPDATE durable_runtime.resource_budget_scopes SET budget_domain_id='synthetic-new-domain',revision=2 WHERE scope=$1", [scope]));

    const units = [randomUUID(), randomUUID()], attempts = [randomUUID(), randomUUID()],
      incidents = [randomUUID(), randomUUID()], episodes = [randomUUID(), randomUUID()], operations = [randomUUID(), randomUUID()];
    const lease = `synthetic-resource-controller:${randomUUID()}`;
    await withDurableTransaction(pool, async (tx) => {
      await tx.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,'synthetic-owner',1,clock_timestamp()+interval '1 hour')", [lease]);
      for (let i = 0; i < units.length; i++) {
        await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase,execution_epoch) VALUES($1,'RUNNING','ABSENT',1)", [units[i]]);
        await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0),($1,1,$2,9)", [units[i], { syntheticShape: "target-profile" }]);
        await tx.query("INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,resource_profile_revision,effective_resources,status) VALUES($1,$2,1,'COLD',0,'{}','synthetic-status')", [attempts[i], units[i]]);
        await tx.query("INSERT INTO durable_runtime.failure_incidents(id,runtime_unit_id,attempt_id,pod_uid,container_id,restart_identity,evidence_key,classification,evidence_refs,observed_at) VALUES($1,$2,$3,'synthetic-pod','synthetic-container','synthetic-restart',$4,'OTHER_TERMINATION','{}',clock_timestamp())", [incidents[i], units[i], attempts[i], `synthetic-evidence:${incidents[i]}`]);
        await tx.query("INSERT INTO durable_runtime.recovery_episodes(id,runtime_unit_id,trigger_incident_id,state,started_at) VALUES($1,$2,$3,'synthetic-original-state',clock_timestamp())", [episodes[i], units[i], incidents[i]]);
        await tx.query("INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,execution_epoch) VALUES($1,$2,'GROW',0,$3,1,'RESOURCE_WAIT',1)", [operations[i], units[i], lease]);
      }
    });
    const originalProfile = (await query("SELECT * FROM durable_runtime.resource_profiles WHERE runtime_unit_id=$1 AND revision=0", [units[0]])).rows[0];
    assert.deepEqual(originalProfile.container_resources, {});
    assert.equal(originalProfile.policy_revision, "0");
    assert.equal((await query("SELECT policy_revision FROM durable_runtime.resource_policy_versions WHERE policy_revision=0")).rowCount, 0);
    await reject(query("UPDATE durable_runtime.resource_profiles SET container_resources=$2 WHERE runtime_unit_id=$1 AND revision=1", [units[0], { changed: true }]));
    await query("UPDATE durable_runtime.resource_profiles SET learned_memory_floor=64 WHERE runtime_unit_id=$1 AND revision=1", [units[0]]);
    await reject(query("INSERT INTO durable_runtime.recovery_episodes(id,runtime_unit_id,trigger_incident_id,state,started_at) VALUES($1,$2,$3,'synthetic-duplicate',clock_timestamp())", [randomUUID(), units[0], incidents[0]]), "23505");
    await reject(query("UPDATE durable_runtime.recovery_episodes SET started_at=started_at+interval '1 second' WHERE id=$1", [episodes[0]]));
    await reject(query("UPDATE durable_runtime.recovery_episodes SET trigger_incident_id=$2 WHERE id=$1", [episodes[0], incidents[1]]));

    const headSql = "INSERT INTO durable_runtime.resource_unit_state(runtime_unit_id,budget_scope,approved_profile_revision,desired_profile_revision,policy_revision,current_episode_id,breaker,accounted_memory_bytes,accounted_cpu_millicores,accounting_evidence_ref) VALUES($1,$2,0,$3,9,$4,'CLOSED',64,100,'synthetic-accounting-evidence')";
    await reject(query(headSql, [units[0], scope, "99", episodes[0]]), "23503");
    await reject(query(headSql, [units[0], scope, "1", episodes[1]]), "23503");
    for (let i = 0; i < units.length; i++) { await query(headSql, [units[i], scope, "1", episodes[i]]); }
    await reject(query("UPDATE durable_runtime.resource_unit_state SET accounted_memory_bytes=0 WHERE runtime_unit_id=$1", [units[0]]));
    await reject(query("UPDATE durable_runtime.resource_unit_state SET budget_scope=$2,revision=1 WHERE runtime_unit_id=$1", [units[0], otherScope]));
    assert.equal((await query("UPDATE durable_runtime.resource_unit_state SET last_oom_at=clock_timestamp(),revision=1 WHERE runtime_unit_id=$1 AND revision=0", [units[0]])).rowCount, 1);
    assert.equal((await query("UPDATE durable_runtime.resource_unit_state SET revision=2 WHERE runtime_unit_id=$1 AND revision=0", [units[0]])).rowCount, 0);
    await reject(query("UPDATE durable_runtime.resource_unit_state SET revision=0 WHERE runtime_unit_id=$1", [units[0]]));
    const head = (await query("SELECT * FROM durable_runtime.resource_unit_state WHERE runtime_unit_id=$1", [units[0]])).rows[0];
    assert.equal(head.approved_profile_revision, "0"); assert.equal(head.desired_profile_revision, "1");
    assert.equal(head.accounted_memory_bytes, "64");

    const planSql = "INSERT INTO durable_runtime.resource_operation_plans(operation_id,runtime_unit_id,kind,incident_id,episode_id,attempt_id,execution_epoch,policy_revision,previous_profile_revision,target_profile_revision,intent_revision,workload_profile_key,target_pod_shape,spec_digest,facts,facts_digest) VALUES($1,$2,'GROW',$3,$4,$5,$6,9,0,$7,0,'synthetic-workload',$8,repeat('a',64),$9,repeat('b',64))";
    const planArgs = (i: number): unknown[] => [operations[i], units[i], incidents[i], episodes[i], attempts[i], "1", "1", { syntheticWholePodShape: true }, { syntheticFacts: true }];
    for (const [index, value] of [[0, operations[1]], [2, incidents[1]], [3, episodes[1]], [4, attempts[1]], [5, "2"], [6, "99"]] as const) {
      const wrong = planArgs(0); wrong[index] = value;
      await reject(query(planSql, wrong), "23503");
    }
    await query(planSql, planArgs(0)); await query(planSql, planArgs(1));
    await reject(query(planSql, planArgs(0)), "23505");
    const duplicateOperation = randomUUID();
    await query("INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,execution_epoch) VALUES($1,$2,'GROW',0,$3,1,'RESOURCE_WAIT',1)", [duplicateOperation, units[0], lease]);
    const duplicateIncident = planArgs(0); duplicateIncident[0] = duplicateOperation;
    await reject(query(planSql, duplicateIncident), "23505");
    await reject(query("UPDATE durable_runtime.resource_operation_plans SET target_pod_shape='{}' WHERE operation_id=$1", [operations[0]]));
    await reject(query("DELETE FROM durable_runtime.resource_operation_plans WHERE operation_id=$1", [operations[0]]));
    const chargeSql = "INSERT INTO durable_runtime.resource_growth_ledger(operation_id,runtime_unit_id,episode_id,charge_kind) VALUES($1,$2,$3,$4)";
    await reject(query(chargeSql, [operations[0], units[1], episodes[1], "GROW"]), "23503");
    await reject(query(chargeSql, [operations[0], units[0], episodes[1], "GROW"]), "23503");
    await reject(query(chargeSql, [operations[0], units[0], episodes[0], "REPLACE"]), "23503");
    await query(chargeSql, [operations[0], units[0], episodes[0], "GROW"]);
    await reject(query(chargeSql, [operations[0], units[0], episodes[0], "GROW"]), "23505");
    await query("UPDATE durable_runtime.recovery_episodes SET growth_count=1,replacement_count=1 WHERE id=$1", [episodes[0]]);
    await reject(query("UPDATE durable_runtime.recovery_episodes SET growth_count=0 WHERE id=$1", [episodes[0]]));
    await reject(query("UPDATE durable_runtime.recovery_episodes SET replacement_count=0 WHERE id=$1", [episodes[0]]));
    await reject(query("UPDATE durable_runtime.resource_growth_ledger SET charged_at=charged_at+interval '1 day' WHERE operation_id=$1", [operations[0]]));
    const replacement = planArgs(0); replacement[0] = duplicateOperation; replacement[2] = null;
    await query(planSql.replace("'GROW'", "'REPLACE'"), replacement);
    await query(chargeSql, [duplicateOperation, units[0], episodes[0], "REPLACE"]);
    await query("UPDATE durable_runtime.recovery_episodes SET replacement_count=2 WHERE id=$1", [episodes[0]]);
    assert.equal((await query("SELECT count(*)::text AS count FROM durable_runtime.resource_growth_ledger WHERE runtime_unit_id=$1 AND charge_kind='GROW' AND charged_at>=clock_timestamp()-interval '24 hours'", [units[0]])).rows[0].count, "1");

    const reservationSql = "INSERT INTO durable_runtime.resource_reservations(operation_id,runtime_unit_id,resource_profile_revision,resource_delta,state,expires_at) VALUES($1,$2,$3,'{}','RESERVED',clock_timestamp()-interval '1 minute')";
    await query(reservationSql, [operations[0], units[0], "1"]);
    const accountingSql = "INSERT INTO durable_runtime.resource_reservation_accounting(operation_id,runtime_unit_id,resource_profile_revision,budget_scope,steady_memory_bytes,steady_cpu_millicores,overlap_memory_bytes,overlap_cpu_millicores,protected_memory_bytes,protected_cpu_millicores,additional_memory_charge_bytes,additional_cpu_charge_millicores,facts,facts_digest,spec_digest) VALUES($1,$2,$3,$4,128,200,192,300,128,200,128,200,'{}',repeat('b',64),repeat('a',64))";
    await reject(query(accountingSql, [operations[0], units[0], "0", scope]), "23503");
    await reject(query(accountingSql, [operations[0], units[0], "1", otherScope]), "23503");
    await query(accountingSql, [operations[0], units[0], "1", scope]);
    await reject(query(accountingSql, [operations[0], units[0], "1", scope]), "23505");
    await reject(query("UPDATE durable_runtime.resource_reservation_accounting SET additional_memory_charge_bytes=0 WHERE operation_id=$1", [operations[0]]));
    await reject(query("DELETE FROM durable_runtime.resource_reservation_accounting WHERE operation_id=$1", [operations[0]]));
    await reject(query("UPDATE durable_runtime.resource_reservations SET expires_at=clock_timestamp()+interval '1 hour' WHERE operation_id=$1", [operations[0]]));
    assert.equal((await query("SELECT state FROM durable_runtime.resource_reservations WHERE operation_id=$1 AND expires_at<clock_timestamp()", [operations[0]])).rows[0].state, "RESERVED");

    const originalEpisode = (await query("SELECT * FROM durable_runtime.recovery_episodes WHERE id=$1", [episodes[0]])).rows[0];
    const rollbackOperation = randomUUID(); let rollbackBarrierReached = false;
    await assert.rejects(withDurableTransaction(pool, async (tx) => {
      await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,2,'{}',9)", [units[0]]);
      await tx.query("INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,execution_epoch) VALUES($1,$2,'GROW',0,$3,1,'RESERVED',1)", [rollbackOperation, units[0], lease]);
      const rollbackPlan = planArgs(0); rollbackPlan[0] = rollbackOperation; rollbackPlan[2] = null; rollbackPlan[6] = "2";
      await tx.query(planSql, rollbackPlan);
      await tx.query(reservationSql, [rollbackOperation, units[0], "2"]);
      await tx.query(accountingSql, [rollbackOperation, units[0], "2", scope]);
      await tx.query(chargeSql, [rollbackOperation, units[0], episodes[0], "GROW"]);
      await tx.query("UPDATE durable_runtime.recovery_episodes SET growth_count=2,replacement_count=3 WHERE id=$1", [episodes[0]]);
      await tx.query("UPDATE durable_runtime.resource_unit_state SET desired_profile_revision=2,revision=2 WHERE runtime_unit_id=$1", [units[0]]);
      rollbackBarrierReached = true; throw new Error("synthetic rollback barrier");
    }));
    assert.equal(rollbackBarrierReached, true);
    for (const relation of ["resource_operation_plans", "resource_growth_ledger", "resource_reservations", "resource_reservation_accounting"]) {
      assert.equal((await query(`SELECT operation_id FROM durable_runtime.${relation} WHERE operation_id=$1`, [rollbackOperation])).rowCount, 0);
    }
    assert.equal((await query("SELECT id FROM durable_runtime.operations WHERE id=$1", [rollbackOperation])).rowCount, 0);
    assert.equal((await query("SELECT revision FROM durable_runtime.resource_profiles WHERE runtime_unit_id=$1 AND revision=2", [units[0]])).rowCount, 0);
    assert.deepEqual((await query("SELECT * FROM durable_runtime.resource_unit_state WHERE runtime_unit_id=$1", [units[0]])).rows[0], head);
    assert.deepEqual((await query("SELECT * FROM durable_runtime.recovery_episodes WHERE id=$1", [episodes[0]])).rows[0], originalEpisode);
    assert.deepEqual((await query("SELECT * FROM durable_runtime.resource_profiles WHERE runtime_unit_id=$1 AND revision=0", [units[0]])).rows[0], originalProfile);
    assert.deepEqual((await query("SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version")).rows, ledger);
    if (process.env.SCHEMA_RESULTS_PATH) {
      await writeFile(process.env.SCHEMA_RESULTS_PATH, JSON.stringify({ distinct_tests: 1, passed: 1, failed: 0, skipped: 0,
        schema_source: "730850ee335c41290af38ea8825484b5f4cc0b6f", migration_chain: ledger, synthetic_fixture: true, rollback_barrier_reached: rollbackBarrierReached,
        scope: "복합 FK, identity, revision, 중복 및 rollback의 schema 제약만 검증합니다.", dev019_applied: false,
        unverified: "Rank 11 공유 예산 경합, 소비 정책·cap·receipt·lease·admission과 실제 적용은 미검증입니다." }, null, 2), { mode: 0o600 });
    }
  } finally { await pool.end(); }
});
