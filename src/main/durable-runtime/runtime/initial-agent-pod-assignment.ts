import { createHash } from "node:crypto";
import { counter, logicalId } from "../../../shared/durable-runtime/identity.ts";
import { DurableDatabaseError, type DurableTransaction } from "../db/connection.ts";
import type { JsonValue } from "../db/atomic.ts";
import { lockAggregates } from "../db/locks.ts";
import type { AgentPodPlanRecord } from "../db/agent-pod-plan-record-rows.ts";
import type { AgentPodCreateObservation } from "../lifecycle/agent-pod-create-types.ts";
import { inventoryName, inventoryNamespace, inventoryOpaque } from "../lifecycle/kubernetes-identity.ts";
import { readAgentPodPlan } from "./agent-pod-plan-records.ts";
import { agentPodFields } from "./agent-pod-policy.ts";
import type { UnauthorizedAgentPodPlan } from "./agent-pod-plan.ts";
import { LockedGatewayAuthority, currentAuthoritySql } from "./gateway/authority.ts";
import { assertOriginal } from "./gateway/store.ts";
import { canonicalInput, inputDigest } from "./gateway/input.ts";
import type { CommandClaim, CommandRow, GatewayContext } from "./gateway/types.ts";

export type InitialAgentPodTargetInput = Readonly<{ claim: CommandClaim; planDigest: string }>;
export type InitialAgentPodAssignmentInput = InitialAgentPodTargetInput & Readonly<{
  observation: AgentPodCreateObservation;
}>;
export type InitialAgentPodAssignmentTarget = Readonly<{
  record: AgentPodPlanRecord; plan: UnauthorizedAgentPodPlan;
  attemptId: string; planDigest: string; unitRevision: string;
  status: "RESERVED" | "POD_ASSIGNED"; podUid: string | null;
  gate: "CLOSED"; providerReady: false; writerGrantActivated: false;
}>;
export type InitialAgentPodAssignment = Readonly<{
  disposition: "ASSIGNED" | "REPLAYED"; visibility: "TRANSACTION_LOCAL";
  attemptId: string; podUid: string; planDigest: string; unitRevision: string;
  resourceVersion: string; gate: "CLOSED"; providerReady: false; writerGrantActivated: false;
}>;
type BindingRow = { id: string; backend_id: string; export_id: string; canonical_directory: string;
  epoch: string; revision: string; access_state: string; writer_attempt_id: string | null;
  identity_proof_ref: string | null; identity_verified_at: Date | null };
type AttemptRow = { id: string; execution_epoch: string; status: string; mode: string; pod_uid: string | null;
  incarnation: string | null; resource_profile_revision: string; effective_resources: JsonValue;
  ready_at: Date | null; started_at: Date | null; stopped_at: Date | null };
type UnitRow = { dataset_name: string; desired_mode: string; phase: string; execution_epoch: string;
  intent_revision: string; active_attempt_id: string | null; revision: string };
