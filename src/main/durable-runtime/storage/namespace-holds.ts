import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { DurableDatabaseError, runDurableTransaction, type DurableTransaction,
  type DurableTransactionResult } from "../db/connection.ts";
import { lockAggregates } from "../db/locks.ts";
import { appendAudit, enqueueOutbox } from "../journal/store.ts";
import { counter, logicalId } from "../../../shared/durable-runtime/identity.ts";

// Server-internal management coordination. No file-writer fence, directory
// evidence issuer, public authentication boundary, or physical pin is supplied.
export type NamespaceProfileInput = Readonly<{
  profileId: string; datasetName: string; backendId: string; exportId: string;
  generation: string; digest: string; actorId: string;
}>;
export type NamespaceHoldInput = NamespaceProfileInput & Readonly<{ pinId: string; ownerToken: string }>;
export type NamespaceManagementInput = NamespaceProfileInput & Readonly<{
  operationId: string; ownerToken: string; targetGeneration: string; targetDigest: string;
}>;
// The caller must already trust the management result. This DTO does not verify
// external mutation completion and cannot be cast into directory evidence.
export type TrustedNamespaceManagementResult = Readonly<{
  status: "APPLIED"; profileId: string; operationId: string;
  generation: string; targetGeneration: string; targetDigest: string;
}>;
export type NamespaceDisposition = Readonly<{
  status: "REGISTERED" | "ALREADY_REGISTERED" | "ACQUIRED" | "ALREADY_HELD" |
    "RELEASED" | "ALREADY_RELEASED" | "WAITING" | "READY_TO_CLAIM" |
    "EXECUTE" | "LOOKUP_REQUIRED" | "COMPLETED" | "ALREADY_COMPLETED";
  profileId: string; generation: string; digest: string;
  pinId: string | null; operationId: string | null;
}>;
export type NamespaceTransactionResult = Readonly<{
  database: DurableTransactionResult<NamespaceDisposition>;
  disposition: NamespaceDisposition | null;
}>;
type ProfileRow = { id: string; dataset_name: string; backend_id: string; export_id: string;
  generation: string; digest: string; state: string; management_operation_id: string | null; revision: string };
type HoldRow = { id: string; profile_id: string; generation: string; digest: string;
  owner_token_hash: string; state: string };
type OperationRow = { id: string; profile_id: string; generation: string; digest: string;
  owner_token_hash: string; target_generation: string; target_digest: string; state: string };

