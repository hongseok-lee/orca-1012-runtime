import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from "./connection.ts";
import { applyMigrations, readMigrations } from "./migrate.ts";
if (!(process.env.PGDATABASE ?? "").startsWith("orca_p112_")) {
  throw new Error("Owned producer schema DB required");
}
const pool = createDurablePool({ max: 3 });
const query = (sql: string, args: readonly unknown[] = []) =>
  withDurableTransaction(pool, (tx) => tx.query(sql, args));
const reject = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (e: unknown) => e instanceof DurableDatabaseError && e.code === code);
await test("011 actual PG producer binding claim budget and original-transaction target constraints", async () => {
  try {
    await applyMigrations(
      pool,
      await readMigrations(fileURLToPath(new URL("./migrations/", import.meta.url))),
    );
    const workspace = randomUUID(),
      agent = randomUUID(),
      session = randomUUID(),
      unit = randomUUID(),
      attempt = randomUUID(),
      binding = randomUUID(),
      producer = randomUUID(),
      event = randomUUID();
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
      await tx.query(
        "INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES('synthetic',$1)",
        [unit],
      );
      await tx.query(
        "INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state) VALUES($1,'synthetic',$2,$3,'AVAILABLE')",
        [binding, unit, `/synthetic/${unit}`],
      );
      await tx.query(
        "INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)",
        [unit, session, binding],
      );
    });
    const register =
      "INSERT INTO durable_runtime.runtime_event_producers(producer_id,incarnation,agent_id,runtime_unit_id,attempt_id,pod_uid,execution_epoch) VALUES($1,'inc-one',$2,$3,$4,$5,0)";
    await reject(query(register, [randomUUID(), agent, unit, attempt, "wrong-pod"]), "23503");
    await query(register, [producer, agent, unit, attempt, "synthetic-pod"]);
    await reject(
      query(
        "UPDATE durable_runtime.runtime_event_producers SET pod_uid='other' WHERE producer_id=$1",
        [producer],
      ),
      "23514",
    );
    await reject(
      query(
        "UPDATE durable_runtime.runtime_event_producers SET processed_through=1 WHERE producer_id=$1",
        [producer],
      ),
      "23514",
    );
    await query(
      "UPDATE durable_runtime.runtime_event_producers SET committed_through=1,revision=1 WHERE producer_id=$1",
      [producer],
    );
    await reject(
      query(
        "UPDATE durable_runtime.runtime_event_producers SET committed_through=0 WHERE producer_id=$1",
        [producer],
      ),
      "23514",
    );
    const enqueue =
      "INSERT INTO durable_runtime.runtime_event_queue(event_id,producer_id,incarnation,producer_seq,agent_id,payload,state) VALUES($1,$2,'inc-one',1,$3,'{}','PENDING')";
    await withDurableTransaction(pool, async (tx) => {
      await tx.query(enqueue, [event, producer, agent]);
      await tx.query(
        "INSERT INTO durable_runtime.runtime_event_targets(event_id,session_id,agent_id) VALUES($1,$2,$3)",
        [event, session, agent],
      );
    });
    await reject(
      query(
        "INSERT INTO durable_runtime.runtime_event_targets(event_id,session_id,agent_id) VALUES($1,$2,$3)",
        [event, session, agent],
      ),
      "23514",
    );
    await reject(
      query("UPDATE durable_runtime.runtime_event_queue SET state='PROCESSING' WHERE event_id=$1", [
        event,
      ]),
      "23514",
    );
    await query(
      "UPDATE durable_runtime.runtime_event_queue SET state='PROCESSING',attempt_count=6,retry_count=5,claim_owner='synthetic-controller',claim_controller_term=1,claim_token=$2,claim_expires_at=clock_timestamp()+interval '1 minute' WHERE event_id=$1",
      [event, randomUUID()],
    );
    await query(
      "UPDATE durable_runtime.runtime_event_queue SET state='RETRY',claim_owner=NULL,claim_controller_term=NULL,claim_token=NULL,claim_expires_at=NULL WHERE event_id=$1",
      [event],
    );
    await reject(
      query(
        "UPDATE durable_runtime.runtime_event_queue SET attempt_count=0,retry_count=0 WHERE event_id=$1",
        [event],
      ),
      "23514",
    );
    const row = (
      await query(
        "SELECT attempt_count,retry_count,enqueue_transaction_id FROM durable_runtime.runtime_event_queue WHERE event_id=$1",
        [event],
      )
    ).rows[0];
    assert.equal(row.attempt_count, "6");
    assert.equal(row.retry_count, "5");
    assert.equal(typeof row.enqueue_transaction_id, "string");
  } finally {
    await pool.end();
  }
});