type Captured = ReturnType<typeof capture>;
const deny = (code: string): never => { throw new DurableDatabaseError(`INITIAL_AGENT_POD_${code}`); };
const equal = (a: JsonValue, b: JsonValue): boolean => canonicalInput(a) === canonicalInput(b);
function idFor(prefix: string): string {
  const h = createHash("sha256").update(prefix).digest("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
function capture(originalContext: GatewayContext, original: InitialAgentPodTargetInput) {
  const c = originalContext.controller, supplied = original.claim;
  const context: GatewayContext = Object.freeze({ runtimeUnitId: logicalId("runtime-unit", originalContext.runtimeUnitId),
    operationId: logicalId("operation", originalContext.operationId), controller: Object.freeze({ ...c,
      scope: inventoryOpaque(c.scope), owner: inventoryOpaque(c.owner), term: counter("controller-term", c.term) }) });
  const claim: CommandClaim = Object.freeze({ visibility: supplied.visibility, commandId: supplied.commandId,
    executorId: supplied.executorId, executionToken: supplied.executionToken, controllerTerm: supplied.controllerTerm,
    identity: Object.freeze({ command: supplied.identity.command, inputHash: supplied.identity.inputHash,
      originalEnvelope: Object.freeze({ ...supplied.identity.originalEnvelope }) }) });
  const e = claim.identity.originalEnvelope, planDigest = original.planDigest;
  if (typeof planDigest !== "string" || !/^[0-9a-f]{64}$/u.test(planDigest) ||
      claim.visibility !== "TRANSACTION_LOCAL" || claim.identity.command !== "ensureAttempt" ||
      e.operationId !== context.operationId ||
      claim.controllerTerm !== context.controller.term || e.podTarget !== "CREATE_WITHOUT_POD" || e.expectedPodUid !== null) {
    return deny("INPUT");
  }
  return Object.freeze({ context, claim, planDigest });
}
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (typeof value !== "object" || value === null) { return deny("INPUT"); }
  const own = Reflect.ownKeys(value);
  if (own.some(key => typeof key !== "string" || ![...required, ...optional].includes(key)) ||
      required.some(key => !own.includes(key))) { return deny("INPUT"); }
  return agentPodFields(value, own.filter((key): key is string => typeof key === "string"));
}
function resourceSnapshot(value: unknown): JsonValue {
  const record = fields(value, [], ["requests", "limits"]);
  const result: Record<string, JsonValue> = {};
  for (const key of ["requests", "limits"]) {
    if (!record.has(key)) { continue; }
    const quantitiesInput = fields(record.get(key), [], ["cpu", "memory", "ephemeral-storage"]);
    const quantities: Record<string, JsonValue> = {};
    for (const [name, quantity] of quantitiesInput) {
      if (typeof quantity !== "string" || !/^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+|[numkKMGTEP]i?)?$/u.test(quantity) ||
          key === "limits" && (name === "cpu" || name === "memory")) { return deny("OBSERVATION"); }
      quantities[name] = quantity;
    }
    result[key] = Object.freeze(quantities);
  }
  return Object.freeze(result);
}
function captureObservation(original: AgentPodCreateObservation) {
  try {
    const value = fields(original, ["kind", "disposition", "planDigest", "namespace", "name", "pod",
      "postAttempts", "readinessObserved", "physicalPinVerified"], ["reason"]);
    const disposition = value.get("disposition"), pod = agentPodFields(value.get("pod"),
      ["uid", "resourceVersion", "desiredResources", "admittedResources"]);
    if (value.get("kind") !== "AGENT_POD_CREATE_OBSERVATION" ||
        (disposition !== "FOUND" && disposition !== "CREATED") ||
        (value.get("postAttempts") !== 0 && value.get("postAttempts") !== 1) ||
        value.get("readinessObserved") !== false || value.get("physicalPinVerified") !== false) { return deny("OBSERVATION"); }
    const planDigest = value.get("planDigest");
    if (typeof planDigest !== "string" || !/^[0-9a-f]{64}$/u.test(planDigest)) { return deny("OBSERVATION"); }
    return Object.freeze({ planDigest, namespace: inventoryNamespace(value.get("namespace")), name: inventoryName(value.get("name")),
      pod: Object.freeze({ uid: inventoryOpaque(pod.get("uid")), resourceVersion: inventoryOpaque(pod.get("resourceVersion")),
        desiredResources: resourceSnapshot(pod.get("desiredResources")), admittedResources: resourceSnapshot(pod.get("admittedResources")) }) });
  } catch { return deny("OBSERVATION"); }
}
function bodyField(value: JsonValue, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) { return deny("RESERVATION"); }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) { return deny("RESERVATION"); }
  return descriptor.value;
}
async function validated(tx: DurableTransaction, captured: Captured, query: DurableTransaction["query"]) {
  const { context, claim, planDigest } = captured, e = claim.identity.originalEnvelope;
  const record = await readAgentPodPlan(tx, context.operationId);
  if (!record || record.planDigest !== planDigest) { return deny("PLAN"); }
  const plan = record.plan, id = plan.identity, dataset = plan.pod.metadata.labels["orca.dev/dataset"];
  if (id.operationId !== context.operationId || id.unitId !== context.runtimeUnitId ||
      id.executionEpoch !== e.executionEpoch || id.intentRevision !== e.intentRevision) { return deny("PLAN"); }
  const protectedBindings = plan.mountExpectations.protected;
  const members = async () => (await query<{ session_id: string }>(
    "SELECT session_id FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1 ORDER BY session_id", [id.unitId])).rows.map(row => row.session_id);
  const sessions = await members();
  if (!sessions.length) { return deny("MEMBERS"); }
  await lockAggregates(tx, { sessionIds: sessions.map(s => logicalId("session", s)), runtimeUnitIds: [id.unitId] });
  if (!equal(await members(), sessions)) { return deny("MEMBERS_CHANGED"); }
  const associations = async () => (await query<{ storage_binding_id: string }>(
    "SELECT DISTINCT storage_binding_id FROM durable_runtime.runtime_member_storage_bindings WHERE runtime_unit_id=$1 ORDER BY storage_binding_id", [id.unitId])).rows.map(row => row.storage_binding_id);
  const expectedIds = protectedBindings.map(b => b.bindingId).sort(), bindingsBefore = await associations();
  if (!equal(bindingsBefore, expectedIds) || (await query(
    "SELECT id FROM durable_runtime.sessions WHERE id=ANY($1::uuid[]) AND lifecycle='OPEN'", [sessions])).rowCount !== sessions.length) { return deny("BINDING_SET"); }
  const readBindings = async () => (await query<BindingRow>(
    "SELECT * FROM durable_runtime.storage_bindings WHERE id=ANY($1::uuid[]) ORDER BY id", [expectedIds])).rows;
  const beforeDomains = await readBindings();
  if (beforeDomains.length !== expectedIds.length) { return deny("BINDING_SET"); }
  await lockAggregates(tx, { storageDomains: beforeDomains.map(b => ({ backendId: b.backend_id, exportId: b.export_id })) });
  if (!equal(await members(), sessions) || !equal(await associations(), expectedIds)) { return deny("MEMBERS_CHANGED"); }
  const bindings = await readBindings(), authority = await LockedGatewayAuthority.acquire(tx, context);
  const unit = (await query<UnitRow>("SELECT * FROM durable_runtime.runtime_units WHERE id=$1", [id.unitId])).rows[0];
  const operation = (await query<{ kind: string; result: unknown; execution_epoch: string; intent_revision: string;
    controller_term: string; step_revision: string; expected_pod_uid: string | null; external_resource_name: string | null }>(
    "SELECT * FROM durable_runtime.operations WHERE id=$1 AND runtime_unit_id=$2", [id.operationId, id.unitId])).rows[0];
  if (!unit || !operation || unit.dataset_name !== dataset || unit.desired_mode !== "RUNNING" || unit.active_attempt_id !== id.attemptId ||
      unit.execution_epoch !== id.executionEpoch || unit.intent_revision !== id.intentRevision || operation.kind !== "WAKE" || operation.result !== null ||
      operation.execution_epoch !== id.executionEpoch || operation.intent_revision !== id.intentRevision || operation.controller_term !== context.controller.term ||
      operation.step_revision !== e.stepRevision || operation.expected_pod_uid !== null || operation.external_resource_name !== id.resourceName) { return deny("STALE"); }
  const command = (await query<CommandRow>("SELECT * FROM durable_runtime.runtime_commands WHERE id=$1 FOR UPDATE", [claim.commandId])).rows[0];
  if (!command) { return deny("CLAIM"); }
  assertOriginal(command, claim.identity);
  const profileRevision = plan.pod.metadata.annotations["orca.dev/resource-profile-revision"];
  if (command.operation_id !== id.operationId || command.runtime_unit_id !== id.unitId || command.state !== "EXECUTING" ||
      command.executor_id !== claim.executorId || command.execution_token !== claim.executionToken || command.owner_controller_term !== context.controller.term ||
      !equal(command.input, { resourceName: id.resourceName,
        body: { mode: "COLD", planDigest, attemptId: id.attemptId, resourceProfileRevision: profileRevision } })) { return deny("CLAIM"); }
  const prefix = `${id.operationId}:${planDigest}:${claim.commandId}`;
  const reservationId = idFor(`initial-agent-attempt:v1:${prefix}:event`), assignmentId = idFor(`initial-agent-pod-assignment:v1:${prefix}:event`);
  const reservation = (await query<{ next_state: JsonValue }>(
    "SELECT next_state FROM durable_runtime.runtime_audit_events WHERE id=$1 AND kind='INITIAL_AGENT_ATTEMPT_RESERVED' AND runtime_unit_id=$2 AND operation_id=$3 AND attempt_id=$4",
    [reservationId, id.unitId, id.operationId, id.attemptId])).rows[0];
  if (!reservation) { return deny("RESERVATION"); }
  const revisionValue = bodyField(reservation.next_state, "unitRevision");
  if (typeof revisionValue !== "string") { return deny("RESERVATION"); }
  const reservedRevision = counter("row:runtime-unit", revisionValue);
  if (BigInt(reservedRevision) < 1n || bindings.length !== expectedIds.length) { return deny("RESERVATION"); }
  const expected = bindings.map(b => {
    const p = protectedBindings.find(p => p.bindingId === b.id), before = beforeDomains.find(old => old.id === b.id);
    if (!p || !before || before.backend_id !== b.backend_id || before.export_id !== b.export_id || before.canonical_directory !== b.canonical_directory ||
        !b.identity_proof_ref || b.identity_verified_at === null || b.canonical_directory !== `/${dataset}/${p.leafId}` ||
        p.serverPath !== `/exports/runtime-domains${b.canonical_directory}` ||
        b.access_state !== (p.mode === "RW" ? "RESERVED" : "VERIFIED") || b.writer_attempt_id !== (p.mode === "RW" ? id.attemptId : null) ||
        BigInt(b.revision) < (p.mode === "RW" ? 1n : 0n)) { return deny("BINDING"); }
    return { bindingId: b.id, expectedRevision: String(BigInt(b.revision) - (p.mode === "RW" ? 1n : 0n)), storageEpoch: b.epoch };
  }).sort((a, b) => a.bindingId.localeCompare(b.bindingId));
  const executionGrantId = idFor(`initial-agent-attempt:v1:${prefix}:execution`);
  const storageGrants = protectedBindings.filter(p => p.mode === "RW").map(p => ({ bindingId: p.bindingId,
    grantId: idFor(`initial-agent-attempt:v1:${prefix}:storage:${p.bindingId}`), storageEpoch: expected.find(b => b.bindingId === p.bindingId)!.storageEpoch }));
  const reservationEvent = { kind: "INITIAL_AGENT_ATTEMPT_RESERVED", operationId: id.operationId, unitId: id.unitId,
    attemptId: id.attemptId, commandId: claim.commandId, planDigest,
    reservationDigest: inputDigest({ commandId: claim.commandId, executorId: claim.executorId, executionToken: claim.executionToken,
      controllerTerm: claim.controllerTerm, command: claim.identity.command, inputHash: claim.identity.inputHash,
      envelope: { operationId: e.operationId, controllerTerm: e.controllerTerm, stepRevision: e.stepRevision,
        executionEpoch: e.executionEpoch, intentRevision: e.intentRevision, podTarget: e.podTarget, expectedPodUid: e.expectedPodUid },
      planDigest, expectedUnitRevision: String(BigInt(reservedRevision) - 1n), bindings: expected }),
    executionGrantId, storageGrants, unitRevision: reservedRevision, state: "RESERVED", kubernetesExecutionAuthorized: false, physicalPinIssued: false };
  if (!equal(reservation.next_state, reservationEvent)) { return deny("RESERVATION"); }
  async function outbox(eventId: string, revision: string, event: JsonValue): Promise<void> {
    const found = (await query<{ aggregate_id: string; aggregate_kind: string; revision: string; event: JsonValue }>(
      "SELECT aggregate_id,aggregate_kind,revision,event FROM durable_runtime.outbox_events WHERE id=$1", [eventId])).rows[0];
    if (!found || found.aggregate_id !== id.unitId || found.aggregate_kind !== "runtime-unit" || found.revision !== revision || !equal(found.event, event)) { return deny("PARTIAL_RECORD"); }
  }
  await outbox(reservationId, reservedRevision, reservationEvent);
  const attempts = (await query<AttemptRow>("SELECT * FROM durable_runtime.attempts WHERE runtime_unit_id=$1", [id.unitId])).rows;
  const attempt = attempts[0];
  if (attempts.length !== 1 || !attempt || attempt.id !== id.attemptId || attempt.mode !== "COLD" || attempt.execution_epoch !== id.executionEpoch ||
      attempt.resource_profile_revision !== profileRevision || attempt.incarnation !== null || attempt.ready_at !== null || attempt.started_at !== null || attempt.stopped_at !== null) { return deny("ATTEMPT"); }
  const executions = (await query<{ id: string; attempt_id: string; execution_epoch: string; state: string; revision: string }>(
    "SELECT * FROM durable_runtime.execution_grants WHERE runtime_unit_id=$1", [id.unitId])).rows;
  const grant = executions[0];
  if (executions.length !== 1 || !grant || grant.id !== executionGrantId || grant.attempt_id !== id.attemptId ||
      grant.execution_epoch !== id.executionEpoch || grant.state !== "RESERVED" || grant.revision !== "0") { return deny("GRANTS"); }
  const grants = (await query<{ id: string; storage_binding_id: string; storage_epoch: string; state: string; revision: string }>(
    "SELECT * FROM durable_runtime.storage_write_grants WHERE attempt_id=$1", [id.attemptId])).rows;
  if (grants.length !== storageGrants.length || storageGrants.some(g => !grants.some(row => row.id === g.grantId &&
      row.storage_binding_id === g.bindingId && row.storage_epoch === g.storageEpoch && row.state === "RESERVED" && row.revision === "0")) ||
      (await query("SELECT id FROM durable_runtime.storage_mounts WHERE attempt_id=$1", [id.attemptId])).rowCount) { return deny("GRANTS"); }
  const assigned = (await query<{ next_state: JsonValue }>(
    "SELECT next_state FROM durable_runtime.runtime_audit_events WHERE id=$1 AND kind='INITIAL_AGENT_POD_ASSIGNED' AND runtime_unit_id=$2 AND operation_id=$3 AND attempt_id=$4",
    [assignmentId, id.unitId, id.operationId, id.attemptId])).rows[0];
  const assignmentRevision = String(BigInt(reservedRevision) + 1n);
  let assignment: ReturnType<typeof assignmentEvent> | null = null;
  if (assigned) {
    try {
      const value = assigned.next_state, podUid = inventoryOpaque(bodyField(value, "podUid")), rv = inventoryOpaque(bodyField(value, "resourceVersion"));
      assignment = assignmentEvent(captured, record, podUid, rv, resourceSnapshot(bodyField(value, "desiredResources")),
        resourceSnapshot(bodyField(value, "admittedResources")), assignmentRevision);
      if (!equal(value, assignment) || attempt.status !== "POD_ASSIGNED" || attempt.pod_uid !== podUid ||
          !equal(attempt.effective_resources, assignment.admittedResources) || unit.revision !== assignmentRevision || unit.phase !== "PROVISIONING" ||
          !equal(assignment.desiredResources, plan.pod.spec.containers[0].resources)) { return deny("PARTIAL_RECORD"); }
      await outbox(assignmentId, assignmentRevision, assignment);
    } catch { return deny("PARTIAL_RECORD"); }
  } else if (attempt.status !== "RESERVED" || attempt.pod_uid !== null || !equal(attempt.effective_resources, {}) || unit.revision !== reservedRevision ||
      (await query("SELECT id FROM durable_runtime.outbox_events WHERE id=$1", [assignmentId])).rowCount) { return deny("PARTIAL_RECORD"); }
  await authority.assertCurrent();
  return { record, authority, unit, attempt, assignment, assignmentId, assignmentRevision };
}
function assignmentEvent(input: Captured, record: AgentPodPlanRecord, podUid: string, resourceVersion: string,
  desiredResources: JsonValue, admittedResources: JsonValue, unitRevision: string) {
  const id = record.plan.identity;
  return Object.freeze({ kind: "INITIAL_AGENT_POD_ASSIGNED", operationId: id.operationId, unitId: id.unitId,
    attemptId: id.attemptId, commandId: input.claim.commandId, planDigest: input.planDigest, podUid, resourceVersion,
    desiredResources, admittedResources, unitRevision, state: "POD_ASSIGNED", gate: "CLOSED", providerReady: false, writerGrantActivated: false });
}

