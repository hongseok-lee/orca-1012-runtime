import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, connect, type Socket } from "node:net";
import { readFile, mkdir, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { counter, logicalId } from "../../../shared/durable-runtime/identity.ts";
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from "./connection.ts";
import { runDurableMutation, resolveReceipt, type ReceiptIdentity } from "./atomic.ts";
import { applyMigrations, readMigrations } from "./migrate.ts";
import { lockAggregates } from "./locks.ts";
import { appendSessionEvent, enqueueOutbox, appendAudit } from "../journal/store.ts";
import { claimOutbox, markOutboxPublished, publishOutboxClaim } from "../journal/publisher.ts";

if (!/^orca_p103_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? ""))
  throw new Error("Owned P1-03 database required");
const pool = createDurablePool({ max: 8, application_name: "orca-p103-tests" });
const hash = "a".repeat(64);
const sql = (text: string, values: readonly unknown[] = []) =>
  withDurableTransaction(pool, (tx) => tx.query(text, values));
const identity = (operationKey = randomUUID()): ReceiptIdentity => ({
  key: {
    principalId: "synthetic-authenticated-principal",
    sessionScope: "owned-test",
    method: "synthetic-mutation",
    operationKey,
  },
  payloadHash: hash,
});
async function fixture() {
  const workspace = randomUUID(),
    agent = randomUUID(),
    session = logicalId("session", randomUUID());
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
  });
  return { session };
}
async function business(
  tx: import("./connection.ts").DurableTransaction,
  session: import("../../../shared/durable-runtime/identity.ts").SessionId,
  nativeId: string,
) {
  const id = randomUUID();
  await tx.query(
    "INSERT INTO durable_runtime.messages(id,session_id,seq,body_or_blob_ref,intake_status) VALUES($1,$2,1,'{}','DURABLE')",
    [id, session],
  );
  const event = await appendSessionEvent(tx, {
    sessionId: session,
    source: {
      kind: "NATIVE",
      sourceKind: "synthetic-output",
      provider: "synthetic",
      lineage: session,
      nativeId,
    },
    body: { kind: "synthetic" },
  });
  await enqueueOutbox(tx, {
    eventId: event.eventId,
    aggregateId: session,
    aggregateKind: "session",
    revision: counter("row:session", "0"),
    event: { kind: "synthetic" },
  });
  await appendAudit(tx, {
    actorId: "synthetic-worker",
    kind: "synthetic-transition",
    occurredAt: new Date(),
    receivedAt: new Date(),
    producerId: randomUUID(),
    producerSeq: counter("sequence:producer", "1"),
    evidenceRefs: ["protected-ref:synthetic"],
  });
  return { messageId: id, eventId: event.eventId };
}
async function empty(session: string, request: ReceiptIdentity) {
  const r = await sql(
    `SELECT (SELECT count(*) FROM durable_runtime.messages WHERE session_id=$1)::text AS messages,
    (SELECT count(*) FROM durable_runtime.session_events WHERE session_id=$1)::text AS journal,
    (SELECT count(*) FROM durable_runtime.outbox_events WHERE aggregate_id=$1)::text AS outbox,
    (SELECT count(*) FROM durable_runtime.rpc_receipts WHERE operation_key=$2)::text AS receipts`,
    [session, request.key.operationKey],
  );
  assert.deepEqual(r.rows[0], { messages: "0", journal: "0", outbox: "0", receipts: "0" });
}
async function rejectCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof DurableDatabaseError && error.code === code,
  );
}