function deny(code: string): never { throw new DurableDatabaseError(code); }
function text(value: string): string {
  if (typeof value !== "string" || !value || value.length > 512 || /[\x00-\x1f]/.test(value)) {
    deny("NAMESPACE_INPUT_INVALID");
  }
  return value;
}
function digest(value: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) { deny("NAMESPACE_DIGEST_INVALID"); }
  return value;
}
function tokenHash(value: string): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 512 || /[\x00-\x1f]/.test(value)) {
    deny("NAMESPACE_TOKEN_INVALID");
  }
  return createHash("sha256").update(value).digest("hex");
}
function capture(original: NamespaceProfileInput): NamespaceProfileInput {
  return Object.freeze({ profileId: logicalId("storage-namespace-profile", original.profileId),
    datasetName: text(original.datasetName), backendId: text(original.backendId), exportId: text(original.exportId),
    generation: counter("namespace-generation", original.generation), digest: digest(original.digest),
    actorId: text(original.actorId) });
}
function captureHold(original: NamespaceHoldInput) {
  return Object.freeze({ ...capture(original), pinId: logicalId("storage-namespace-pin", original.pinId),
    tokenHash: tokenHash(original.ownerToken) });
}
function captureManagement(original: NamespaceManagementInput) {
  const input = Object.freeze({ ...capture(original),
    operationId: logicalId("storage-namespace-operation", original.operationId), tokenHash: tokenHash(original.ownerToken),
    targetGeneration: counter("namespace-generation", original.targetGeneration), targetDigest: digest(original.targetDigest) });
  if (BigInt(input.targetGeneration) !== BigInt(input.generation) + 1n) { deny("NAMESPACE_GENERATION_INVALID"); }
  return input;
}
function execute(pool: Pool, body: (tx: DurableTransaction) => Promise<NamespaceDisposition>): Promise<NamespaceTransactionResult> {
  // Capture the borrowed receiver/method before the first await; never end it.
  const connect = pool.connect;
  const borrowed = new Proxy(pool, { get(target, key, receiver) {
    return key === "connect" ? () => Reflect.apply(connect, pool, []) : Reflect.get(target, key, receiver);
  } });
  return runDurableTransaction(borrowed, body).then((database) =>
    Object.freeze({ database, disposition: database.ok ? database.value : null }));
}
function disposition(input: NamespaceProfileInput, status: NamespaceDisposition["status"],
  pinId: string | null = null, operationId: string | null = null): NamespaceDisposition {
  return Object.freeze({ status, profileId: input.profileId, generation: input.generation,
    digest: input.digest, pinId, operationId });
}
async function profile(tx: DurableTransaction, input: NamespaceProfileInput): Promise<ProfileRow> {
  const query = tx.query.bind(tx);
  await lockAggregates(tx, { storageDomains: [{ backendId: input.backendId, exportId: input.exportId }] });
  const found = await query<ProfileRow>("SELECT * FROM durable_runtime.storage_namespace_profiles WHERE id=$1 FOR UPDATE", [input.profileId]);
  const row = found.rows[0];
  if (!row || row.dataset_name !== input.datasetName || row.backend_id !== input.backendId || row.export_id !== input.exportId) {
    deny("NAMESPACE_PROFILE_SCOPE");
  }
  return row;
}
function exactVersion(row: ProfileRow, input: NamespaceProfileInput): void {
  if (row.generation !== input.generation || row.digest !== input.digest) { deny("NAMESPACE_PROFILE_STALE"); }
}
function exactHold(row: HoldRow, input: ReturnType<typeof captureHold>): void {
  if (row.profile_id !== input.profileId || row.generation !== input.generation || row.digest !== input.digest ||
      row.owner_token_hash !== input.tokenHash) { deny("NAMESPACE_PIN_CONFLICT"); }
}
function exactOperation(row: OperationRow, input: ReturnType<typeof captureManagement>): void {
  if (row.profile_id !== input.profileId || row.generation !== input.generation || row.digest !== input.digest ||
      row.owner_token_hash !== input.tokenHash || row.target_generation !== input.targetGeneration || row.target_digest !== input.targetDigest) {
    deny("NAMESPACE_OPERATION_CONFLICT");
  }
}
async function held(tx: DurableTransaction, profileId: string): Promise<boolean> {
  const found = await tx.query("SELECT id FROM durable_runtime.storage_namespace_holds WHERE profile_id=$1 AND state='HELD' LIMIT 1", [profileId]);
  return found.rowCount === 1;
}
async function event(tx: DurableTransaction, input: NamespaceProfileInput, value: NamespaceDisposition): Promise<void> {
  const row = await tx.query<{ revision: string }>("SELECT revision FROM durable_runtime.storage_namespace_profiles WHERE id=$1", [input.profileId]);
  const payload = { kind: "STORAGE_NAMESPACE_TRANSITION", ...value };
  const now = new Date();
  const auditId = await appendAudit(tx, { actorId: input.actorId, kind: payload.kind, nextState: payload,
    occurredAt: now, receivedAt: now, producerId: randomUUID(), producerSeq: counter("sequence:producer", "1"), evidenceRefs: [] });
  await enqueueOutbox(tx, { eventId: logicalId("event", auditId), aggregateId: input.profileId,
    aggregateKind: "storage-namespace-profile", revision: counter("row:storage-namespace-profile", row.rows[0].revision), event: payload });
}
async function changed(tx: DurableTransaction, input: NamespaceProfileInput, value: NamespaceDisposition): Promise<NamespaceDisposition> {
  await event(tx, input, value);
  return value;
}

