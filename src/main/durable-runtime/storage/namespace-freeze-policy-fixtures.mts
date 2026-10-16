import { managedLeafInspectCommand } from "./managed-leaf-collector-exec.ts";
import type { NamespaceFreezePolicyInput } from "./namespace-freeze-policy-input.ts";

// Entirely synthetic. No live controller username has been established or inferred.
export const namespaceFreezeExample: NamespaceFreezePolicyInput = {
  namespace: "freeze-example", dataset: "dataset-example",
  deployment: { name: "nfs-example", uid: "00000000-0000-4000-8000-000000000001" },
  replicaSet: { name: "nfs-example-123abc", uid: "00000000-0000-4000-8000-000000000002" },
  backingPvc: { name: "nfs-data-example", uid: "00000000-0000-4000-8000-000000000003" },
  backingPv: { name: "pv-example", uid: "00000000-0000-4000-8000-000000000004", csiDriver: "example.csi.invalid", volumeHandle: "synthetic-volume-only" },
  service: { name: "nfs-example", uid: "00000000-0000-4000-8000-000000000005", selector: { app: "nfs-example", "orca.dev/dataset": "dataset-example" } },
  helperConfigMap: { name: "nfs-helper-example", uid: "00000000-0000-4000-8000-000000000006", sha256: "a".repeat(64) },
  exportsConfigMap: { name: "nfs-exports-example", uid: "00000000-0000-4000-8000-000000000007", sha256: "b".repeat(64) },
  ingressNetworkPolicy: { name: "nfs-ingress-example", uid: "00000000-0000-4000-8000-000000000008" },
  podNamePrefix: "nfs-example-123abc-", container: "unfs3",
  recoveryUsernames: ["synthetic:recovery-controller"], endpointUsernames: ["synthetic:endpoint-controller"],
  collectorUsernames: ["synthetic:managed-leaf-collector"],
};
export const examplePodUid = "00000000-0000-4000-8000-000000000009";
export const exampleLeafId = "00000000-0000-4000-8000-000000000010";
const profile = namespaceFreezeExample;
export const exampleInspectArgv = ["/bin/sh", "-ec", managedLeafInspectCommand, "orca-managed-leaf-collector",
  profile.helperConfigMap.sha256, profile.exportsConfigMap.sha256, examplePodUid, profile.dataset, exampleLeafId];
export const exampleHelperArgv = ["/bin/sh", "/opt/orca-nfs-tools/managed_storage.sh", "ensure-leaf", examplePodUid, profile.dataset, exampleLeafId];
const pod = { apiVersion: "v1", kind: "Pod", metadata: {
  name: `${profile.podNamePrefix}abcde`, namespace: profile.namespace, uid: examplePodUid,
  labels: { ...profile.service.selector }, ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet",
    name: profile.replicaSet.name, uid: profile.replicaSet.uid, controller: true }],
}, spec: { containers: [{ name: "unfs3", image: "example.invalid/nfs@sha256:synthetic" }],
  volumes: [{ name: "backing", persistentVolumeClaim: { claimName: profile.backingPvc.name } }] } };
const exec = { apiVersion: "v1", kind: "PodExecOptions", container: "unfs3", stdin: false, tty: false,
  stdout: true, stderr: true, command: exampleInspectArgv };
