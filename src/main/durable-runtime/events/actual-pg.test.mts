import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool, PoolClient } from "pg";
import { logicalId, counter } from "../../../shared/durable-runtime/identity.ts";
import type { SessionId } from "../../../shared/durable-runtime/identity.ts";
import { createDurablePool, DurableDatabaseError } from "../db/connection.ts";
import { applyMigrations, readMigrations } from "../db/migrate.ts";
import type { VerifiedWorkloadIdentity } from "../runtime/runtime-evidence.ts";
import type { ConsumerAuthority, EventClaim, EventProducer, ProducerStream } from "./types.ts";
import {
  registerEventProducer, enqueueRuntimeEvent, claimRuntimeEvent,
  processRuntimeEvent, finalizeRuntimeEvent,
} from "./store.ts";

// Real PostgreSQL fixtures exercise this module only. The assertion of a
// verified workload type below is intentionally NOT authentication evidence.
const database = process.env.PGDATABASE ?? "";
assert.match(database, /^orca_p112_[a-z0-9_]+$/);
assert.ok(process.env.P112_MIGRATIONS);
const pool = createDurablePool({ max: 8 });
const cases: { name: string; passed: boolean }[] = [];
let migrations: { version: string; checksum: string }[] = [];
before(async () => {
  const found = await readMigrations(process.env.P112_MIGRATIONS!);
  assert.equal(found.length, 11, "pinned complete owner schema required");
  const applied = await applyMigrations(pool, found);
  migrations = applied.map(({ version, checksum }) => ({ version, checksum }));
  await pool.query("CREATE TABLE IF NOT EXISTS public.p112_effects(event_id uuid PRIMARY KEY, value text NOT NULL)");
});
after(async () => {
  if (process.env.P112_EVIDENCE) await writeFile(process.env.P112_EVIDENCE, JSON.stringify({
    scope: "ACTUAL_POSTGRES_QUEUE_MODULE_WITH_FIXTURE_EVENTS", recordedAt: new Date().toISOString(),
    sourceRevision: process.env.P112_SOURCE_REVISION, commonApiRevision: process.env.P112_COMMON_REVISION,
    producerSchemaRevision: process.env.P112_SCHEMA_REVISION, migrations, cases,
    authenticationVerified: false, providerVerified: false, agentSpoolVerified: false,
    physicalFencingVerified: false, portIntegrated: false, productUiVerified: false,
    commitLossMode: "driver reply hook after actual PG commit",
    finalizationCrashMode: "actual termination of own verification connection before commit",
  }, null, 2), { mode: 0o600 });
  await pool.end();
});
function check(name: string, body: () => Promise<void>): void {
  test(name, async () => { await body(); cases.push({ name, passed: true }); });
}
type Fixture = { producer: EventProducer; stream: ProducerStream; authority: ConsumerAuthority; sessions: SessionId[] };
async function fixture(): Promise<Fixture> {
  const agent = logicalId("agent", randomUUID());
  const workspace = randomUUID();
  const unit = logicalId("runtime-unit", randomUUID());
  const attempt = logicalId("attempt", randomUUID());
  const sessions = [logicalId("session", randomUUID()), logicalId("session", randomUUID())].sort();
  const storage = randomUUID();
  const producerId = logicalId("producer", randomUUID());
  const incarnation = `fixture-${randomUUID()}`;
  const pod = `fixture-pod-${randomUUID()}`;
  const authority = { scope: `p112-${randomUUID()}`, owner: "fixture-controller", term: counter("controller-term", "1") };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'queue-verifier')", [agent]);
    await client.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'queue-fixture','READY')", [workspace, randomUUID()]);
    await client.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase,execution_epoch) VALUES($1,'SUSPENDED','ABSENT',1)", [unit]);
    await client.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision,updated_at) VALUES($1,0,'{}',0,clock_timestamp())", [unit]);
    await client.query("INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,resource_profile_revision,effective_resources,status) VALUES($1,$2,1,'COLD',$3,$4,0,'{}','STOPPED')", [attempt, unit, pod, incarnation]);
    await client.query("INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,'fixture-export')", [storage]);
    await client.query("INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state) VALUES($1,$2,'fixture-export','/fixture','RO')", [storage, storage]);
    for (const session of sessions) {
      await client.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [session, agent, workspace]);
      await client.query("INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)", [unit, session, storage]);
    }
    await client.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,$2,1,clock_timestamp()+interval '5 minutes')", [authority.scope, authority.owner]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  const workload = {
    attemptId: attempt, producerId, incarnation, podUid: pod, executionEpoch: counter("execution-epoch", "1"),
    principalRef: "verification-only-not-authenticated", authenticationEvidenceRef: "verification-only-not-auth-proof",
  } as unknown as VerifiedWorkloadIdentity;
  const producer = { workload, agentId: agent, runtimeUnitId: unit };
  await registerEventProducer(pool, producer);
  return { producer, stream: { producerId, incarnation: workload.incarnation }, authority, sessions };
}
function event(f: Fixture, n: number, id: string = randomUUID(), targets = f.sessions) {
  return { eventId: logicalId("event", id), sequence: counter("sequence:producer", String(n)), payload: { kind: "DB_MODULE_FIXTURE", n }, targetSessionIds: targets };
}
async function claim(f: Fixture, via: Pool = pool): Promise<EventClaim> {
  const result = await claimRuntimeEvent(via, f.stream, f.authority, { claimDurationMs: 60000 });
  assert.equal(result.status, "CLAIMED");
  return (result as Extract<typeof result, { status: "CLAIMED" }>).claim;
}
async function takeover(f: Fixture): Promise<void> {
  f.authority = { ...f.authority, owner: `fixture-owner-${randomUUID()}`, term: counter("controller-term", BigInt(f.authority.term) + 1n) };
  await pool.query("UPDATE durable_runtime.controller_leases SET owner=$2,term=$3,revision=revision+1,expires_at=clock_timestamp()+interval '5 minutes' WHERE scope=$1", [f.authority.scope, f.authority.owner, f.authority.term]);
}
async function waitRetry(id: string): Promise<void> {
  const row = await pool.query("SELECT greatest(0,extract(epoch FROM next_retry_at-clock_timestamp())*1000)::float8 AS ms FROM durable_runtime.runtime_event_queue WHERE event_id=$1", [id]);
  await delay(Math.ceil(row.rows[0].ms) + 20);
}
async function errorCode(body: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(body, error => error instanceof DurableDatabaseError && error.code === code);
}