/** Locked observation of the original plan/reservation only; no CREATE authority. */
export async function readInitialAgentPodAssignmentTarget(tx: DurableTransaction, context: GatewayContext,
  original: InitialAgentPodTargetInput): Promise<InitialAgentPodAssignmentTarget> {
  const input = capture(context, original), query = tx.query.bind(tx);
  const state = await validated(tx, input, query);
  return Object.freeze({ record: state.record, plan: state.record.plan, attemptId: state.attempt.id,
    planDigest: input.planDigest, unitRevision: state.unit.revision, status: state.assignment ? "POD_ASSIGNED" : "RESERVED",
    podUid: state.attempt.pod_uid, gate: "CLOSED", providerReady: false, writerGrantActivated: false });
}

/** Caller owns actual transaction settlement. API object UID/resources do not
 * authenticate an incarnation, open the gate, settle a command or activate RW. */
export async function assignInitialAgentPod(tx: DurableTransaction, context: GatewayContext,
  original: InitialAgentPodAssignmentInput): Promise<InitialAgentPodAssignment> {
  const input = capture(context, original), observed = captureObservation(original.observation), query = tx.query.bind(tx);
  const state = await validated(tx, input, query), plan = state.record.plan;
  if (observed.planDigest !== input.planDigest || observed.namespace !== plan.pod.metadata.namespace ||
      observed.name !== plan.identity.resourceName || !equal(observed.pod.desiredResources, plan.pod.spec.containers[0].resources)) { return deny("OBSERVATION_CONFLICT"); }
  const result = (disposition: "ASSIGNED" | "REPLAYED", rv: string): InitialAgentPodAssignment => Object.freeze({ disposition,
    visibility: "TRANSACTION_LOCAL", attemptId: plan.identity.attemptId, podUid: observed.pod.uid, planDigest: input.planDigest,
    unitRevision: state.assignmentRevision, resourceVersion: rv, gate: "CLOSED", providerReady: false, writerGrantActivated: false });
  if (state.assignment) {
    if (state.assignment.podUid !== observed.pod.uid || !equal(state.assignment.admittedResources, observed.pod.admittedResources)) { return deny("ASSIGNMENT_CONFLICT"); }
    return result("REPLAYED", state.assignment.resourceVersion);
  }
  const event = assignmentEvent(input, state.record, observed.pod.uid, observed.pod.resourceVersion,
    observed.pod.desiredResources, observed.pod.admittedResources, state.assignmentRevision);
  const auth = [input.context.controller.scope, input.context.controller.owner, input.context.controller.term];
  async function write(sql: string, values: readonly unknown[]): Promise<void> {
    if ((await query(sql, [...auth, ...values])).rowCount !== 1) { return deny("STALE"); }
  }
  await write(`UPDATE durable_runtime.attempts SET pod_uid=$5,status='POD_ASSIGNED',effective_resources=$6::jsonb
    WHERE id=$4 AND pod_uid IS NULL AND incarnation IS NULL AND status='RESERVED'
    AND started_at IS NULL AND ready_at IS NULL AND stopped_at IS NULL AND ${currentAuthoritySql} RETURNING id`,
  [plan.identity.attemptId, observed.pod.uid, canonicalInput(observed.pod.admittedResources)]);
  await write(`UPDATE durable_runtime.runtime_units SET phase='PROVISIONING',revision=revision+1
    WHERE id=$4 AND revision=$5 AND active_attempt_id=$6 AND desired_mode='RUNNING' AND ${currentAuthoritySql} RETURNING id`,
  [plan.identity.unitId, state.unit.revision, plan.identity.attemptId]);
  await write(`INSERT INTO durable_runtime.runtime_audit_events(id,actor_id,runtime_unit_id,operation_id,attempt_id,kind,next_state,
    occurred_at,received_at,producer_id,producer_seq,evidence_refs,payload)
    SELECT $4,$2,$5,$6,$7,'INITIAL_AGENT_POD_ASSIGNED',$8::jsonb,clock_timestamp(),clock_timestamp(),$4,1,'[]'::jsonb,'{}'::jsonb
    WHERE ${currentAuthoritySql} RETURNING id`, [state.assignmentId, plan.identity.unitId, plan.identity.operationId, plan.identity.attemptId, canonicalInput(event)]);
  await write(`INSERT INTO durable_runtime.outbox_events(id,aggregate_id,aggregate_kind,revision,event,created_at)
    SELECT $4,$5,'runtime-unit',$6,$7::jsonb,clock_timestamp() WHERE ${currentAuthoritySql} RETURNING id`,
  [state.assignmentId, plan.identity.unitId, state.assignmentRevision, canonicalInput(event)]);
  await state.authority.assertCurrent();
  return result("ASSIGNED", observed.pod.resourceVersion);
}
