import type { Pool } from "pg";
import { DurableDatabaseError, safeDatabaseError } from "../db/connection.ts";
import {
  beginNamespaceManagement, claimNamespaceManagement, completeNamespaceManagement,
  readNamespaceManagement,
} from "./namespace-holds.ts";
import type { NamespaceManagementInput, NamespaceTransactionResult } from "./namespace-holds.ts";

// Internal adapter input only. It carries no owner token, shell command, storage
// grant, physical directory evidence, or authority to bypass the original claim.
export type NamespaceManagementTarget = Readonly<{
  profileId: string; datasetName: string; backendId: string; exportId: string;
  operationId: string; generation: string; digest: string;
  targetGeneration: string; targetDigest: string;
}>;
export type NamespaceManagementObservation = Readonly<{ status: "PENDING" }> |
  (NamespaceManagementTarget & Readonly<{ status: "APPLIED" }>);
export type TrustedNamespaceManagementPort = Readonly<{
  apply(target: NamespaceManagementTarget): Promise<NamespaceManagementObservation>;
  lookup(target: NamespaceManagementTarget): Promise<NamespaceManagementObservation>;
}>;
type Phase = "BEGIN" | "CLAIM" | "READ" | "COMPLETE";
type DatabaseStep = Readonly<{ phase: Phase; result: NamespaceTransactionResult }>;
export type NamespaceManagementExecutionResult = Readonly<{
  // Exact results from the existing engine, including uncertain commit/cleanup.
  database: NamespaceTransactionResult | null;
  transactions: readonly DatabaseStep[];
  databaseError: DurableDatabaseError | null;
  effectAttempted: boolean;
  lookupAttempted: boolean;
  observation: NamespaceManagementObservation | null;
  effectError: "NAMESPACE_MANAGEMENT_PORT_FAILED" | "NAMESPACE_MANAGEMENT_RESULT_CONFLICT" | null;
  rereadRequired: boolean;
}>;

function acknowledged(result: NamespaceTransactionResult): boolean {
  return result.database.ok && result.database.settlement === "COMMITTED" &&
    result.database.commitOutcome === "ACKNOWLEDGED" && !result.database.cleanupFailed;
}

function observation(value: NamespaceManagementObservation,
  target: NamespaceManagementTarget): NamespaceManagementObservation | null {
  if (typeof value !== "object" || value === null) { return null; }
  if (value.status === "PENDING") { return Object.freeze({ status: "PENDING" }); }
  if (value.status !== "APPLIED") { return null; }
  // Capture only the fixed tuple; never retain an adapter's raw response body.
  const captured = Object.freeze({ status: "APPLIED" as const,
    profileId: value.profileId, datasetName: value.datasetName,
    backendId: value.backendId, exportId: value.exportId, operationId: value.operationId,
    generation: value.generation, digest: value.digest,
    targetGeneration: value.targetGeneration, targetDigest: value.targetDigest });
  return captured.profileId === target.profileId && captured.datasetName === target.datasetName &&
    captured.backendId === target.backendId && captured.exportId === target.exportId &&
    captured.operationId === target.operationId && captured.generation === target.generation &&
    captured.digest === target.digest && captured.targetGeneration === target.targetGeneration &&
    captured.targetDigest === target.targetDigest ? captured : null;
}

