import { agentCodexBootstrap, agentControlTransfer } from './agent-codex-transport.ts'
import { inventoryNamespace } from '../lifecycle/kubernetes-identity.ts'

export { agentControlTransfer } from './agent-codex-transport.ts'

/** Root-selected minimal authorization delta. Pure source generation only;
 * creation/apply and the actual compiled artifact digest require live review.
 * No NFS credential, generic exec, Secret read or runtime-agent binding. */
export function createAgentControlAuthorization(namespaceInput: string, bootstrapSha256: string) {
  const namespace = inventoryNamespace(namespaceInput)
  if (!/^[0-9a-f]{64}$/.test(bootstrapSha256)) { throw new Error('AGENT_CONTROL_ARTIFACT_IDENTITY') }
  const backend = 'orca-backend-inventory', name = 'orca-agent-control'
  const literal = JSON.stringify
  const commands = [agentCodexBootstrap, agentControlTransfer].map(source => literal(source)).join(',')
  const expression = `request.subResource == "exec" && request.name.matches("^orca-unit-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$") && ` +
    `object != null && has(object.container) && object.container == "agent" && ` +
    `has(object.stdin) && object.stdin && has(object.stdout) && object.stdout && has(object.stderr) && object.stderr && ` +
    `(!has(object.tty) || !object.tty) && has(object.command) && size(object.command) == 4 && ` +
    `object.command[0] == "/usr/local/bin/node" && object.command[1] == "-e" && ` +
    `object.command[2] in [${commands}] && object.command[3] == ${literal(bootstrapSha256)}`
  const actor = `system:serviceaccount:${namespace}:${backend}`
  const roleRef = (kind: 'Role' | 'ClusterRole') => ({ apiGroup: 'rbac.authorization.k8s.io', kind, name })
  const subject = { kind: 'ServiceAccount', name: backend, namespace }
  const policyName = `orca-agent-control-${namespace}`
  const items = [
      { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'orca-runtime-agent', namespace }, automountServiceAccountToken: false },
      { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name, namespace },
        rules: [{ apiGroups: [''], resources: ['pods/exec'], verbs: ['get', 'create'] }] },
      { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name, namespace }, roleRef: roleRef('Role'), subjects: [subject] },
      { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name }, rules: [
        { apiGroups: ['authentication.k8s.io'], resources: ['tokenreviews'], verbs: ['create'] },
        { apiGroups: [''], resources: ['nodes'], verbs: ['get'] },
      ] },
      { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name }, roleRef: roleRef('ClusterRole'), subjects: [subject] },
      { apiVersion: 'admissionregistration.k8s.io/v1', kind: 'ValidatingAdmissionPolicy', metadata: { name: policyName }, spec: {
        failurePolicy: 'Fail', matchConstraints: { matchPolicy: 'Exact', resourceRules: [
          { apiGroups: [''], apiVersions: ['v1'], operations: ['CONNECT'], resources: ['pods/exec'], scope: 'Namespaced' },
        ] }, matchConditions: [
          { name: 'backend-actor', expression: `request.userInfo.username == ${literal(actor)}` },
          { name: 'exact-namespace', expression: `request.namespace == ${literal(namespace)}` },
        ], validations: [{ expression, message: 'Agent control requires the fixed owned bootstrap and exact artifact', reason: 'Forbidden' }],
      } },
      { apiVersion: 'admissionregistration.k8s.io/v1', kind: 'ValidatingAdmissionPolicyBinding', metadata: { name: policyName }, spec: {
        policyName, validationActions: ['Deny'], matchResources: { matchPolicy: 'Exact',
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } } },
      } },
    ]
  // Install/confirm the exact VAP + Binding first. Definitions grant nothing;
  // the two backend RBAC bindings are deliberately last, after guard activation.
  return { apiVersion: 'v1', kind: 'List', items: [items[5], items[6], items[0], items[1], items[3], items[2], items[4]] }
}
