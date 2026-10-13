import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { counter, incrementCounter, logicalId } from "../../../shared/durable-runtime/identity.ts";
import {
  advanceOperationStep,
  advanceSessionFence,
  advanceStorageEpoch,
  claimExecutionAttempt,
  renewControllerLease,
  revokeExecutionGrant,
} from "./cas.ts";
import {
  createDurablePool,
  DurableDatabaseError,
  safeDatabaseError,
  withDurableTransaction,
} from "./connection.ts";
import { lockAggregates } from "./locks.ts";
import { applyMigrations, readMigrations } from "./migrate.ts";

const hash = "a".repeat(64);
const database = process.env.PGDATABASE;
if (!database || !/^orca_p102_[a-z0-9_]+$/.test(database)) {
  throw new Error("Explicit worker-owned PG test database required");
}
const pool = createDurablePool({ max: 8, application_name: "orca-p1-02-test" });
const migrations = await readMigrations(fileURLToPath(new URL("./migrations/", import.meta.url)));
const id = () => randomUUID();
const query = (sql: string, values: readonly unknown[] = []) =>
  withDurableTransaction(pool, (tx) => tx.query(sql, values));

async function rejectCode(operation: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) => error instanceof DurableDatabaseError && error.code === code,
  );
}

async function fixture() {
  const workspace = id(),
    agent = id(),
    unit = id(),
    attempt = id(),
    nextAttempt = id(),
    sessions = [id(), id(), id()];
  const bindings = [id(), id(), id()],
    exportId = id(),
    base = `/agents/${unit}`;
  await withDurableTransaction(pool, async (tx) => {
    await tx.query(
      "INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'test','READY')",
      [workspace, `alias-${workspace}`],
    );
    await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'synthetic')", [
      agent,
    ]);
    await tx.query(
      "INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','READY')",
      [unit],
    );
    await tx.query(
      "INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0)",
      [unit],
    );
    await tx.query(
      "INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,resource_profile_revision,effective_resources,pod_uid,status) VALUES($1,$2,0,'COLD',0,'{}','synthetic-pod','READY'),($3,$2,1,'COLD',0,'{}','next-synthetic-pod','READY')",
      [attempt, unit, nextAttempt],
    );
    await tx.query("UPDATE durable_runtime.runtime_units SET active_attempt_id=$2 WHERE id=$1", [
      unit,
      attempt,
    ]);
    await tx.query(
      "INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES('synthetic',$1)",
      [exportId],
    );
    for (let n = 0; n < 3; n++) {
      await tx.query(
        "INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')",
        [sessions[n], agent, workspace],
      );
      await tx.query(
        "INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,identity_proof_ref,identity_verified_at,access_state) VALUES($1,'synthetic',$2,$3,'synthetic-normalization-proof',clock_timestamp(),'AVAILABLE')",
        [bindings[n], exportId, n === 2 ? base : base + (n === 0 ? "/a" : "/ab")],
      );
      await tx.query(
        "INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)",
        [unit, sessions[n], bindings[n]],
      );
    }
  });
  return { workspace, agent, unit, attempt, nextAttempt, sessions, bindings, exportId };
}

async function message(session: string, sequence = 1) {
  const messageId = id();
  await query(
    "INSERT INTO durable_runtime.messages(id,session_id,seq,body_or_blob_ref,intake_status) VALUES($1,$2,$3,'{}','DURABLE')",
    [messageId, session, sequence],
  );
  return messageId;
}

async function oneWinner(writes: readonly (() => Promise<unknown>)[], expectedCode = "23505") {
  const outcomes = await Promise.allSettled(writes.map((write) => write()));
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      assert.ok(outcome.reason instanceof DurableDatabaseError);
      assert.equal(outcome.reason.code, expectedCode);
    }
  }
}