export function registerNamespaceProfile(pool: Pool, original: NamespaceProfileInput): Promise<NamespaceTransactionResult> {
  const input = capture(original);
  return execute(pool, async (tx) => {
    const query = tx.query.bind(tx);
    await lockAggregates(tx, { storageDomains: [{ backendId: input.backendId, exportId: input.exportId }] });
    const old = await query<ProfileRow>("SELECT * FROM durable_runtime.storage_namespace_profiles WHERE id=$1 FOR UPDATE", [input.profileId]);
    if (old.rowCount) {
      const row = old.rows[0];
      if (row.dataset_name !== input.datasetName || row.backend_id !== input.backendId || row.export_id !== input.exportId) { deny("NAMESPACE_PROFILE_SCOPE"); }
      exactVersion(row, input);
      return disposition(input, "ALREADY_REGISTERED");
    }
    await query(`INSERT INTO durable_runtime.storage_namespace_profiles(id,dataset_name,backend_id,export_id,generation,digest,state)
      VALUES($1,$2,$3,$4,$5,$6,'ACTIVE')`, [input.profileId, input.datasetName, input.backendId, input.exportId, input.generation, input.digest]);
    await query("INSERT INTO durable_runtime.storage_namespace_profile_versions(profile_id,generation,digest) VALUES($1,$2,$3)", [input.profileId, input.generation, input.digest]);
    return changed(tx, input, disposition(input, "REGISTERED"));
  });
}
export function acquireNamespaceHold(pool: Pool, original: NamespaceHoldInput): Promise<NamespaceTransactionResult> {
  const input = captureHold(original);
  return execute(pool, async (tx) => {
    const query = tx.query.bind(tx);
    const row = await profile(tx, input);
    const existing = await query<HoldRow>("SELECT * FROM durable_runtime.storage_namespace_holds WHERE id=$1", [input.pinId]);
    if (existing.rowCount) {
      exactHold(existing.rows[0], input);
      return disposition(input, existing.rows[0].state === "HELD" ? "ALREADY_HELD" : "ALREADY_RELEASED", input.pinId);
    }
    exactVersion(row, input);
    if (row.state !== "ACTIVE") { deny("NAMESPACE_PROFILE_NOT_ACTIVE"); }
    await query(`INSERT INTO durable_runtime.storage_namespace_holds(id,profile_id,generation,digest,owner_token_hash,state)
      VALUES($1,$2,$3,$4,$5,'HELD')`, [input.pinId, input.profileId, input.generation, input.digest, input.tokenHash]);
    return changed(tx, input, disposition(input, "ACQUIRED", input.pinId));
  });
}
export function readNamespaceHold(pool: Pool, original: NamespaceHoldInput): Promise<NamespaceTransactionResult> {
  const input = captureHold(original);
  return execute(pool, async (tx) => {
    const query = tx.query.bind(tx);
    await profile(tx, input);
    const found = await query<HoldRow>("SELECT * FROM durable_runtime.storage_namespace_holds WHERE id=$1", [input.pinId]);
    if (!found.rowCount) { deny("NAMESPACE_PIN_MISSING"); }
    exactHold(found.rows[0], input);
    return disposition(input, found.rows[0].state === "HELD" ? "ALREADY_HELD" : "ALREADY_RELEASED", input.pinId);
  });
}
export function releaseNamespaceHold(pool: Pool, original: NamespaceHoldInput): Promise<NamespaceTransactionResult> {
  const input = captureHold(original);
  return execute(pool, async (tx) => {
    const query = tx.query.bind(tx);
    await profile(tx, input);
    const found = await query<HoldRow>("SELECT * FROM durable_runtime.storage_namespace_holds WHERE id=$1", [input.pinId]);
    if (!found.rowCount) { deny("NAMESPACE_PIN_MISSING"); }
    exactHold(found.rows[0], input);
    if (found.rows[0].state === "RELEASED") { return disposition(input, "ALREADY_RELEASED", input.pinId); }
    await query("UPDATE durable_runtime.storage_namespace_holds SET state='RELEASED',released_at=clock_timestamp() WHERE id=$1", [input.pinId]);
    return changed(tx, input, disposition(input, "RELEASED", input.pinId));
  });
}
async function operation(tx: DurableTransaction, input: ReturnType<typeof captureManagement>): Promise<OperationRow> {
  const found = await tx.query<OperationRow>("SELECT * FROM durable_runtime.storage_namespace_management_operations WHERE id=$1", [input.operationId]);
  if (!found.rowCount) { deny("NAMESPACE_OPERATION_MISSING"); }
  exactOperation(found.rows[0], input);
  return found.rows[0];
}
function completed(input: NamespaceProfileInput, op: OperationRow): NamespaceDisposition {
  return disposition({ ...input, generation: op.target_generation, digest: op.target_digest },
    "ALREADY_COMPLETED", null, op.id);
}
export function readNamespaceManagement(pool: Pool, original: NamespaceManagementInput): Promise<NamespaceTransactionResult> {
  const input = captureManagement(original);
  return execute(pool, async (tx) => {
    await profile(tx, input);
    const op = await operation(tx, input);
    if (op.state === "COMPLETED") { return completed(input, op); }
    const status = op.state === "APPLYING" ? "LOOKUP_REQUIRED" : await held(tx, input.profileId) ? "WAITING" : "READY_TO_CLAIM";
    return disposition(input, status, null, input.operationId);
  });
}
export function beginNamespaceManagement(pool: Pool, original: NamespaceManagementInput): Promise<NamespaceTransactionResult> {
  const input = captureManagement(original);
  return execute(pool, async (tx) => {
    const query = tx.query.bind(tx);
    const row = await profile(tx, input);
    const old = await query<OperationRow>("SELECT * FROM durable_runtime.storage_namespace_management_operations WHERE id=$1", [input.operationId]);
    if (old.rowCount) {
      exactOperation(old.rows[0], input);
      if (old.rows[0].state === "COMPLETED") { return completed(input, old.rows[0]); }
      const status = old.rows[0].state === "APPLYING" ? "LOOKUP_REQUIRED" : await held(tx, input.profileId) ? "WAITING" : "READY_TO_CLAIM";
      return disposition(input, status, null, input.operationId);
    }
    exactVersion(row, input);
    if (row.state !== "ACTIVE") { deny("NAMESPACE_PROFILE_NOT_ACTIVE"); }
    await query(`INSERT INTO durable_runtime.storage_namespace_management_operations
      (id,profile_id,generation,digest,owner_token_hash,target_generation,target_digest,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,'DRAINING')`, [input.operationId, input.profileId, input.generation, input.digest, input.tokenHash, input.targetGeneration, input.targetDigest]);
    await query("UPDATE durable_runtime.storage_namespace_profiles SET state='DRAINING',management_operation_id=$2,revision=revision+1 WHERE id=$1", [input.profileId, input.operationId]);
    return changed(tx, input, disposition(input, await held(tx, input.profileId) ? "WAITING" : "READY_TO_CLAIM", null, input.operationId));
  });
}
export function claimNamespaceManagement(pool: Pool, original: NamespaceManagementInput): Promise<NamespaceTransactionResult> {
  const input = captureManagement(original);
  return execute(pool, async (tx) => {
    const query = tx.query.bind(tx);
    const row = await profile(tx, input);
    const op = await operation(tx, input);
    if (op.state === "COMPLETED") { return completed(input, op); }
    if (op.state === "APPLYING") { return disposition(input, "LOOKUP_REQUIRED", null, input.operationId); }
    exactVersion(row, input);
    if (row.state !== "DRAINING" || row.management_operation_id !== input.operationId) { deny("NAMESPACE_OPERATION_CONFLICT"); }
    if (await held(tx, input.profileId)) { return disposition(input, "WAITING", null, input.operationId); }
    await query("UPDATE durable_runtime.storage_namespace_management_operations SET state='APPLYING',claimed_at=clock_timestamp() WHERE id=$1", [input.operationId]);
    await query("UPDATE durable_runtime.storage_namespace_profiles SET state='APPLYING',revision=revision+1 WHERE id=$1", [input.profileId]);
    return changed(tx, input, disposition(input, "EXECUTE", null, input.operationId));
  });
}
export function completeNamespaceManagement(pool: Pool, original: NamespaceManagementInput,
  originalResult: TrustedNamespaceManagementResult): Promise<NamespaceTransactionResult> {
  const input = captureManagement(original);
  const result = Object.freeze({ status: originalResult.status, profileId: originalResult.profileId,
    operationId: originalResult.operationId, generation: originalResult.generation,
    targetGeneration: originalResult.targetGeneration, targetDigest: originalResult.targetDigest });
  if (result.status !== "APPLIED" || result.profileId !== input.profileId || result.operationId !== input.operationId ||
      result.generation !== input.generation || result.targetGeneration !== input.targetGeneration || result.targetDigest !== input.targetDigest) {
    deny("NAMESPACE_MANAGEMENT_RESULT_CONFLICT");
  }
  return execute(pool, async (tx) => {
    const query = tx.query.bind(tx);
    const row = await profile(tx, input);
    const op = await operation(tx, input);
    if (op.state === "COMPLETED") { return completed(input, op); }
    exactVersion(row, input);
    if (row.state !== "APPLYING" || op.state !== "APPLYING" || row.management_operation_id !== input.operationId) { deny("NAMESPACE_OPERATION_NOT_CLAIMED"); }
    await query("UPDATE durable_runtime.storage_namespace_management_operations SET state='COMPLETED',completed_at=clock_timestamp() WHERE id=$1", [input.operationId]);
    await query("INSERT INTO durable_runtime.storage_namespace_profile_versions(profile_id,generation,digest) VALUES($1,$2,$3)", [input.profileId, input.targetGeneration, input.targetDigest]);
    await query("UPDATE durable_runtime.storage_namespace_profiles SET state='ACTIVE',management_operation_id=NULL,generation=$2,digest=$3,revision=revision+1 WHERE id=$1", [input.profileId, input.targetGeneration, input.targetDigest]);
    return changed(tx, input, disposition({ ...input, generation: input.targetGeneration, digest: input.targetDigest }, "COMPLETED", null, input.operationId));
  });
}
