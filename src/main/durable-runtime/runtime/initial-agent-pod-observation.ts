import { DurableDatabaseError } from "../db/connection.ts";
import type { JsonValue } from "../db/atomic.ts";
import type { AgentPodCreateObservation } from "../lifecycle/agent-pod-create-types.ts";
import { inventoryName, inventoryNamespace, inventoryOpaque } from "../lifecycle/kubernetes-identity.ts";
import { agentPodFields } from "./agent-pod-policy.ts";

const deny = (code: string): never => { throw new DurableDatabaseError(`INITIAL_AGENT_POD_${code}`); };
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (typeof value !== "object" || value === null) { return deny("INPUT"); }
  const own = Reflect.ownKeys(value);
  if (own.some(key => typeof key !== "string" || ![...required, ...optional].includes(key)) ||
      required.some(key => !own.includes(key))) { return deny("INPUT"); }
  return agentPodFields(value, own.filter((key): key is string => typeof key === "string"));
}
export function resourceSnapshot(value: unknown): JsonValue {
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
export function captureObservation(original: AgentPodCreateObservation) {
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