await test("P1-02 actual PostgreSQL invariants", async (t) => {
  try {
    await applyMigrations(pool, migrations);
    const previouslyPassed = new Set([
      "explicit migration apply/reapply and changed applied checksum rejection",
      "migration error rolls back both DDL and version ledger",
      "receipt concurrent key conflict, nonnullable scope and immutable result",
      "precision-safe BIGINT and redacted database errors",
    ]);
    const run = (name: string, body: () => Promise<void>) =>
      t.test(
        name,
        {
          skip:
            (process.env.DURABLE_DB_FOCUS === "remaining" && previouslyPassed.has(name)) ||
            (!!process.env.DURABLE_DB_ONLY && process.env.DURABLE_DB_ONLY !== name),
        },
        body,
      );
    await run(
      "explicit migration apply/reapply and changed applied checksum rejection",
      async () => {
        assert.equal((await applyMigrations(pool, migrations)).length, migrations.length);
        const changed = migrations.map((migration, index) =>
          index
            ? migration
            : {
                ...migration,
                sql: `${migration.sql}\n-- changed`,
                checksum: createHash("sha256").update(`${migration.sql}\n-- changed`).digest("hex"),
              },
        );
        await rejectCode(applyMigrations(pool, changed), "MIGRATION_HISTORY_CONFLICT");
        assert.equal(
          (await query("SELECT count(*)::text AS count FROM durable_runtime.schema_migrations"))
            .rows[0].count,
          String(migrations.length),
        );
      },
    );
    await run("migration error rolls back both DDL and version ledger", async () => {
      const sql = "CREATE TABLE durable_runtime.failed_migration_probe(id uuid); SELECT 1/0;";
      await rejectCode(
        applyMigrations(pool, [
          ...migrations,
          {
            version: "007-rollback.sql",
            sql,
            checksum: createHash("sha256").update(sql).digest("hex"),
          },
        ]),
        "22012",
      );
      assert.equal(
        (await query("SELECT to_regclass('durable_runtime.failed_migration_probe') AS object"))
          .rows[0].object,
        null,
      );
    });
    await run(
      "default search_path and temporary shadow relations cannot redirect storage triggers",
      async () => {
        const f = await fixture();
        await withDurableTransaction(pool, async (tx) => {
          assert.equal((await tx.query("SHOW search_path")).rows[0].search_path, '"$user", public');
          await tx.query("CREATE TEMP TABLE storage_bindings (id uuid)");
          await tx.query("CREATE TEMP TABLE storage_domains (backend_id text)");
          await tx.query(
            "INSERT INTO durable_runtime.storage_write_grants(id,storage_binding_id,attempt_id,storage_epoch,state) VALUES($1,$2,$3,0,'ACTIVE')",
            [id(), f.bindings[0], f.attempt],
          );
        });
        const functions = await query(
          "SELECT p.proname,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='durable_runtime' AND p.prorettype='trigger'::regtype",
        );
        for (const row of functions.rows) {
          assert.ok(row.proconfig.includes("search_path=pg_catalog, durable_runtime, pg_temp"));
        }
      },
    );
    await run(
      "receipt concurrent key conflict, nonnullable scope and immutable result",
      async () => {
        const key = id(),
          values = ["synthetic", key, "send", key, hash];
        const sql =
          "INSERT INTO durable_runtime.rpc_receipts(principal_id,session_scope,method,operation_key,payload_hash,response) VALUES($1,$2,$3,$4,$5,'{}')";
        await oneWinner(Array.from({ length: 8 }, () => () => query(sql, values)));
        await rejectCode(query(sql, ["synthetic", null, "send", id(), hash]), "23502");
        await rejectCode(
          query("UPDATE durable_runtime.rpc_receipts SET response='[]' WHERE operation_key=$1", [
            key,
          ]),
          "23514",
        );
      },
    );
    await run("message/session sequence and original component sequence races", async () => {
      const f = await fixture(),
        sequence = 9;
      await oneWinner(
        Array.from(
          { length: 4 },
          () => () =>
            query(
              "INSERT INTO durable_runtime.messages(id,session_id,seq,body_or_blob_ref,intake_status) VALUES($1,$2,$3,'{}','DURABLE')",
              [id(), f.sessions[0], sequence],
            ),
        ),
      );
      const m = await message(f.sessions[1]);
      await oneWinner(
        Array.from(
          { length: 4 },
          () => () =>
            query(
              "INSERT INTO durable_runtime.input_components(id,message_id,session_id,input_seq,authenticated_sender,original_payload_hash,body_or_blob_ref) VALUES($1,$2,$3,1,'synthetic',$4,'{}')",
              [id(), m, f.sessions[1], hash],
            ),
        ),
      );
      await rejectCode(
        query("DELETE FROM durable_runtime.input_components WHERE message_id=$1", [m]),
        "23514",
      );
    });
    await run("canonical event and producer sequence identity races", async () => {
      const f = await fixture(),
        canonical = id(),
        producer = id();
      await oneWinner(
        Array.from(
          { length: 4 },
          (_, index) => () =>
            query(
              "INSERT INTO durable_runtime.session_events(session_id,journal_epoch,seq,event_id,source_key,body) VALUES($1,0,$2,$3,$4,'{}')",
              [f.sessions[0], index + 1, canonical, id()],
            ),
        ),
      );
      await oneWinner(
        Array.from(
          { length: 4 },
          () => () =>
            query(
              "INSERT INTO durable_runtime.runtime_event_queue(event_id,producer_id,incarnation,producer_seq,agent_id,payload,state) VALUES($1,$2,'synthetic',1,$3,'{}','PENDING')",
              [id(), producer, f.agent],
            ),
        ),
      );
    });
    await run("full transaction rollback leaves no message receipt or journal", async () => {
      const f = await fixture(),
        m = id(),
        e = id(),
        op = id();
      await rejectCode(
        withDurableTransaction(pool, async (tx) => {
          await tx.query(
            "INSERT INTO durable_runtime.messages(id,session_id,seq,body_or_blob_ref,intake_status) VALUES($1,$2,1,'{}','DURABLE')",
            [m, f.sessions[0]],
          );
          await tx.query(
            "INSERT INTO durable_runtime.rpc_receipts(principal_id,session_scope,method,operation_key,payload_hash,response) VALUES('synthetic',$1,'send',$2,$3,'{}')",
            [f.sessions[0], op, hash],
          );
          await tx.query(
            "INSERT INTO durable_runtime.session_events(session_id,journal_epoch,seq,event_id,source_key,body) VALUES($1,0,1,$2,$3,'{}')",
            [f.sessions[0], e, id()],
          );
          throw new DurableDatabaseError("EXPECTED_ROLLBACK");
        }),
        "EXPECTED_ROLLBACK",
      );
      assert.equal(
        (
          await query("SELECT count(*)::text AS count FROM durable_runtime.messages WHERE id=$1", [
            m,
          ])
        ).rows[0].count,
        "0",
      );
      assert.equal(
        (
          await query(
            "SELECT count(*)::text AS count FROM durable_runtime.rpc_receipts WHERE operation_key=$1",
            [op],
          )
        ).rows[0].count,
        "0",
      );
      assert.equal(
        (
          await query(
            "SELECT count(*)::text AS count FROM durable_runtime.session_events WHERE event_id=$1",
            [e],
          )
        ).rows[0].count,
        "0",
      );
    });
    await run(
      "cross-Session message/context/cancel and unrelated runtime attempt rejected by FK",
      async () => {
        const f = await fixture(),
          other = await fixture(),
          m = await message(f.sessions[0]);
        await rejectCode(
          query(
            "INSERT INTO durable_runtime.input_components(id,message_id,session_id,input_seq,authenticated_sender,original_payload_hash,body_or_blob_ref) VALUES($1,$2,$3,1,'synthetic',$4,'{}')",
            [id(), m, f.sessions[1], hash],
          ),
          "23503",
        );
        await rejectCode(
          query(
            "INSERT INTO durable_runtime.session_context_records(id,session_id,revision,kind,target_message_id,body_ref) VALUES($1,$2,1,'CANCEL',$3,'{}')",
            [id(), f.sessions[1], m],
          ),
          "23503",
        );
        await rejectCode(
          query(
            "INSERT INTO durable_runtime.delivery_attempts(id,message_id,session_id,runtime_unit_id,attempt_id,execution_epoch,state) VALUES($1,$2,$3,$4,$5,0,'STAGED')",
            [id(), m, f.sessions[0], f.unit, other.attempt],
          ),
          "23503",
        );
        await rejectCode(
          query(
            "INSERT INTO durable_runtime.cancel_intents(operation_id,session_id,target_message_id,target_message_revision,requested_by,requested_at,cancel_revision,interrupt_status,updated_at) VALUES($1,$2,$3,0,'synthetic',clock_timestamp(),1,'NOT_REQUIRED',clock_timestamp())",
            [id(), f.sessions[1], m],
          ),
          "23503",
        );
      },
    );
    await run("execution grant race, stale attempt and no proof-free revoke", async () => {
      const f = await fixture();
      await oneWinner(
        Array.from(
          { length: 4 },
          () => () =>
            query(
              "INSERT INTO durable_runtime.execution_grants(id,runtime_unit_id,attempt_id,execution_epoch,state) VALUES($1,$2,$3,0,'ACTIVE')",
              [id(), f.unit, f.attempt],
            ),
        ),
      );
      await rejectCode(
        query(
          "UPDATE durable_runtime.execution_grants SET state='REVOKED',revoked_at=clock_timestamp() WHERE runtime_unit_id=$1",
          [f.unit],
        ),
        "23514",
      );
      await rejectCode(
        query(
          "UPDATE durable_runtime.runtime_units SET execution_epoch=1,active_attempt_id=$2 WHERE id=$1",
          [f.unit, f.nextAttempt],
        ),
        "23514",
      );
      const stale = await fixture();
      await rejectCode(
        query(
          "INSERT INTO durable_runtime.execution_grants(id,runtime_unit_id,attempt_id,execution_epoch,state) VALUES($1,$2,$3,1,'ACTIVE')",
          [id(), stale.unit, stale.nextAttempt],
        ),
        "23514",
      );
    });
    await run(
      "RW same-domain race, overlapping ancestor race, /a versus /ab and multiple RO",
      async () => {
        const f = await fixture();
        const write = (binding: string) =>
          query(
            "INSERT INTO durable_runtime.storage_write_grants(id,storage_binding_id,attempt_id,storage_epoch,state) VALUES($1,$2,$3,0,'ACTIVE')",
            [id(), binding, f.attempt],
          );
        await oneWinner([() => write(f.bindings[0]), () => write(f.bindings[2])]);
        const sibling = await fixture();
        for (const binding of sibling.bindings.slice(0, 2)) {
          await query(
            "INSERT INTO durable_runtime.storage_write_grants(id,storage_binding_id,attempt_id,storage_epoch,state) VALUES($1,$2,$3,0,'ACTIVE')",
            [id(), binding, sibling.attempt],
          );
        }
        await rejectCode(
          query(
            "INSERT INTO durable_runtime.storage_write_grants(id,storage_binding_id,attempt_id,storage_epoch,state) VALUES($1,$2,$3,0,'ACTIVE')",
            [id(), sibling.bindings[0], sibling.attempt],
          ),
          "23505",
        );
        await rejectCode(
          query(
            "INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state) SELECT $1,backend_id,export_id,canonical_directory,access_state FROM durable_runtime.storage_bindings WHERE id=$2",
            [id(), sibling.bindings[0]],
          ),
          "23505",
        );
        await rejectCode(
          query(
            "UPDATE durable_runtime.storage_write_grants SET state='REVOKED',revoked_at=clock_timestamp() WHERE storage_binding_id=$1",
            [sibling.bindings[0]],
          ),
          "23514",
        );
        await rejectCode(
          query("UPDATE durable_runtime.storage_bindings SET epoch=1 WHERE id=$1", [
            sibling.bindings[0],
          ]),
          "23514",
        );
        for (let n = 0; n < 2; n++) {
          await query(
            "INSERT INTO durable_runtime.storage_mounts(id,storage_binding_id,attempt_id,pod_uid,mode,desired_state,observed_state,grant_epoch) VALUES($1,$2,$3,'synthetic-pod','RO','ACTIVE','ACTIVE',0)",
            [id(), sibling.bindings[0], sibling.attempt],
          );
        }
        const unverified = await fixture();
        await query(
          "UPDATE durable_runtime.storage_bindings SET identity_verified_at=NULL,identity_proof_ref=NULL WHERE id=$1",
          [unverified.bindings[0]],
        );
        await rejectCode(
          query(
            "INSERT INTO durable_runtime.storage_write_grants(id,storage_binding_id,attempt_id,storage_epoch,state) VALUES($1,$2,$3,0,'ACTIVE')",
            [id(), unverified.bindings[0], unverified.attempt],
          ),
          "23514",
        );
      },
    );
    await run("independent epoch/fence/term CAS and stable logical identity", async () => {
      const f = await fixture(),
        sessionId = logicalId("session", f.sessions[0]),
        unitId = logicalId("runtime-unit", f.unit);
      await withDurableTransaction(pool, async (tx) => {
        await lockAggregates(tx, { sessionIds: [sessionId], runtimeUnitIds: [unitId] });
        await advanceSessionFence(tx, {
          sessionId,
          expectedFence: counter("session-fence", 0n),
          expectedRevision: counter("row:session", 0n),
          nextFence: counter("session-fence", 1n),
        });
        await claimExecutionAttempt(tx, {
          runtimeUnitId: unitId,
          expectedEpoch: counter("execution-epoch", 0n),
          expectedIntentRevision: counter("intent-revision", 0n),
          expectedRevision: counter("row:runtime-unit", 0n),
          nextEpoch: counter("execution-epoch", 1n),
          attemptId: logicalId("attempt", f.nextAttempt),
        });
      });
      await rejectCode(
        withDurableTransaction(pool, (tx) =>
          advanceSessionFence(tx, {
            sessionId,
            expectedFence: counter("session-fence", 0n),
            expectedRevision: counter("row:session", 1n),
            nextFence: counter("session-fence", 2n),
          }),
        ),
        "STALE_CAS",
      );
      assert.equal(
        (await query("SELECT id FROM durable_runtime.sessions WHERE id=$1", [sessionId])).rows[0]
          .id,
        sessionId,
      );
      await query(
        "INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,'current',7,clock_timestamp()+interval '10 minutes')",
        [f.unit],
      );
      const operation = id();
      await query(
        "INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,execution_epoch,expected_pod_uid) VALUES($1,$2,'synthetic',0,$3,7,'START',1,'next-synthetic-pod')",
        [operation, f.unit, f.unit],
      );
      const command = {
        operationId: logicalId("operation", operation),
        runtimeUnitId: unitId,
        expectedIntentRevision: counter("intent-revision", 0n),
        executionEpoch: counter("execution-epoch", 1n),
        controllerScope: f.unit,
        controllerTerm: counter("controller-term", 7n),
        controllerOwner: "current",
        expectedUnitRevision: counter("row:runtime-unit", 1n),
        expectedStepRevision: counter("step-revision", 0n),
        expectedRevision: counter("row:operation", 0n),
        expectedPodUid: "next-synthetic-pod",
        nextStep: "NEXT",
      };
      await rejectCode(
        withDurableTransaction(pool, (tx) =>
          advanceOperationStep(tx, { ...command, controllerTerm: counter("controller-term", 6n) }),
        ),
        "STALE_CAS",
      );
      await rejectCode(
        withDurableTransaction(pool, (tx) =>
          advanceOperationStep(tx, { ...command, controllerOwner: "old" }),
        ),
        "STALE_CAS",
      );
      await withDurableTransaction(pool, (tx) => advanceOperationStep(tx, command));
      await rejectCode(
        withDurableTransaction(pool, (tx) => advanceOperationStep(tx, command)),
        "STALE_CAS",
      );
      await rejectCode(
        withDurableTransaction(pool, (tx) =>
          renewControllerLease(tx, {
            scope: f.unit,
            owner: "old",
            expectedTerm: counter("controller-term", 7n),
            expectedRevision: counter("row:controller", 0n),
            expiresAt: new Date(Date.now() + 600000),
          }),
        ),
        "STALE_CAS",
      );
      await withDurableTransaction(pool, (tx) =>
        advanceStorageEpoch(tx, {
          storageBindingId: logicalId("storage-binding", f.bindings[0]),
          domain: { backendId: "synthetic", exportId: f.exportId },
          expectedEpoch: counter("storage-epoch", 0n),
          expectedRevision: counter("row:storage-binding", 0n),
          nextEpoch: counter("storage-epoch", 1n),
        }),
      );
      await rejectCode(
        withDurableTransaction(pool, (tx) =>
          advanceStorageEpoch(tx, {
            storageBindingId: logicalId("storage-binding", f.bindings[0]),
            domain: { backendId: "synthetic", exportId: f.exportId },
            expectedEpoch: counter("storage-epoch", 0n),
            expectedRevision: counter("row:storage-binding", 1n),
            nextEpoch: counter("storage-epoch", 2n),
          }),
        ),
        "STALE_CAS",
      );
    });
    await run("stable lock ordering rejects reverse resource traversal", async () => {
      const f = await fixture();
      await rejectCode(
        withDurableTransaction(pool, async (tx) => {
          await lockAggregates(tx, { runtimeUnitIds: [logicalId("runtime-unit", f.unit)] });
          await lockAggregates(tx, { sessionIds: [logicalId("session", f.sessions[0])] });
        }),
        "LOCK_ORDER",
      );
    });
    await run("FAILED timestamp/context and append-only SQL history", async () => {
      const f = await fixture(),
        event = id(),
        context = id();
      await query(
        "INSERT INTO durable_runtime.runtime_event_queue(event_id,producer_id,incarnation,producer_seq,agent_id,payload,state) VALUES($1,$2,'synthetic',1,$3,'{}','PENDING')",
        [event, id(), f.agent],
      );
      await query(
        "INSERT INTO durable_runtime.runtime_event_targets(event_id,session_id,agent_id) VALUES($1,$2,$3)",
        [event, f.sessions[0], f.agent],
      );
      await rejectCode(
        query(
          "UPDATE durable_runtime.runtime_event_queue SET state='FAILED',terminal_at=clock_timestamp(),last_error='synthetic' WHERE event_id=$1",
          [event],
        ),
        "23514",
      );
      await withDurableTransaction(pool, async (tx) => {
        await tx.query(
          "INSERT INTO durable_runtime.session_context_records(id,session_id,revision,kind,target_event_id,body_ref) VALUES($1,$2,1,'EVENT_FAILED',$3,'{}')",
          [context, f.sessions[0], event],
        );
        await tx.query(
          "INSERT INTO durable_runtime.runtime_event_failure_contexts(event_id,session_id,context_record_id) VALUES($1,$2,$3)",
          [event, f.sessions[0], context],
        );
        for (let attempt = 1; attempt <= 6; attempt++) {
          await tx.query(
            "INSERT INTO durable_runtime.runtime_event_attempt_history(id,event_id,attempt_number,stage,controller_term,occurred_at) VALUES($1,$2,$3,'STARTED',1,clock_timestamp()),($4,$2,$3,'FAILED',1,clock_timestamp())",
            [id(), event, attempt, id()],
          );
        }
        await tx.query(
          "UPDATE durable_runtime.runtime_event_queue SET state='FAILED',attempt_count=6,retry_count=5,terminal_at=clock_timestamp(),last_error='synthetic' WHERE event_id=$1",
          [event],
        );
      });
      const row = (
        await query(
          "SELECT state,processed_at,terminal_at FROM durable_runtime.runtime_event_queue WHERE event_id=$1",
          [event],
        )
      ).rows[0];
      assert.equal(row.processed_at, null);
      assert.ok(row.terminal_at);
      assert.equal(row.state, "FAILED");
      await rejectCode(
        query(
          "UPDATE durable_runtime.runtime_event_attempt_history SET stage='SUCCEEDED' WHERE event_id=$1",
          [event],
        ),
        "23514",
      );
      await rejectCode(
        query("DELETE FROM durable_runtime.runtime_event_attempt_history WHERE event_id=$1", [
          event,
        ]),
        "23514",
      );
      await rejectCode(
        query("UPDATE durable_runtime.runtime_event_queue SET payload='[]' WHERE event_id=$1", [
          event,
        ]),
        "23514",
      );
    });
    await run("precision-safe BIGINT and redacted database errors", async () => {
      const high = counter("session-fence", "9223372036854775806");
      assert.equal(incrementCounter("session-fence", high), "9223372036854775807");
      assert.throws(() =>
        incrementCounter("session-fence", counter("session-fence", "9223372036854775807")),
      );
      assert.throws(() =>
        Reflect.apply(counter, null, ["session-fence", Number.MAX_SAFE_INTEGER + 2]),
      );
      assert.equal(
        (await query("SELECT 9223372036854775806::bigint AS value")).rows[0].value,
        "9223372036854775806",
      );
      assert.equal(
        safeDatabaseError({ code: "23505", message: "synthetic credential-like detail" }).message,
        "Durable database operation failed (23505)",
      );
    });
    await run("proof-bearing execution revoke cannot resurrect", async () => {
      const f = await fixture(),
        grant = id();
      await query(
        "INSERT INTO durable_runtime.execution_grants(id,runtime_unit_id,attempt_id,execution_epoch,state) VALUES($1,$2,$3,0,'REVOKING')",
        [grant, f.unit, f.attempt],
      );
      await withDurableTransaction(pool, (tx) =>
        revokeExecutionGrant(tx, {
          grantId: logicalId("grant", grant),
          runtimeUnitId: logicalId("runtime-unit", f.unit),
          attemptId: logicalId("attempt", f.attempt),
          executionEpoch: counter("execution-epoch", 0n),
          expectedRevision: counter("row:execution-grant", 0n),
          stoppedProofRef: "synthetic-stop-evidence",
        }),
      );
      await rejectCode(
        query(
          "UPDATE durable_runtime.execution_grants SET state='ACTIVE',revoked_at=NULL WHERE id=$1",
          [grant],
        ),
        "23514",
      );
    });
    await run(
      "direct SQL grant-versus-epoch transactions serialize in both commit orders",
      async () => {
        for (const grantFirst of [true, false]) {
          const f = await fixture(),
            first = await pool.connect(),
            second = await pool.connect(),
            grant = id();
          const grantSql =
            "INSERT INTO durable_runtime.storage_write_grants(id,storage_binding_id,attempt_id,storage_epoch,state) VALUES($1,$2,$3,0,'ACTIVE')";
          try {
            await first.query("BEGIN");
            await second.query("BEGIN");
            await second.query("SET LOCAL statement_timeout='10s'");
            const secondPid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            await (grantFirst
              ? first.query(grantSql, [grant, f.bindings[0], f.attempt])
              : first.query("UPDATE durable_runtime.storage_bindings SET epoch=1 WHERE id=$1", [
                  f.bindings[0],
                ]));
            const waiting = (
              grantFirst
                ? second.query("UPDATE durable_runtime.storage_bindings SET epoch=1 WHERE id=$1", [
                    f.bindings[0],
                  ])
                : second.query(grantSql, [grant, f.bindings[0], f.attempt])
            ).then(
              () => ({ code: "UNEXPECTED_SUCCESS" }),
              (error) => ({ code: safeDatabaseError(error).code }),
            );
            let blocked = false;
            for (let n = 0; n < 100; n++) {
              const activity = await query(
                "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
                [secondPid],
              );
              if (activity.rows[0]?.wait_event_type === "Lock") {
                blocked = true;
                break;
              }
              await delay(20);
            }
            assert.ok(blocked, "overlap observed by actual PostgreSQL lock wait");
            await first.query("COMMIT");
            assert.equal((await waiting).code, "23514");
            await second.query("ROLLBACK");
            const stored = (
              await query("SELECT epoch FROM durable_runtime.storage_bindings WHERE id=$1", [
                f.bindings[0],
              ])
            ).rows[0];
            assert.equal(stored.epoch, grantFirst ? "0" : "1");
            assert.equal(
              (
                await query(
                  "SELECT count(*)::text AS count FROM durable_runtime.storage_write_grants WHERE storage_binding_id=$1 AND state='ACTIVE'",
                  [f.bindings[0]],
                )
              ).rows[0].count,
              grantFirst ? "1" : "0",
            );
          } finally {
            await first.query("ROLLBACK");
            await second.query("ROLLBACK");
            first.release();
            second.release();
          }
        }
      },
    );
    await run(
      "cancel target provider ref cannot be retargeted erased or implicitly attached",
      async () => {
        const f = await fixture(),
          m = await message(f.sessions[0]);
        for (const providerRef of ["synthetic-turn", null]) {
          const operation = id();
          await query(
            "INSERT INTO durable_runtime.cancel_intents(operation_id,session_id,target_message_id,target_message_revision,target_runtime_unit_id,target_attempt_id,target_execution_epoch,target_provider_turn_ref,requested_by,requested_at,cancel_revision,interrupt_status,updated_at) VALUES($1,$2,$3,0,$4,$5,0,$6,'synthetic',clock_timestamp(),1,'REQUESTED',clock_timestamp())",
            [operation, f.sessions[0], m, f.unit, f.attempt, providerRef],
          );
          await rejectCode(
            query(
              "UPDATE durable_runtime.cancel_intents SET target_provider_turn_ref=$2 WHERE operation_id=$1",
              [operation, "different-turn"],
            ),
            "23514",
          );
          if (providerRef) {
            await rejectCode(
              query(
                "UPDATE durable_runtime.cancel_intents SET target_provider_turn_ref=NULL WHERE operation_id=$1",
                [operation],
              ),
              "23514",
            );
          }
        }
      },
    );
  } finally {
    await pool.end();
  }
});