type Case = Readonly<{
  id: string; expectedDecision: "ALLOW" | "DENY" | "OUT_OF_SCOPE";
  request: Readonly<{ namespace: string; name: string; operation: string; subResource: string;
    resource: Readonly<{ group: string; version: string; resource: string }>; userInfo: Readonly<{ username: string }> }>;
  object: unknown; oldObject: unknown;
}>;
function request(id: string, expectedDecision: Case["expectedDecision"], operation: string,
  resource: string, object: unknown, oldObject: unknown = null, username = "synthetic:product",
  subResource = "", name = pod.metadata.name, group = ""): Case {
  return { id, expectedDecision, request: { namespace: profile.namespace, name, operation, subResource,
    resource: { group, version: "v1", resource }, userInfo: { username } }, object, oldObject };
}
// Expected API cases only; no JavaScript CEL mirror or enforcement result is supplied.
export const namespaceFreezeRequestCases: readonly Case[] = [
  request("fixed-deployment-update", "DENY", "UPDATE", "deployments", {}, {}, "synthetic:recovery-controller", "", profile.deployment.name, "apps"),
  request("fixed-rs-scale", "DENY", "UPDATE", "replicasets", {}, {}, "synthetic:recovery-controller", "scale", profile.replicaSet.name, "apps"),
  request("fixed-configmap-delete", "DENY", "DELETE", "configmaps", null, {}, "synthetic:product", "", profile.helperConfigMap.name),
  request("fixed-pvc-create", "DENY", "CREATE", "persistentvolumeclaims", {}, null, "synthetic:product", "", profile.backingPvc.name),
  request("fixed-service-delete", "DENY", "DELETE", "services", null, {}, "synthetic:product", "", profile.service.name),
  request("fixed-ingress-update", "DENY", "UPDATE", "networkpolicies", {}, {}, "synthetic:product", "", profile.ingressNetworkPolicy.name, "networking.k8s.io"),
  request("ordinary-configmap", "ALLOW", "CREATE", "configmaps", {}, null, "synthetic:product", "", "ordinary"),
  request("forged-rs-owner", "DENY", "CREATE", "pods", pod),
  request("trusted-recovery", "ALLOW", "CREATE", "pods", pod, null, "synthetic:recovery-controller"),
  request("generate-name-recovery", "ALLOW", "CREATE", "pods", { ...pod, metadata: { ...pod.metadata, name: "", generateName: profile.podNamePrefix } }, null, "synthetic:recovery-controller"),
  request("selector-only-forgery", "DENY", "CREATE", "pods", { ...pod, metadata: { name: "other", labels: { ...profile.service.selector } }, spec: { containers: [] } }),
  request("pvc-only-forgery", "DENY", "CREATE", "pods", { ...pod, metadata: { name: "other" } }),
  request("recovery-wrong-rs-uid", "DENY", "CREATE", "pods", { ...pod, metadata: { ...pod.metadata, ownerReferences: [{ ...pod.metadata.ownerReferences[0], uid: exampleLeafId }] } }, null, "synthetic:recovery-controller"),
  request("recovery-wrong-selector", "DENY", "CREATE", "pods", { ...pod, metadata: { ...pod.metadata, labels: { app: "other" } } }, null, "synthetic:recovery-controller"),
  request("metadata-only", "ALLOW", "UPDATE", "pods", { ...pod, metadata: { ...pod.metadata, annotations: { note: "example" } } }, pod),
  request("remove-selector", "DENY", "UPDATE", "pods", { ...pod, metadata: { ...pod.metadata, labels: {} } }, pod),
  request("add-selector-late", "DENY", "UPDATE", "pods", pod, { ...pod, metadata: { ...pod.metadata, labels: {} } }),
  request("replace-spec", "DENY", "UPDATE", "pods", { ...pod, spec: { ...pod.spec, nodeName: "other" } }, pod),
  request("pod-ephemeralcontainers", "DENY", "UPDATE", "pods", pod, pod, "synthetic:recovery-controller", "ephemeralcontainers"),
  request("pod-resize", "DENY", "UPDATE", "pods", pod, pod, "synthetic:recovery-controller", "resize"),
  request("pod-delete-product", "DENY", "DELETE", "pods", null, pod),
  request("pod-delete-platform", "ALLOW", "DELETE", "pods", null, pod, "synthetic:recovery-controller"),
  request("pod-status", "OUT_OF_SCOPE", "UPDATE", "pods", pod, pod, "synthetic:node", "status"),
  request("pod-binding", "OUT_OF_SCOPE", "CREATE", "pods", {}, null, "synthetic:scheduler", "binding"),
  request("collector-exact-inspect", "ALLOW", "CONNECT", "pods", exec, null, "synthetic:managed-leaf-collector", "exec"),
  request("collector-exact-helper", "ALLOW", "CONNECT", "pods", { ...exec, command: exampleHelperArgv }, null, "synthetic:managed-leaf-collector", "exec"),
  request("collector-helper-inspect", "ALLOW", "CONNECT", "pods", { ...exec, command: exampleHelperArgv.map((arg, i) => i === 2 ? "inspect-leaf" : arg) }, null, "synthetic:managed-leaf-collector", "exec"),
  request("collector-other-pod", "DENY", "CONNECT", "pods", exec, null, "synthetic:managed-leaf-collector", "exec", "agent-other"),
  request("product-shell", "DENY", "CONNECT", "pods", { ...exec, command: ["/bin/sh"] }, null, "synthetic:product", "exec"),
  request("collector-extra-argv", "DENY", "CONNECT", "pods", { ...exec, command: [...exampleInspectArgv, "extra"] }, null, "synthetic:managed-leaf-collector", "exec"),
  request("collector-modified-source", "DENY", "CONNECT", "pods", { ...exec, command: exampleInspectArgv.map((arg, i) => i === 2 ? `${arg}\ntrue` : arg) }, null, "synthetic:managed-leaf-collector", "exec"),
  request("collector-bootstrap", "DENY", "CONNECT", "pods", { ...exec, command: ["/bin/sh", "/opt/orca-nfs-tools/managed_storage.sh", "bootstrap", profile.dataset] }, null, "synthetic:managed-leaf-collector", "exec"),
  request("collector-tty", "DENY", "CONNECT", "pods", { ...exec, tty: true }, null, "synthetic:managed-leaf-collector", "exec"),
  request("collector-other-container", "DENY", "CONNECT", "pods", { ...exec, container: "other" }, null, "synthetic:managed-leaf-collector", "exec"),
  ...["attach", "portforward", "proxy"].map(subresource => request(`protected-${subresource}`, "DENY", "CONNECT", "pods", {}, null, "synthetic:product", subresource)),
  request("protected-qualified-proxy", "DENY", "CONNECT", "pods", {}, null, "synthetic:product", "proxy", `https:${pod.metadata.name}:2049`),
  request("collector-attach-other-pod", "DENY", "CONNECT", "pods", {}, null, "synthetic:managed-leaf-collector", "attach", "agent-other"),
  request("endpoints-product", "DENY", "UPDATE", "endpoints", {}, {}, "synthetic:product", "", profile.service.name),
  request("endpoints-platform", "ALLOW", "UPDATE", "endpoints", {}, {}, "synthetic:endpoint-controller", "", profile.service.name),
  request("endpointslice-label-removal", "DENY", "UPDATE", "endpointslices", { metadata: { labels: {} } }, { metadata: { labels: { "kubernetes.io/service-name": profile.service.name } } }, "synthetic:product", "", "slice", "discovery.k8s.io"),
  request("endpointslice-platform", "ALLOW", "CREATE", "endpointslices", { metadata: { labels: { "kubernetes.io/service-name": profile.service.name } } }, null, "synthetic:endpoint-controller", "", "slice", "discovery.k8s.io"),
];
export const namespaceFreezeFixtureStatus = Object.freeze({ evaluation: "NOT_EXECUTED", actualControllerUsernamesConfirmed: false,
  admissionEnforcementVerified: false, physicalPinIssued: false });