// No retry/timer, process-local ownership map, or external effect inside a DB
// transaction. The caller supplies an already trusted internal adapter.
export async function executeNamespaceManagement(pool: Pool, original: NamespaceManagementInput,
  port: TrustedNamespaceManagementPort): Promise<NamespaceManagementExecutionResult> {
  const input = Object.freeze({ profileId: original.profileId, datasetName: original.datasetName,
    backendId: original.backendId, exportId: original.exportId, generation: original.generation,
    digest: original.digest, actorId: original.actorId, operationId: original.operationId,
    ownerToken: original.ownerToken, targetGeneration: original.targetGeneration,
    targetDigest: original.targetDigest });
  const target: NamespaceManagementTarget = Object.freeze({ profileId: input.profileId,
    datasetName: input.datasetName, backendId: input.backendId, exportId: input.exportId,
    operationId: input.operationId, generation: input.generation, digest: input.digest,
    targetGeneration: input.targetGeneration, targetDigest: input.targetDigest });
  const apply = port.apply, lookup = port.lookup, connect = pool.connect;
  if (typeof apply !== "function" || typeof lookup !== "function" || typeof connect !== "function") {
    throw new DurableDatabaseError("NAMESPACE_MANAGEMENT_PORT_INVALID");
  }
  // Capture borrowed Pool receiver and connect method before the first await.
  const borrowed = new Proxy(pool, { get(owner, key, receiver) {
    return key === "connect" ? () => Reflect.apply(connect, pool, []) : Reflect.get(owner, key, receiver);
  } });
  const steps: DatabaseStep[] = [];
  let database: NamespaceTransactionResult | null = null;
  let databaseError: DurableDatabaseError | null = null;
  let effectAttempted = false, lookupAttempted = false;
  let observed: NamespaceManagementObservation | null = null;
  let effectError: NamespaceManagementExecutionResult["effectError"] = null;
  const finish = (rereadRequired: boolean): NamespaceManagementExecutionResult => Object.freeze({
    database, transactions: Object.freeze([...steps]), databaseError,
    effectAttempted, lookupAttempted, observation: observed, effectError, rereadRequired,
  });
  const remember = (phase: Phase, result: NamespaceTransactionResult): NamespaceTransactionResult => {
    database = result;
    steps.push(Object.freeze({ phase, result }));
    return result;
  };
  let action: "APPLY" | "LOOKUP";
  try {
    let result = remember("BEGIN", await beginNamespaceManagement(borrowed, input));
    if (!acknowledged(result)) { return finish(true); }
    if (result.disposition?.status === "ALREADY_COMPLETED") { return finish(false); }
    if (result.disposition?.status === "READY_TO_CLAIM") {
      result = remember("CLAIM", await claimNamespaceManagement(borrowed, input));
      if (!acknowledged(result)) { return finish(true); }
    }
    if (result.disposition?.status === "ALREADY_COMPLETED") { return finish(false); }
    if (result.disposition?.status === "EXECUTE") {
      action = "APPLY";
    } else if (result.disposition?.status === "LOOKUP_REQUIRED") {
      result = remember("READ", await readNamespaceManagement(borrowed, input));
      if (!acknowledged(result)) { return finish(true); }
      if (result.disposition?.status === "ALREADY_COMPLETED") { return finish(false); }
      if (result.disposition?.status !== "LOOKUP_REQUIRED") { return finish(true); }
      action = "LOOKUP";
    } else {
      // WAITING never calls the adapter. Other dispositions fail closed too.
      return finish(true);
    }
  } catch (error) {
    databaseError = safeDatabaseError(error);
    return finish(true);
  }
  try {
    let value: NamespaceManagementObservation;
    if (action === "APPLY") {
      effectAttempted = true;
      value = await Reflect.apply(apply, port, [target]);
    } else {
      lookupAttempted = true;
      value = await Reflect.apply(lookup, port, [target]);
    }
    observed = observation(value, target);
    if (!observed) {
      effectError = "NAMESPACE_MANAGEMENT_RESULT_CONFLICT";
      return finish(true);
    }
  } catch {
    // Do not expose credentials, raw transport errors, or response bodies.
    effectError = "NAMESPACE_MANAGEMENT_PORT_FAILED";
    return finish(true);
  }
  if (observed.status === "PENDING") { return finish(true); }
  try {
    const result = remember("COMPLETE", await completeNamespaceManagement(borrowed, input, observed));
    return finish(!acknowledged(result) ||
      (result.disposition?.status !== "COMPLETED" && result.disposition?.status !== "ALREADY_COMPLETED"));
  } catch (error) {
    databaseError = safeDatabaseError(error);
    return finish(true);
  }
}