// The injected hook still checks out a real PG client. It is used only to mark
// an exact lost-reply or connection-crash boundary, not to mock queue responses.
function withClientHook(hook: (sql: string, client: PoolClient, query: () => Promise<unknown>) => Promise<unknown>): Pool {
  return {
    async connect() {
      const client = await pool.connect();
      const original = client.query.bind(client);
      return new Proxy(client, { get(target, key) {
        if (key === "query") return (sql: string, values?: unknown[]) => hook(sql, client, () => original(sql, values));
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    },
  } as unknown as Pool;
}

check("11 before 10 produces contiguous ACK 9 then 11; replay and target/payload conflicts", async () => {
  const f = await fixture();
  for (let n = 1; n <= 9; n++) assert.equal((await enqueueRuntimeEvent(pool, f.producer, event(f, n))).durablyCommittedThrough, String(n));
  const eleven = event(f, 11);
  assert.equal((await enqueueRuntimeEvent(pool, f.producer, eleven)).durablyCommittedThrough, "9");
  assert.equal((await enqueueRuntimeEvent(pool, f.producer, event(f, 10))).durablyCommittedThrough, "11");
  assert.equal((await enqueueRuntimeEvent(pool, f.producer, eleven)).status, "REPLAYED");
  await errorCode(() => enqueueRuntimeEvent(pool, f.producer, { ...eleven, payload: { other: true } }), "EVENT_IDENTITY_CONFLICT");
  await errorCode(() => enqueueRuntimeEvent(pool, f.producer, { ...eleven, targetSessionIds: [f.sessions[0]] }), "EVENT_IDENTITY_CONFLICT");
  await errorCode(() => enqueueRuntimeEvent(pool, f.producer, event(f, 10, eleven.eventId)), "EVENT_IDENTITY_CONFLICT");
  const count = await pool.query("SELECT count(*) AS n FROM durable_runtime.runtime_event_queue WHERE producer_id=$1", [f.stream.producerId]);
  assert.equal(count.rows[0].n, "11");
});
check("concurrent enqueue deduplicates; concurrent claim charges one STARTED", async () => {
  const f = await fixture(); const e = event(f, 1);
  const enqueued = await Promise.all(Array.from({ length: 6 }, () => enqueueRuntimeEvent(pool, f.producer, e)));
  assert.equal(enqueued.filter(x => x.status === "COMMITTED").length, 1);
  assert.ok(enqueued.every(x => x.durablyCommittedThrough === "1"));
  const claims = await Promise.all(Array.from({ length: 6 }, () => claimRuntimeEvent(pool, f.stream, f.authority, { claimDurationMs: 60000 })));
  assert.equal(claims.filter(x => x.status === "CLAIMED").length, 1);
  const rows = await pool.query("SELECT attempt_count,state FROM durable_runtime.runtime_event_queue WHERE event_id=$1", [e.eventId]);
  assert.deepEqual(rows.rows[0], { attempt_count: "1", state: "PROCESSING" });
});
check("ACK persists before consumer completion; actual COMMIT reply hook returns no false ACK", async () => {
  const f = await fixture(); const e = event(f, 1); let once = true;
  const lostReply = withClientHook(async (sql, _client, query) => {
    const result = await query();
    if (sql === "COMMIT" && once) { once = false; throw new Error("verification reply loss"); }
    return result;
  });
  await errorCode(() => enqueueRuntimeEvent(lostReply, f.producer, e), "DB_FAILURE");
  assert.equal((await enqueueRuntimeEvent(pool, f.producer, e)).status, "REPLAYED");
  const row = await pool.query("SELECT state,attempt_count FROM durable_runtime.runtime_event_queue WHERE event_id=$1", [e.eventId]);
  assert.deepEqual(row.rows[0], { state: "PENDING", attempt_count: "0" });
});
check("gap and stale controller do not skip; post-enqueue target append is rejected by 011", async () => {
  const f = await fixture(); const e = event(f, 2, randomUUID(), [f.sessions[0]]);
  assert.equal((await enqueueRuntimeEvent(pool, f.producer, e)).durablyCommittedThrough, "0");
  assert.deepEqual(await claimRuntimeEvent(pool, f.stream, f.authority, { claimDurationMs: 1000 }), { status: "WAITING", reason: "GAP" });
  await errorCode(() => claimRuntimeEvent(pool, f.stream, { ...f.authority, owner: "stale" }, { claimDurationMs: 1000 }), "EVENT_STALE_AUTHORITY");
  await assert.rejects(() => pool.query("INSERT INTO durable_runtime.runtime_event_targets(event_id,session_id,agent_id) VALUES($1,$2,$3)", [e.eventId, f.sessions[1], f.producer.agentId]), { code: "23514" });
});
check("projection rollback and DONE atomically include journal/outbox/history/receipt", async () => {
  const f = await fixture(); const e = event(f, 1);
  await enqueueRuntimeEvent(pool, f.producer, e); const c = await claim(f);
  assert.equal((await processRuntimeEvent(pool, c, async tx => {
    await tx.query("INSERT INTO public.p112_effects VALUES($1,'rolled-back')", [e.eventId]);
    throw new DurableDatabaseError("TEST_HANDLER");
  })).status, "RETRY");
  assert.equal((await pool.query("SELECT count(*) AS n FROM public.p112_effects WHERE event_id=$1", [e.eventId])).rows[0].n, "0");
  assert.deepEqual(await claimRuntimeEvent(pool, f.stream, f.authority, { claimDurationMs: 1000 }), { status: "WAITING", reason: "RETRY" });
  await waitRetry(e.eventId); const second = await claim(f);
  const done = await processRuntimeEvent(pool, second, async tx => { await tx.query("INSERT INTO public.p112_effects VALUES($1,'committed')", [e.eventId]); });
  assert.equal(done.status, "DONE");
  assert.equal((await processRuntimeEvent(pool, second, async () => { assert.fail("committed receipt must replay"); })).status, "DONE");
  const row = (await pool.query("SELECT q.state,q.processed_at IS NOT NULL AS processed,q.terminal_at IS NOT NULL AS terminal,p.processed_through FROM durable_runtime.runtime_event_queue q JOIN durable_runtime.runtime_event_producers p USING(producer_id,incarnation) WHERE q.event_id=$1", [e.eventId])).rows[0];
  assert.deepEqual(row, { state: "DONE", processed: true, terminal: true, processed_through: "1" });
  assert.equal((await pool.query("SELECT count(*) AS n FROM durable_runtime.session_events WHERE session_id=ANY($1::uuid[])", [f.sessions])).rows[0].n, "2");
  assert.equal((await pool.query("SELECT count(*) AS n FROM durable_runtime.outbox_events WHERE aggregate_id=ANY($1::uuid[])", [f.sessions])).rows[0].n, "2");
});
check("third started attempt takeover; sixth crash finalizes without seventh handler", async () => {
  const f = await fixture(); const e = event(f, 1); await enqueueRuntimeEvent(pool, f.producer, e);
  const first = await claim(f);
  await takeover(f); await claim(f); await takeover(f); const third = await claim(f);
  assert.equal(third.attemptCount, 3);
  await takeover(f); const fourth = await claim(f); assert.equal(fourth.attemptCount, 4);
  assert.equal((await processRuntimeEvent(pool, third, async () => { assert.fail("late token executed"); })).status, "STALE");
  await takeover(f); await claim(f); await takeover(f); const sixth = await claim(f); assert.equal(sixth.attemptCount, 6);
  await takeover(f);
  assert.equal((await finalizeRuntimeEvent(pool, f.stream, f.authority)).status, "FAILED");
  assert.equal((await processRuntimeEvent(pool, first, async () => { assert.fail("old token executed"); })).status, "STALE");
  const history = await pool.query("SELECT stage,count(*) AS n FROM durable_runtime.runtime_event_attempt_history WHERE event_id=$1 GROUP BY stage ORDER BY stage", [e.eventId]);
  assert.deepEqual(history.rows, [{ stage: "STARTED", n: "6" }, { stage: "UNCONFIRMED", n: "6" }]);
  await assertFailureArtifacts(f, e.eventId);
});
async function assertFailureArtifacts(f: Fixture, eventId: string): Promise<void> {
  const row = (await pool.query("SELECT state,attempt_count,retry_count,processed_at,terminal_at IS NOT NULL AS terminal,claim_token FROM durable_runtime.runtime_event_queue WHERE event_id=$1", [eventId])).rows[0];
  assert.deepEqual(row, { state: "FAILED", attempt_count: "6", retry_count: "5", processed_at: null, terminal: true, claim_token: null });
  assert.equal((await pool.query("SELECT count(*) AS n FROM durable_runtime.runtime_event_failure_contexts WHERE event_id=$1", [eventId])).rows[0].n, "2");
  assert.deepEqual((await pool.query("SELECT context_revision FROM durable_runtime.sessions WHERE id=ANY($1::uuid[]) ORDER BY id", [f.sessions])).rows.map(x => x.context_revision), ["1", "1"]);
  assert.equal((await pool.query("SELECT count(*) AS n FROM durable_runtime.notifications WHERE incident_key=$1", [`runtime-event-failed:${eventId}`])).rows[0].n, "1");
  assert.equal((await pool.query("SELECT processed_through FROM durable_runtime.runtime_event_producers WHERE producer_id=$1 AND incarnation=$2", [f.stream.producerId, f.stream.incarnation])).rows[0].processed_through, "1");
}
check("six handler attempts; failed-finalization connection loss rolls back before takeover and next head", async () => {
  const f = await fixture(); const e = event(f, 1); await enqueueRuntimeEvent(pool, f.producer, e);
  const next = event(f, 2); await enqueueRuntimeEvent(pool, f.producer, next);
  for (let n = 1; n <= 5; n++) {
    const c = await claim(f); assert.equal(c.attemptCount, n);
    assert.equal((await processRuntimeEvent(pool, c, async () => { throw new DurableDatabaseError("TEST_HANDLER"); })).status, "RETRY");
    await waitRetry(e.eventId);
  }
  const sixth = await claim(f); let fault = true;
  // Only the failure-finalizer transaction uses this pool wrapper.
  const interrupted = withClientHook(async (sql, client, query) => {
    if (sql === "COMMIT" && fault) {
      fault = false;
      const pid = (client as PoolClient & { processID: number }).processID;
      const victim = await pool.query("SELECT pid FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()", [pid]);
      assert.equal(victim.rowCount, 1, "terminate only this verification database's owned connection");
      await pool.query("SELECT pg_terminate_backend($1)", [pid]);
    }
    return query();
  });
  await errorCode(() => processRuntimeEvent(interrupted, sixth, async () => { throw new DurableDatabaseError("TEST_HANDLER"); }), "57P01");
  const before = (await pool.query("SELECT state,attempt_count FROM durable_runtime.runtime_event_queue WHERE event_id=$1", [e.eventId])).rows[0];
  assert.deepEqual(before, { state: "PROCESSING", attempt_count: "6" });
  assert.equal((await pool.query("SELECT count(*) AS n FROM durable_runtime.runtime_event_failure_contexts WHERE event_id=$1", [e.eventId])).rows[0].n, "0");
  assert.deepEqual(await claimRuntimeEvent(pool, f.stream, f.authority, { claimDurationMs: 1000 }), { status: "WAITING", reason: "CLAIM" });
  await takeover(f); assert.equal((await finalizeRuntimeEvent(pool, f.stream, f.authority)).status, "FAILED");
  await assertFailureArtifacts(f, e.eventId);
  const nextClaim = await claim(f); assert.equal(nextClaim.eventId, next.eventId);
  assert.equal((await processRuntimeEvent(pool, nextClaim, async () => {})).status, "DONE");
  const budget = (await pool.query("SELECT count(*) AS n FROM durable_runtime.runtime_event_attempt_history WHERE event_id=$1 AND stage='STARTED'", [e.eventId])).rows[0].n;
  assert.equal(budget, "6");
});
check("invalid deadline, invalid binding and database outage have no success ACK", async () => {
  const f = await fixture();
  await errorCode(() => claimRuntimeEvent(pool, f.stream, f.authority, { claimDurationMs: Infinity }), "EVENT_DEADLINE");
  await errorCode(() => enqueueRuntimeEvent(pool, { ...f.producer, workload: { ...f.producer.workload, podUid: "wrong-pod" } as VerifiedWorkloadIdentity }, event(f, 1)), "EVENT_BINDING");
  const unavailable = createDurablePool({ host: "127.0.0.1", port: 1, connectionTimeoutMillis: 500, database });
  try { await errorCode(() => enqueueRuntimeEvent(unavailable, f.producer, event(f, 1)), "DB_FAILURE"); }
  finally { await unavailable.end(); }
  assert.equal((await pool.query("SELECT count(*) AS n FROM durable_runtime.runtime_event_queue WHERE producer_id=$1", [f.stream.producerId])).rows[0].n, "0");
});
check("concurrent producer insert cannot invert consumer Session locks", async () => {
  const f = await fixture(); const e = event(f, 1); await enqueueRuntimeEvent(pool, f.producer, e);
  const c = await claim(f);
  let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const processing = processRuntimeEvent(pool, c, async tx => {
    entered(); await gate; await tx.query("INSERT INTO public.p112_effects VALUES($1,'concurrent')", [e.eventId]);
  });
  await waiting;
  const enqueuing = enqueueRuntimeEvent(pool, f.producer, event(f, 2));
  release();
  const [done, ack] = await Promise.all([processing, enqueuing]);
  assert.equal(done.status, "DONE"); assert.equal(ack.durablyCommittedThrough, "2");
});
check("guarded queue handler cannot commit its own partial projection", async () => {
  const f = await fixture(); const e = event(f, 1); await enqueueRuntimeEvent(pool, f.producer, e);
  const c = await claim(f);
  const result = await processRuntimeEvent(pool, c, async tx => {
    await tx.query("INSERT INTO public.p112_effects VALUES($1,'must-rollback')", [e.eventId]);
    await tx.query("COMMIT");
  });
  assert.equal(result.status, "RETRY");
  assert.equal((await pool.query("SELECT count(*) AS n FROM public.p112_effects WHERE event_id=$1", [e.eventId])).rows[0].n, "0");
  assert.equal((await pool.query("SELECT last_error FROM durable_runtime.runtime_event_queue WHERE event_id=$1", [e.eventId])).rows[0].last_error, "MUTATION_SQL_BOUNDARY");
});
check("expired claim preserves attempt charge and rejects the old token", async () => {
  const f = await fixture(); const e = event(f, 1); await enqueueRuntimeEvent(pool, f.producer, e);
  const initial = await claimRuntimeEvent(pool, f.stream, f.authority, { claimDurationMs: 25 });
  assert.equal(initial.status, "CLAIMED");
  const old = (initial as Extract<typeof initial, { status: "CLAIMED" }>).claim;
  await delay(60);
  const current = await claim(f);
  assert.equal(current.attemptCount, 2);
  assert.notEqual(current.token, old.token);
  assert.equal((await processRuntimeEvent(pool, old, async () => { assert.fail("expired token executed"); })).status, "STALE");
  assert.equal((await processRuntimeEvent(pool, current, async () => {})).status, "DONE");
  assert.equal((await pool.query("SELECT count(*) AS n FROM durable_runtime.runtime_event_attempt_history WHERE event_id=$1 AND stage='UNCONFIRMED'", [e.eventId])).rows[0].n, "1");
});
check("processing COMMIT reply loss stays UNCERTAIN and replays its committed receipt", async () => {
  const f = await fixture(); const e = event(f, 1); await enqueueRuntimeEvent(pool, f.producer, e);
  const c = await claim(f); let once = true;
  const lostReply = withClientHook(async (sql, _client, query) => {
    const result = await query();
    if (sql === "COMMIT" && once) { once = false; throw new Error("verification reply loss"); }
    return result;
  });
  const uncertain = await processRuntimeEvent(lostReply, c, async tx => {
    await tx.query("INSERT INTO public.p112_effects VALUES($1,'uncertain-commit')", [e.eventId]);
  });
  assert.equal(uncertain.status, "UNCERTAIN");
  assert.equal((await processRuntimeEvent(pool, c, async () => { assert.fail("committed work reexecuted"); })).status, "DONE");
  assert.equal((await pool.query("SELECT count(*) AS n FROM public.p112_effects WHERE event_id=$1", [e.eventId])).rows[0].n, "1");
  assert.equal((await pool.query("SELECT count(*) AS n FROM durable_runtime.session_events WHERE session_id=ANY($1::uuid[])", [f.sessions])).rows[0].n, "2");
});
