import { managedLeafInspectCommand } from "./managed-leaf-collector-exec.ts";
import type { NamespaceFreezePolicyInput } from "./namespace-freeze-policy-input.ts";

/** CEL string/list literals, never caller-provided expression or shell source. */
export const celLiteral = (value: string | readonly string[]): string => JSON.stringify(value);
const uuid = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
export function serviceSelected(object: string, input: NamespaceFreezePolicyInput): string {
  return `(${object} != null && has(${object}.metadata.labels) && ${Object.entries(input.service.selector)
    .map(([key, value]) => `(${celLiteral(key)} in ${object}.metadata.labels && ${object}.metadata.labels[${celLiteral(key)}] == ${celLiteral(value)})`).join(" && ")})`;
}
function prefix(object: string, input: NamespaceFreezePolicyInput): string {
  const value = celLiteral(input.podNamePrefix);
  return `((has(${object}.metadata.name) && ${object}.metadata.name.startsWith(${value})) || ` +
    `(has(${object}.metadata.generateName) && ${object}.metadata.generateName.startsWith(${value})))`;
}
function backingClaim(object: string, input: NamespaceFreezePolicyInput): string {
  return `(has(${object}.spec.volumes) && ${object}.spec.volumes.exists(v, has(v.persistentVolumeClaim) && ` +
    `v.persistentVolumeClaim.claimName == ${celLiteral(input.backingPvc.name)}))`;
}
export function protectedPod(object: string, input: NamespaceFreezePolicyInput): string {
  return `(${object} != null && (${serviceSelected(object, input)} || ${backingClaim(object, input)} || ` +
    `(has(${object}.metadata.ownerReferences) && ${object}.metadata.ownerReferences.exists(r, ` +
    `r.kind == "ReplicaSet" && (r.name == ${celLiteral(input.replicaSet.name)} || r.uid == ${celLiteral(input.replicaSet.uid)}))) || ` +
    `${prefix(object, input)}))`;
}
export function recoveryPod(input: NamespaceFreezePolicyInput): string {
  return `(request.userInfo.username in ${celLiteral(input.recoveryUsernames)} && ${prefix("object", input)} && ` +
    `${serviceSelected("object", input)} && ${backingClaim("object", input)} && ` +
    `has(object.metadata.ownerReferences) && size(object.metadata.ownerReferences) == 1 && ` +
    `object.metadata.ownerReferences.all(r, r.apiVersion == "apps/v1" && r.kind == "ReplicaSet" && ` +
    `r.name == ${celLiteral(input.replicaSet.name)} && r.uid == ${celLiteral(input.replicaSet.uid)} && has(r.controller) && r.controller))`;
}
export function metadataOnlyPodUpdate(input: NamespaceFreezePolicyInput): string {
  const selectedLabelsUnchanged = Object.keys(input.service.selector).map(key => {
    const k = celLiteral(key);
    return `((has(object.metadata.labels) && ${k} in object.metadata.labels) == ` +
      `(has(oldObject.metadata.labels) && ${k} in oldObject.metadata.labels) && ` +
      `(!(has(object.metadata.labels) && ${k} in object.metadata.labels) || object.metadata.labels[${k}] == oldObject.metadata.labels[${k}]))`;
  }).join(" && ");
  return `(object != null && oldObject != null && object.spec == oldObject.spec && ` +
    `object.metadata.name == oldObject.metadata.name && object.metadata.uid == oldObject.metadata.uid && ` +
    `has(object.metadata.generateName) == has(oldObject.metadata.generateName) && ` +
    `(!has(object.metadata.generateName) || object.metadata.generateName == oldObject.metadata.generateName) && ` +
    `has(object.metadata.ownerReferences) == has(oldObject.metadata.ownerReferences) && ` +
    `(!has(object.metadata.ownerReferences) || object.metadata.ownerReferences == oldObject.metadata.ownerReferences) && ${selectedLabelsUnchanged})`;
}
export function collectorExec(input: NamespaceFreezePolicyInput): string {
  // The first branch exactly matches managedLeafExecUrl's nine separate argv values.
  // UUID arguments remain separate; helper checks the actual Downward API Pod UID.
  const inspect = `size(object.command) == 9 && object.command[0] == "/bin/sh" && object.command[1] == "-ec" && ` +
    `object.command[2] == ${celLiteral(managedLeafInspectCommand)} && object.command[3] == "orca-managed-leaf-collector" && ` +
    `object.command[4] == ${celLiteral(input.helperConfigMap.sha256)} && object.command[5] == ${celLiteral(input.exportsConfigMap.sha256)} && ` +
    `object.command[6].matches(${celLiteral(uuid)}) && object.command[7] == ${celLiteral(input.dataset)} && object.command[8].matches(${celLiteral(uuid)})`;
  const helper = `size(object.command) == 6 && object.command[0] == "/bin/sh" && ` +
    `object.command[1] == "/opt/orca-nfs-tools/managed_storage.sh" && object.command[2] in ["ensure-leaf", "inspect-leaf"] && ` +
    `object.command[3].matches(${celLiteral(uuid)}) && object.command[4] == ${celLiteral(input.dataset)} && object.command[5].matches(${celLiteral(uuid)})`;
  return `(request.userInfo.username in ${celLiteral(input.collectorUsernames)} && request.subResource == "exec" && ` +
    `object != null && has(object.container) && object.container == "unfs3" && ` +
    `(!has(object.stdin) || !object.stdin) && (!has(object.tty) || !object.tty) && ` +
    `has(object.stdout) && object.stdout && has(object.stderr) && object.stderr && has(object.command) && ((${inspect}) || (${helper})))`;
}
export function serviceEndpoint(object: string, input: NamespaceFreezePolicyInput): string {
  return `(${object} != null && has(${object}.metadata.labels) && "kubernetes.io/service-name" in ${object}.metadata.labels && ` +
    `${object}.metadata.labels["kubernetes.io/service-name"] == ${celLiteral(input.service.name)})`;
}
