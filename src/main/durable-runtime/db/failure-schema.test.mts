import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { counter, logicalId } from "../../../shared/durable-runtime/identity.ts";
import { prepareFailureObservation } from "../resources/evidence/normalize.ts";
import type { FailureObservationInput } from "../resources/evidence/types.ts";
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from "./connection.ts";
import { applyMigrations, readMigrations } from "./migrate.ts";

if (!(process.env.PGDATABASE ?? "").startsWith("orca_p121_schema_")) {
  throw new Error("Owned failure evidence schema DB required");
}
const pool = createDurablePool({ max: 2 });
const query = (sql: string, args: readonly unknown[] = []) =>
  withDurableTransaction(pool, (tx) => tx.query(sql, args));
const reject = (promise: Promise<unknown>, code = "23514") =>
  assert.rejects(promise, (error: unknown) => error instanceof DurableDatabaseError && error.code === code);

await test("015 actual PG original observation alias ownership FK and rollback", async () => {
  try {
    const migrations = await readMigrations(fileURLToPath(new URL("./migrations/", import.meta.url)));
    assert.equal(migrations.length, 15);
    const ledger = await applyMigrations(pool, migrations);
    assert.deepEqual(ledger.map(({ version, checksum }) => ({ version, checksum })),
      migrations.map(({ version, checksum }) => ({ version, checksum })));
    assert.equal((await query("SELECT current_setting('search_path') AS path")).rows[0].path, '"$user", public');
    const unit = randomUUID(), otherUnit = randomUUID(), attempt = randomUUID(), otherAttempt = randomUUID();
    const incident = randomUUID(), otherIncident = randomUUID();
    const pod = `synthetic-pod:${attempt}`;
    await withDurableTransaction(pool, async (tx) => {
      await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT'),($2,'RUNNING','ABSENT')", [unit, otherUnit]);
      await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0),($2,0,'{}',0)", [unit, otherUnit]);
      await tx.query("INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,resource_profile_revision,effective_resources,status) VALUES($1,$2,1,'COLD',$3,0,'{}','STOPPED'),($4,$5,1,'COLD','synthetic-other-pod',0,'{}','STOPPED')", [attempt, unit, pod, otherAttempt, otherUnit]);
    });

    // This is an owned synthetic tuple, not an authenticated live Pod observation.
    const input: FailureObservationInput = {
      observationId: `synthetic-observation:${attempt}`, sourceDedupKey: `synthetic-source:${attempt}`,
      sourceKind: "SUPERVISOR", sourceRef: "synthetic-fixture", sourceAuthenticated: true,
      target: { runtimeUnitId: logicalId("runtime-unit", unit), attemptId: logicalId("attempt", attempt),
        podUid: pod as FailureObservationInput["target"]["podUid"], executionEpoch: counter("execution-epoch", "1"),
        containerName: "synthetic-agent", runtimeContainerId: "synthetic-container", incarnation: "synthetic-incarnation" as FailureObservationInput["target"]["incarnation"] },
      observedAt: "2026-10-13T12:00:00.123456789Z",
      termination: { state: "SUPERVISOR", containerId: "synthetic-container", incarnation: "synthetic-incarnation",
        processIdentity: "synthetic-process", finishedAt: "2026-10-13T11:59:59.987654321Z", startedAt: null,
        exitCode: 137, signal: 9, reason: "synthetic" },
      counterTransition: null,
      signals: { oomKilled: false, memoryEviction: false, nodeOom: false, limitOom: false,
        heapLimit: false, childOom: false, otherTermination: true, parentAlive: null },
      resources: { desired: { memoryRequest: null, memoryLimit: null, cpuRequest: null, cpuLimit: null },
        observedSpec: null, observedStatus: null, admitted: null, applied: null },
      placement: null, workloadKind: "TEST", profileVerified: false, defaultLimitlessProfile: false,
      affectedWorkIds: [], gaps: ["synthetic-no-resource-provenance"], evidence: { synthetic: true },
    };
    const prepared = prepareFailureObservation(input);
    assert.equal(prepared.resolution, "RESOLVED");
    assert.equal(prepared.finishedTime?.original, input.termination?.finishedAt);
    const alias = prepared.aliases[0];
    assert.ok(alias);
    const insertObservation = (id: string, source: string, targetUnit = unit, targetAttempt = attempt,
      targetPod = pod, epoch = "1", runtimeEvent: string | null = null) => query(
      "INSERT INTO durable_runtime.failure_observations(id,source_dedup_key,runtime_unit_id,attempt_id,pod_uid,execution_epoch,container_name,container_id,incarnation,termination_finished_at,source_kind,source_ref,schema_version,observed_at,evidence,evidence_digest,runtime_event_id) VALUES($1,$2,$3,$4,$5,$6,'synthetic-agent','synthetic-container','synthetic-incarnation',$7,$8,$9,$10,$11,$12,$13,$14)",
      [id, source, targetUnit, targetAttempt, targetPod, epoch, prepared.finishedTime?.original,
        prepared.input.sourceKind, prepared.input.sourceRef, prepared.schemaVersion,
        prepared.input.observedAt, prepared.input, prepared.payloadDigest, runtimeEvent]);
    const insertIncident = (id: string, key: string, targetUnit = unit, targetAttempt = attempt) => query(
      "INSERT INTO durable_runtime.failure_incidents(id,runtime_unit_id,attempt_id,pod_uid,container_id,restart_identity,evidence_key,classification,evidence_refs,observed_at) VALUES($1,$2,$3,$4,'synthetic-container','synthetic-incarnation',$5,'OTHER_TERMINATION','[]',$6)",
      [id, targetUnit, targetAttempt, pod, key, prepared.input.observedAt]);
    await insertIncident(incident, alias.key);
    await insertIncident(otherIncident, `synthetic-other-key:${otherIncident}`);
    await insertObservation(input.observationId, input.sourceDedupKey);
    await reject(insertObservation("synthetic-duplicate", input.sourceDedupKey), "23505");
    await reject(insertObservation("synthetic-bad-tuple", "synthetic-bad-tuple", otherUnit, attempt), "23503");
    await reject(insertObservation("synthetic-bad-epoch", "synthetic-bad-epoch", unit, attempt, pod, "2"), "23503");
    await reject(insertObservation("synthetic-bad-pod", "synthetic-bad-pod", unit, attempt, "synthetic-wrong-pod"), "23503");
    await reject(insertObservation("synthetic-bad-event", "synthetic-bad-event", unit, attempt, pod, "1", randomUUID()), "23503");
    await reject(query("UPDATE durable_runtime.failure_observations SET evidence='{}',evidence_digest=repeat('a',64),source_dedup_key='replacement' WHERE id=$1", [input.observationId]));
    await reject(query("DELETE FROM durable_runtime.failure_observations WHERE id=$1", [input.observationId]));
    await query("INSERT INTO durable_runtime.failure_incident_observations(observation_id,incident_id,runtime_unit_id,attempt_id) VALUES($1,$2,$3,$4)", [input.observationId, incident, unit, attempt]);
    await reject(query("INSERT INTO durable_runtime.failure_incident_observations(observation_id,incident_id,runtime_unit_id,attempt_id) VALUES($1,$2,$3,$4)", [input.observationId, otherIncident, unit, attempt]), "23505");
    await reject(query("UPDATE durable_runtime.failure_incident_observations SET incident_id=$2 WHERE observation_id=$1", [input.observationId, otherIncident]));
    await query("INSERT INTO durable_runtime.failure_incident_aliases(alias_key,incident_id,runtime_unit_id,attempt_id,alias_kind,alias_value) VALUES($1,$2,$3,$4,$5,$6)", [alias.key, incident, unit, attempt, alias.kind, alias.value]);
    await reject(query("INSERT INTO durable_runtime.failure_incident_aliases(alias_key,incident_id,runtime_unit_id,attempt_id,alias_kind,alias_value) VALUES($1,$2,$3,$4,$5,$6)", [alias.key, otherIncident, unit, attempt, alias.kind, alias.value]), "23505");
    await reject(query("INSERT INTO durable_runtime.failure_incident_aliases(alias_key,incident_id,runtime_unit_id,attempt_id,alias_kind,alias_value) VALUES('synthetic-wrong-tuple',$1,$2,$3,'TERMINATION','{}')", [incident, otherUnit, otherAttempt]), "23503");
    await reject(query("UPDATE durable_runtime.failure_incident_aliases SET alias_value='{}' WHERE alias_key=$1", [alias.key]));
    await reject(query("DELETE FROM durable_runtime.failure_incident_aliases WHERE alias_key=$1", [alias.key]));
    await reject(query("INSERT INTO durable_runtime.failure_incident_aliases(alias_key,incident_id,runtime_unit_id,attempt_id,alias_kind,alias_value) VALUES($1,$2,$3,$4,'TERMINATION','{}')", [`synthetic-other-key:${otherIncident}`, incident, unit, attempt]), "23505");
    await query("INSERT INTO durable_runtime.failure_incident_state(incident_id,runtime_unit_id,attempt_id,execution_epoch,collection_started_at,deadline_at,state,evidence_ids) VALUES($1,$2,$3,1,'2026-10-13T12:00:00Z','2026-10-13T12:00:30Z','COLLECTING',$4)", [incident, unit, attempt, [input.observationId]]);
    await reject(query("UPDATE durable_runtime.failure_incident_state SET deadline_at=deadline_at+interval '1 second' WHERE incident_id=$1", [incident]));
    await reject(query("UPDATE durable_runtime.failure_incident_state SET evidence_ids=ARRAY['synthetic-unlinked'] WHERE incident_id=$1", [incident]), "23503");
    await query("UPDATE durable_runtime.failure_incident_state SET revision=1,classification_revision=1,state='CLASSIFIED' WHERE incident_id=$1", [incident]);
    await reject(query("UPDATE durable_runtime.failure_incident_state SET revision=0 WHERE incident_id=$1", [incident]));
    await reject(query("UPDATE durable_runtime.failure_incident_state SET classification_revision=0 WHERE incident_id=$1", [incident]));
    await reject(query("UPDATE durable_runtime.failure_incidents SET evidence_key='replacement' WHERE id=$1", [incident]));
    await reject(query("UPDATE durable_runtime.failure_incidents SET pod_uid='replacement' WHERE id=$1", [incident]));
    await reject(query("UPDATE durable_runtime.failure_incidents SET classification='unplanned-class' WHERE id=$1", [incident]));
    await reject(query("DELETE FROM durable_runtime.failure_incidents WHERE id=$1", [incident]));
    await reject(query("DELETE FROM durable_runtime.failure_incident_state WHERE incident_id=$1", [incident]));

    const rollbackId = `synthetic-rollback:${randomUUID()}`, rollbackAlias = `synthetic-rollback-alias:${randomUUID()}`;
    let rollbackBarrierReached = false;
    await assert.rejects(withDurableTransaction(pool, async (tx) => {
      await tx.query("INSERT INTO durable_runtime.failure_observations(id,source_dedup_key,runtime_unit_id,attempt_id,pod_uid,execution_epoch,source_kind,source_ref,schema_version,observed_at,evidence,evidence_digest) VALUES($1,$1,$2,$3,$4,1,'SUPERVISOR','synthetic-rollback',1,$5,$6,$7)", [rollbackId, unit, attempt, pod, prepared.input.observedAt, prepared.input, prepared.payloadDigest]);
      await tx.query("INSERT INTO durable_runtime.failure_incident_observations(observation_id,incident_id,runtime_unit_id,attempt_id) VALUES($1,$2,$3,$4)", [rollbackId, incident, unit, attempt]);
      await tx.query("INSERT INTO durable_runtime.failure_incident_aliases(alias_key,incident_id,runtime_unit_id,attempt_id,alias_kind,alias_value) VALUES($1,$2,$3,$4,'TERMINATION','{}')", [rollbackAlias, incident, unit, attempt]);
      await tx.query("UPDATE durable_runtime.failure_incident_state SET revision=revision+1,evidence_ids=array_append(evidence_ids,$2) WHERE incident_id=$1", [incident, rollbackId]);
      rollbackBarrierReached = true;
      throw new Error("synthetic rollback barrier");
    }));
    assert.equal(rollbackBarrierReached, true);
    assert.equal((await query("SELECT id FROM durable_runtime.failure_observations WHERE id=$1", [rollbackId])).rowCount, 0);
    assert.equal((await query("SELECT observation_id FROM durable_runtime.failure_incident_observations WHERE observation_id=$1", [rollbackId])).rowCount, 0);
    assert.equal((await query("SELECT alias_key FROM durable_runtime.failure_incident_aliases WHERE alias_key=$1", [rollbackAlias])).rowCount, 0);
    assert.deepEqual((await query("SELECT revision,evidence_ids FROM durable_runtime.failure_incident_state WHERE incident_id=$1", [incident])).rows[0], { revision: "1", evidence_ids: [input.observationId] });
    const retained = (await query("SELECT evidence,evidence_digest,termination_finished_at FROM durable_runtime.failure_observations WHERE id=$1", [input.observationId])).rows[0];
    assert.deepEqual(retained.evidence, JSON.parse(JSON.stringify(prepared.input)));
    assert.equal(retained.evidence_digest, prepared.payloadDigest);
    assert.equal(retained.termination_finished_at, input.termination?.finishedAt);
    const finalLedger = (await query("SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version")).rows;
    assert.deepEqual(finalLedger, ledger);
    if (process.env.SCHEMA_RESULTS_PATH) {
      await writeFile(process.env.SCHEMA_RESULTS_PATH, JSON.stringify({ distinct_tests: 1, passed: 1, failed: 0, skipped: 0,
        migration_chain: finalLedger, evidence_api: "250bc7eafc93c92df1ed3771da7d63d9dc4922cf",
        synthetic_fixture: true, producer_authentication_verified: false, dev013015_applied: false,
        checks: ["original observation retention", "original timestamp precision", "alias ownership conflict", "original tuple FK", "append-only guards", "fixed deadline", "revision nondecrease", "atomic rollback", "001-014 checksums unchanged"] }, null, 2), { mode: 0o600 });
    }
  } finally {
    await pool.end();
  }
});
