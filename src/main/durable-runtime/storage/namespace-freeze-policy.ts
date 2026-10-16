import { captureNamespaceFreezePolicyInput } from "./namespace-freeze-policy-input.ts";
import type { NamespaceFreezePolicyInput } from "./namespace-freeze-policy-input.ts";
import { celLiteral, collectorExec, metadataOnlyPodUpdate, protectedPod, recoveryPod, serviceEndpoint } from "./namespace-freeze-policy-cel.ts";

export type { NamespaceFreezePolicyInput } from "./namespace-freeze-policy-input.ts";
export { NamespaceFreezePolicyError } from "./namespace-freeze-policy-input.ts";
type ResourceRule = Readonly<{
  apiGroups: readonly string[]; apiVersions: readonly string[]; operations: readonly string[];
  resources: readonly string[]; scope: "Namespaced";
}>;
type Variable = Readonly<{ name: string; expression: string }>;
type Policy = Readonly<{
  apiVersion: "admissionregistration.k8s.io/v1"; kind: "ValidatingAdmissionPolicy";
  metadata: Readonly<{ name: string }>;
  spec: Readonly<{
    failurePolicy: "Fail";
    matchConstraints: Readonly<{ matchPolicy: "Exact"; resourceRules: readonly ResourceRule[] }>;
    matchConditions: readonly Variable[]; variables: readonly Variable[];
    validations: readonly Readonly<{ expression: string; message: string; reason: "Forbidden" }>[];
  }>;
}>;
type Binding = Readonly<{
  apiVersion: "admissionregistration.k8s.io/v1"; kind: "ValidatingAdmissionPolicyBinding";
  metadata: Readonly<{ name: string }>;
  spec: Readonly<{
    policyName: string; validationActions: readonly ["Deny"];
    matchResources: Readonly<{
      matchPolicy: "Exact";
      namespaceSelector: Readonly<{ matchLabels: Readonly<{ "kubernetes.io/metadata.name": string }> }>;
    }>;
  }>;
}>;
export type NamespaceFreezePolicyBundle = Readonly<{
  kind: "UNQUALIFIED_NAMESPACE_GUARD_BUNDLE"; physicalPinIssued: false; enforcementVerified: false;
  input: NamespaceFreezePolicyInput; policies: readonly Policy[]; bindings: readonly Binding[];
}>;
function rule(group: string, resources: readonly string[], operations: readonly string[]): ResourceRule {
  return { apiGroups: [group], apiVersions: ["v1"], operations, resources, scope: "Namespaced" };
}
function policy(input: NamespaceFreezePolicyInput, suffix: string, rules: readonly ResourceRule[],
  variables: readonly Variable[], expression: string): Policy {
  return { apiVersion: "admissionregistration.k8s.io/v1", kind: "ValidatingAdmissionPolicy",
    metadata: { name: `orca-namespace-${input.namespace}-${input.dataset}-${suffix}` }, spec: {
      failurePolicy: "Fail", matchConstraints: { matchPolicy: "Exact", resourceRules: rules },
      // No optional object/namespace label can opt a request out of the policy.
      matchConditions: [{ name: "exact-namespace", expression: `request.namespace == ${celLiteral(input.namespace)}` }],
      variables, validations: [{ expression, message: "Fixed namespace profile guard rejected this request", reason: "Forbidden" }],
    } };
}
function fixedResource(input: NamespaceFreezePolicyInput): Policy {
  const matches = [
    ["apps", "deployments", input.deployment.name], ["apps", "replicasets", input.replicaSet.name],
    ["", "configmaps", input.helperConfigMap.name], ["", "configmaps", input.exportsConfigMap.name],
    ["", "persistentvolumeclaims", input.backingPvc.name], ["", "services", input.service.name],
    ["networking.k8s.io", "networkpolicies", input.ingressNetworkPolicy.name],
  ].map(([group, resource, name]) => `(request.resource.group == ${celLiteral(group)} && ` +
    `request.resource.resource == ${celLiteral(resource)} && request.name == ${celLiteral(name)})`).join(" || ");
  return policy(input, "fixed", [
    rule("apps", ["deployments", "deployments/scale", "replicasets", "replicasets/scale"], ["CREATE", "UPDATE", "DELETE"]),
    rule("", ["configmaps", "persistentvolumeclaims", "services"], ["CREATE", "UPDATE", "DELETE"]),
    rule("networking.k8s.io", ["networkpolicies"], ["CREATE", "UPDATE", "DELETE"]),
  ], [], `!(${matches})`);
}
function pods(input: NamespaceFreezePolicyInput): Policy {
  return policy(input, "pods", [rule("", ["pods", "pods/ephemeralcontainers", "pods/resize"], ["CREATE", "UPDATE", "DELETE"])], [
    { name: "protected", expression: `${protectedPod("object", input)} || ${protectedPod("oldObject", input)}` },
  ], `!variables.protected || (request.subResource == "" && (` +
    `(request.operation == "CREATE" && ${recoveryPod(input)}) || ` +
    `(request.operation == "UPDATE" && ${metadataOnlyPodUpdate(input)}) || ` +
    `(request.operation == "DELETE" && request.userInfo.username in ${celLiteral(input.recoveryUsernames)})))`);
}
function exec(input: NamespaceFreezePolicyInput): Policy {
  return policy(input, "exec", [rule("", ["pods/exec"], ["CONNECT"])], [],
    `(!request.name.startsWith(${celLiteral(input.podNamePrefix)}) && ` +
    `!(request.userInfo.username in ${celLiteral(input.collectorUsernames)})) || ` +
    `(request.name.startsWith(${celLiteral(input.podNamePrefix)}) && ${collectorExec(input)})`);
}
function otherConnect(input: NamespaceFreezePolicyInput): Policy {
  // These options have different schemas; never access PodExecOptions fields here.
  return policy(input, "connect", [rule("", ["pods/attach", "pods/portforward", "pods/proxy"], ["CONNECT"])], [
    // Kubernetes SplitSchemeNamePort: name, name:port, or scheme:name:port.
    { name: "targetParts", expression: `request.subResource == "proxy" ? request.name.split(":") : [request.name]` },
    { name: "targetName", expression: `size(variables.targetParts) == 3 ? variables.targetParts[1] : variables.targetParts[0]` },
    { name: "targetValid", expression: `size(variables.targetParts) >= 1 && size(variables.targetParts) <= 3 && ` +
      `variables.targetName != "" && (size(variables.targetParts) != 3 || variables.targetParts[0] in ["", "http", "https"]) && ` +
      `(request.subResource == "proxy" || !variables.targetName.contains(":"))` },
  ], `variables.targetValid && !variables.targetName.startsWith(${celLiteral(input.podNamePrefix)}) && ` +
    `!(request.userInfo.username in ${celLiteral(input.collectorUsernames)})`);
}
function endpoints(input: NamespaceFreezePolicyInput): Policy {
  return policy(input, "endpoints", [
    rule("", ["endpoints"], ["CREATE", "UPDATE", "DELETE"]),
    rule("discovery.k8s.io", ["endpointslices"], ["CREATE", "UPDATE", "DELETE"]),
  ], [{ name: "protected", expression:
    `(request.resource.resource == "endpoints" && request.name == ${celLiteral(input.service.name)}) || ` +
    `(request.resource.resource == "endpointslices" && (${serviceEndpoint("object", input)} || ${serviceEndpoint("oldObject", input)}))`,
  }], `!variables.protected || request.userInfo.username in ${celLiteral(input.endpointUsernames)}`);
}
/** Pure generation only. No discovery, authentication, install, I/O, or physical authority. */
export function createNamespaceFreezePolicyBundle(value: unknown): NamespaceFreezePolicyBundle {
  const input = captureNamespaceFreezePolicyInput(value);
  const policies = Object.freeze([fixedResource(input), pods(input), exec(input), otherConnect(input), endpoints(input)]);
  const bindings: Binding[] = policies.map(item => ({
    apiVersion: "admissionregistration.k8s.io/v1", kind: "ValidatingAdmissionPolicyBinding",
    metadata: { name: item.metadata.name }, spec: { policyName: item.metadata.name,
      validationActions: ["Deny"], matchResources: { matchPolicy: "Exact",
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": input.namespace } },
      },
    },
  }));
  return Object.freeze({ kind: "UNQUALIFIED_NAMESPACE_GUARD_BUNDLE", physicalPinIssued: false,
    enforcementVerified: false, input, policies, bindings: Object.freeze(bindings) });
}