// Actual local TCP response-loss proxy. All authentication bytes stay in memory;
// neither protocol frames nor passwords are logged or included in reports.
async function commitLossProxy() {
  const sockets = new Set<Socket>();
  let dropped = false;
  const server = createServer((client) => {
    const upstream = connect({
      host: process.env.PGHOST!,
      port: Number(process.env.PGPORT ?? 5432),
    });
    sockets.add(client);
    sockets.add(upstream);
    client.on("data", (data) => upstream.write(data));
    upstream.on("data", (data) => {
      if (Buffer.from(data).includes(Buffer.from("COMMIT\0"))) {
        dropped = true;
        client.destroy();
        upstream.destroy();
      } else client.write(data);
    });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const privatePassword = async () => {
    const content = await readFile(process.env.PGPASSFILE!, "utf8");
    return content.trim().split(":").at(-1)!;
  };
  const proxied = createDurablePool({
    host: "127.0.0.1",
    port: address.port,
    password: privatePassword,
    max: 1,
  });
  return {
    proxied,
    didDrop: () => dropped,
    close: async () => {
      await proxied.end();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function ownedCrash(stage: string) {
  await mkdir("/tmp/orca-p103-owned-evidence", { recursive: true, mode: 0o700 });
  const report = `/tmp/orca-p103-owned-evidence/${randomUUID()}.json`;
  const log = await open(`${report}.private.log`, "w", 0o600);
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../journal/outbox-crash-worker.mts", import.meta.url))],
    {
      env: { ...process.env, CRASH_STAGE: stage, CRASH_REPORT_PATH: report },
      stdio: ["ignore", log.fd, log.fd],
    },
  );
  const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
  try {
    for (let n = 0; n < 500; n++) {
      try {
        const result = JSON.parse(await readFile(report, "utf8"));
        if (stage !== "PUBLISH_AND_MARK") child.kill("SIGKILL");
        await exited;
        return result.id as string;
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          await delay(10);
          continue;
        }
        throw error;
      }
    }
    throw new Error("Owned child report timeout");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    await log.close();
  }
}

await test("P1-03 actual PG atomic and publication boundaries", async (t) => {
  try {
    await applyMigrations(
      pool,
      await readMigrations(fileURLToPath(new URL("./migrations/", import.meta.url))),
    );
    const passed = new Set([
      "callback before and midway failures roll back business receipt journal outbox audit",
      "hidden callback commit and multi-statement transaction control are rejected",
    ]);
    const run = (name: string, body: () => Promise<void>) =>
      t.test(
        name,
        {
          skip:
            (process.env.DURABLE_DB_FOCUS === "remaining" && passed.has(name)) ||
            (!!process.env.DURABLE_DB_ONLY && process.env.DURABLE_DB_ONLY !== name),
        },
        body,
      );
    await run(
      "callback before and midway failures roll back business receipt journal outbox audit",
      async () => {
        for (const midway of [false, true]) {
          const { session } = await fixture(),
            request = identity();
          const auditBefore = (
            await sql("SELECT count(*)::text AS n FROM durable_runtime.runtime_audit_events")
          ).rows[0].n;
          await assert.rejects(
            runDurableMutation(
              pool,
              { ...request, locks: { sessionIds: [session] } },
              async (tx) => {
                if (midway) await business(tx, session, randomUUID());
                throw new Error("synthetic-callback-failure");
              },
            ),
            DurableDatabaseError,
          );
          await empty(session, request);
          assert.equal(
            (await sql("SELECT count(*)::text AS n FROM durable_runtime.runtime_audit_events"))
              .rows[0].n,
            auditBefore,
          );
        }
      },
    );
    await run(
      "hidden callback commit and multi-statement transaction control are rejected",
      async () => {
        for (const control of ["/* comment */ COMMIT", "SELECT 1; COMMIT"]) {
          const { session } = await fixture(),
            request = identity();
          await rejectCode(
            runDurableMutation(
              pool,
              { ...request, locks: { sessionIds: [session] } },
              async (tx) => {
                await business(tx, session, randomUUID());
                await tx.query(control);
                return {};
              },
            ),
            "MUTATION_SQL_BOUNDARY",
          );
          await empty(session, request);
        }
      },
    );
    await run(
      "owned backend termination before commit cannot return partial durable success",
      async () => {
        const { session } = await fixture(),
          request = identity();
        await assert.rejects(
          runDurableMutation(pool, { ...request, locks: { sessionIds: [session] } }, async (tx) => {
            await business(tx, session, randomUUID());
            const pid = (await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            await pool.query("SELECT pg_terminate_backend($1)", [pid]);
            return {};
          }),
          DurableDatabaseError,
        );
        await empty(session, request);
      },
    );
    await run(
      "same authenticated key replays one receipt without duplicate callback effect",
      async () => {
        const { session } = await fixture(),
          request = identity();
        let calls = 0;
        const outcomes = await Promise.all(
          Array.from({ length: 4 }, () =>
            runDurableMutation(
              pool,
              { ...request, intakeAt: new Date(), locks: { sessionIds: [session] } },
              async (tx) => {
                calls++;
                return business(tx, session, randomUUID());
              },
            ),
          ),
        );
        assert.equal(calls, 1);
        assert.equal(outcomes.filter((o) => o.status === "COMMITTED").length, 1);
        assert.equal((await resolveReceipt(pool, request)).status, "FOUND");
        await rejectCode(
          resolveReceipt(pool, { ...request, payloadHash: "b".repeat(64) }),
          "RECEIPT_PAYLOAD_CONFLICT",
        );
        const rows = (
          await sql(
            "SELECT count(*)::text AS n FROM durable_runtime.messages WHERE session_id=$1",
            [session],
          )
        ).rows[0].n;
        assert.equal(rows, "1");
        const committed = outcomes.find((o) => o.status === "COMMITTED")!;
        assert.ok(
          committed.status !== "UNCERTAIN" &&
            committed.transactionDurationMs >= 0 &&
            committed.receipt.intakeAt instanceof Date,
        );
        const claims = await claimOutbox(pool, { owner: "drain-one", limit: 100, leaseMs: 5000 });
        for (const claim of claims) await markOutboxPublished(pool, claim);
      },
    );
    await run(
      "actual COMMIT response loss returns uncertain then original-key lookup finds same durable receipt",
      async () => {
        const { session } = await fixture(),
          request = identity();
        const proxy = await commitLossProxy();
        try {
          const result = await runDurableMutation(
            proxy.proxied,
            { ...request, locks: { sessionIds: [session] } },
            (tx) => business(tx, session, randomUUID()),
          );
          assert.equal(proxy.didDrop(), true);
          assert.equal(result.status, "UNCERTAIN");
          const resolved = await resolveReceipt(pool, request);
          assert.equal(resolved.status, "FOUND");
          assert.equal(
            (
              await sql(
                "SELECT count(*)::text AS n FROM durable_runtime.messages WHERE session_id=$1",
                [session],
              )
            ).rows[0].n,
            "1",
          );
        } finally {
          await proxy.close();
        }
        const claims = await claimOutbox(pool, {
          owner: "drain-response-loss",
          limit: 100,
          leaseMs: 5000,
        });
        for (const claim of claims) await markOutboxPublished(pool, claim);
      },
    );
    await run(
      "native source identity dedup preserves same event and distinct identity equal body",
      async () => {
        const { session } = await fixture();
        const emit = (nativeId: string) =>
          withDurableTransaction(pool, (tx) =>
            appendSessionEvent(tx, {
              sessionId: session,
              source: {
                kind: "NATIVE",
                sourceKind: "output",
                provider: "synthetic",
                lineage: "one-lineage",
                nativeId,
              },
              body: { same: "content" },
            }),
          );
        const a = await emit("one"),
          b = await emit("one"),
          c = await emit("two");
        assert.equal(a.eventId, b.eventId);
        assert.notEqual(a.eventId, c.eventId);
        assert.equal(a.journalEpoch, c.journalEpoch);
        assert.notEqual(a.sequence, c.sequence);
      },
    );
    await run(
      "publisher cannot observe uncommitted outbox and concurrent claims are disjoint",
      async () => {
        const { session } = await fixture();
        let release!: () => void, written!: () => void;
        const releasePromise = new Promise<void>((resolve) => {
          release = resolve;
        });
        const writtenPromise = new Promise<void>((resolve) => {
          written = resolve;
        });
        const write = withDurableTransaction(pool, async (tx) => {
          const event = await appendSessionEvent(tx, {
            sessionId: session,
            source: {
              kind: "NATIVE",
              sourceKind: "output",
              provider: "synthetic",
              lineage: session,
              nativeId: "one",
            },
            body: {},
          });
          await enqueueOutbox(tx, {
            eventId: event.eventId,
            aggregateId: session,
            aggregateKind: "session",
            revision: counter("row:session", "0"),
            event: {},
          });
          written();
          await releasePromise;
        });
        await writtenPromise;
        assert.equal(
          (await claimOutbox(pool, { owner: "before-commit", limit: 1, leaseMs: 5000 })).length,
          0,
        );
        release();
        await write;
        const groups = await Promise.all(
          ["a", "b"].map((owner) => claimOutbox(pool, { owner, limit: 1, leaseMs: 5000 })),
        );
        assert.equal(groups.flat().length, 1);
        assert.equal(
          await publishOutboxClaim(pool, groups.flat()[0], async () => {
            assert.equal(
              (
                await sql("SELECT state FROM durable_runtime.outbox_events WHERE aggregate_id=$1", [
                  session,
                ])
              ).rows[0].state,
              "CLAIMED",
            );
          }),
          true,
        );
      },
    );
    await run(
      "actual owned publisher process crashes before publish and after publish preserve event ID for restart",
      async () => {
        const { session } = await fixture(),
          request = identity();
        const result = await runDurableMutation(
          pool,
          { ...request, locks: { sessionIds: [session] } },
          (tx) => business(tx, session, randomUUID()),
        );
        assert.ok(result.status !== "UNCERTAIN");
        const first = await ownedCrash("BEFORE_PUBLISH");
        await delay(110);
        const second = await ownedCrash("AFTER_PUBLISH_BEFORE_MARK");
        await delay(110);
        const third = await ownedCrash("PUBLISH_AND_MARK");
        assert.equal(first, second);
        assert.equal(second, third);
        assert.equal(
          (await sql("SELECT state FROM durable_runtime.outbox_events WHERE id=$1", [third]))
            .rows[0].state,
          "PUBLISHED",
        );
      },
    );
    await run(
      "publish failure records retry state and stale claim cannot overwrite new owner",
      async () => {
        const { session } = await fixture(),
          request = identity();
        await runDurableMutation(pool, { ...request, locks: { sessionIds: [session] } }, (tx) =>
          business(tx, session, randomUUID()),
        );
        const first = (
          await claimOutbox(pool, { owner: "failure-owner", limit: 1, leaseMs: 5000 })
        )[0];
        assert.equal(
          await publishOutboxClaim(pool, first, async () => {
            throw new Error("private publish failure");
          }),
          false,
        );
        const next = (
          await claimOutbox(pool, { owner: "retry-owner", limit: 1, leaseMs: 5000 })
        )[0];
        assert.equal(next.id, first.id);
        assert.equal(await markOutboxPublished(pool, first), false);
        assert.equal(await markOutboxPublished(pool, next), true);
        const row = (
          await sql(
            "SELECT attempt_count,last_error_code FROM durable_runtime.outbox_events WHERE id=$1",
            [next.id],
          )
        ).rows[0];
        assert.equal(row.attempt_count, "2");
        assert.equal(row.last_error_code, "PUBLISH_FAILED");
      },
    );
    await run(
      "prelocked gateway reentry and journal reuse succeed but new reverse Session lock is rejected",
      async () => {
        const modulePath = process.env.GATEWAY_AUTHORITY_MODULE;
        assert.ok(modulePath, "Exact backend gateway authority module required");
        const { LockedGatewayAuthority } = await import(modulePath);
        const { session } = await fixture(),
          other = await fixture();
        const unit = logicalId("runtime-unit", randomUUID()),
          operation = logicalId("operation", randomUUID()),
          scope = randomUUID();
        await withDurableTransaction(pool, async (tx) => {
          await tx.query(
            "INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','READY')",
            [unit],
          );
          await tx.query(
            "INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,'synthetic-controller',1,clock_timestamp()+interval '1 minute')",
            [scope],
          );
          await tx.query(
            "INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,execution_epoch) VALUES($1,$2,'synthetic',0,$3,1,'initial',0)",
            [operation, unit, scope],
          );
        });
        const result = await runDurableMutation(
          pool,
          {
            ...identity(),
            locks: { sessionIds: [session], runtimeUnitIds: [unit], operationIds: [operation] },
          },
          async (tx) => {
            const gateway = await LockedGatewayAuthority.acquire(tx, {
              runtimeUnitId: unit,
              operationId: operation,
              controller: {
                scope,
                owner: "synthetic-controller",
                term: counter("controller-term", "1"),
              },
            });
            await gateway.assertCurrent();
            assert.equal(tx.isLockHeld(1, session), true);
            assert.equal(tx.isLockHeld(2, unit), true);
            assert.equal(tx.isLockHeld(4, operation), true);
            const event = await appendSessionEvent(tx, {
              sessionId: session,
              source: {
                kind: "NATIVE",
                sourceKind: "gateway-integration",
                provider: "synthetic",
                lineage: unit,
                nativeId: operation,
              },
              body: {},
            });
            await assert.rejects(
              appendSessionEvent(tx, {
                sessionId: other.session,
                source: {
                  kind: "NATIVE",
                  sourceKind: "gateway-integration",
                  provider: "synthetic",
                  lineage: unit,
                  nativeId: operation,
                },
                body: {},
              }),
              (error: unknown) =>
                error instanceof DurableDatabaseError && error.code === "LOCK_ORDER",
            );
            return { eventId: event.eventId };
          },
        );
        assert.equal(result.status, "COMMITTED");
        await withDurableTransaction(pool, async (tx) => {
          const missing = logicalId("session", randomUUID());
          await rejectCode(lockAggregates(tx, { sessionIds: [missing] }), "LOCK_TARGET_MISSING");
          assert.equal(tx.isLockHeld(1, missing), false);
        });
      },
    );
    await run(
      "unavailable owned DB connection never yields durable success or publish",
      async () => {
        const unavailable = createDurablePool({
          host: "127.0.0.1",
          port: 1,
          connectionTimeoutMillis: 200,
          max: 1,
        });
        let called = false;
        try {
          await assert.rejects(
            runDurableMutation(unavailable, { ...identity(), locks: {} }, async () => {
              called = true;
              return {};
            }),
            DurableDatabaseError,
          );
          assert.equal(called, false);
          assert.equal((await resolveReceipt(unavailable, identity())).status, "UNAVAILABLE");
        } finally {
          await unavailable.end();
        }
      },
    );
  } finally {
    await pool.end();
  }
});
