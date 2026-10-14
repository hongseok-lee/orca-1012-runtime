import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from "./connection.ts";
import { applyMigrations, readMigrations } from "./migrate.ts";

if (!(process.env.PGDATABASE ?? "").startsWith("orca_p107_")) {
  throw new Error("Owned context schema DB required");
}
const pool = createDurablePool({ max: 2 });
const query = (sql: string, args: readonly unknown[] = []) =>
  withDurableTransaction(pool, (tx) => tx.query(sql, args));
const reject = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (e: unknown) => e instanceof DurableDatabaseError && e.code === code);

await test("013 actual PG context proof identity original history and nondecreasing revision", async () => {
  try {
    await applyMigrations(
      pool,
      await readMigrations(fileURLToPath(new URL("./migrations/", import.meta.url))),
    );
    assert.equal(
      (await query("SELECT current_setting('search_path') AS path")).rows[0].path,
      '"$user", public',
    );
    const workspace = randomUUID(),
      agent = randomUUID(),
      session = randomUUID(),
      unit = randomUUID(),
      attempt = randomUUID(),
      context = randomUUID(),
      proof = randomUUID();
    await withDurableTransaction(pool, async (tx) => {
      await tx.query(
        "INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'synthetic','READY')",
        [workspace, workspace],
      );
      await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'synthetic')", [
        agent,
      ]);
      await tx.query(
        "INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle,context_revision,provider_binding_revision) VALUES($1,$2,$3,'OPEN',2,3)",
        [session, agent, workspace],
      );
      await tx.query(
        "INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','READY')",
        [unit],
      );
      await tx.query(
        "INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0)",
        [unit],
      );
      await tx.query(
        "INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,resource_profile_revision,effective_resources,status) VALUES($1,$2,0,'COLD','synthetic-pod',0,'{}','READY')",
        [attempt, unit],
      );
      // The existing queue context INSERT shape remains valid. No queue algorithm is exercised.
      await tx.query(
        "INSERT INTO durable_runtime.session_context_records(id,session_id,revision,kind,body_ref,provider_delivery_evidence) VALUES($1,$2,2,'FAILED',$3,$4)",
        [context, session, { synthetic: true }, { legacy: true }],
      );
    });
    const insert =
      "INSERT INTO durable_runtime.provider_context_deliveries(id,session_id,context_revision,context_hash,provider_binding_revision,runtime_unit_id,attempt_id,pod_uid,execution_epoch,provider,native_session_ref,native_turn_id,evidence_ref,source,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'synthetic','synthetic-session',NULL,$10,'synthetic-schema', $11)";
    const values = (
      id: string,
      revision = 2,
      hash = "a".repeat(64),
      binding = 3,
      pod = "synthetic-pod",
      epoch = 0,
      evidence = "synthetic-proof",
    ) => [
      id,
      session,
      revision,
      hash,
      binding,
      unit,
      attempt,
      pod,
      epoch,
      evidence,
      new Date("2026-10-13T03:00:00Z"),
    ];
    await query(insert, values(proof));
    await reject(query(insert, values(randomUUID())), "23505");
    await reject(query(insert, values(randomUUID(), 2, "b".repeat(64), 3, "wrong-pod")), "23503");
    await reject(
      query(insert, values(randomUUID(), 2, "b".repeat(64), 3, "synthetic-pod", 1)),
      "23503",
    );
    const invalidUnit = values(randomUUID(), 2, "b".repeat(64));
    invalidUnit[5] = randomUUID();
    await reject(query(insert, invalidUnit), "23503");
    const invalidSession = values(randomUUID(), 2, "b".repeat(64));
    invalidSession[1] = randomUUID();
    await reject(query(insert, invalidSession), "23503");
    await reject(query(insert, values(randomUUID(), -1, "b".repeat(64))), "23514");
    await reject(query(insert, values(randomUUID(), 2, "invalid")), "23514");
    await reject(query(insert, values(randomUUID(), 2, "b".repeat(64), -1)), "23514");
    await reject(
      query(insert, values(randomUUID(), 2, "b".repeat(64), 3, "synthetic-pod", 0, "")),
      "23514",
    );
    await reject(
      query(
        "UPDATE durable_runtime.provider_context_deliveries SET evidence_ref='replacement' WHERE id=$1",
        [proof],
      ),
      "23514",
    );
    await reject(
      query("DELETE FROM durable_runtime.provider_context_deliveries WHERE id=$1", [proof]),
      "23514",
    );
    await reject(
      query("UPDATE durable_runtime.session_context_records SET body_ref='{}' WHERE id=$1", [
        context,
      ]),
      "23514",
    );
    await reject(
      query(
        "UPDATE durable_runtime.session_context_records SET provider_delivery_evidence='{}' WHERE id=$1",
        [context],
      ),
      "23514",
    );
    await reject(
      query("DELETE FROM durable_runtime.session_context_records WHERE id=$1", [context]),
      "23514",
    );
    await query("UPDATE durable_runtime.sessions SET context_revision=3 WHERE id=$1", [session]);
    await reject(
      query("UPDATE durable_runtime.sessions SET context_revision=2 WHERE id=$1", [session]),
      "23514",
    );
    // Old binding evidence is historical, not proof that the current binding is satisfied.
    await query(insert, values(randomUUID(), 2, "a".repeat(64), 1));
    const original = (
      await query(
        "SELECT context_revision,provider_binding_revision,native_turn_id,evidence_ref FROM durable_runtime.provider_context_deliveries WHERE id=$1",
        [proof],
      )
    ).rows[0];
    assert.deepEqual(original, {
      context_revision: "2",
      provider_binding_revision: "3",
      native_turn_id: null,
      evidence_ref: "synthetic-proof",
    });
    const state = (
      await query(
        "SELECT context_revision,provider_binding_revision FROM durable_runtime.sessions WHERE id=$1",
        [session],
      )
    ).rows[0];
    assert.deepEqual(state, { context_revision: "3", provider_binding_revision: "3" });
    assert.equal(
      (
        await query(
          "SELECT count(*)::text AS count FROM durable_runtime.provider_context_deliveries WHERE session_id=$1",
          [session],
        )
      ).rows[0].count,
      "2",
    );
  } finally {
    await pool.end();
  }
});
