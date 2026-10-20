import { captureAgentPodPolicy } from '../runtime/agent-pod-policy.ts'

/** Backend may CREATE static NFS consumer volumes only. Existing PV/PVC update
 * and deletion remain ungranted. PVC admission limits claims to unit leaves.
 * Autopilot forbids PV admission policies; the trusted backend constructs PVs
 * through the exact server/path checks in ensureUnitStorageVolume.
 * Apply admission definitions/binding before the RBAC bindings. */
export function createUnitStorageAuthorization(policyInput: unknown) {
  const p = captureAgentPodPolicy(policyInput), name = `orca-unit-storage-${p.namespace}`, q = JSON.stringify
  const actor = `system:serviceaccount:${p.namespace}:orca-backend-inventory`
  const subject = { kind: 'ServiceAccount', name: 'orca-backend-inventory', namespace: p.namespace }
  const shared = `object.metadata.name.matches('^orca-home-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') && ` +
    `has(object.metadata.labels) && object.metadata.labels['orca.dev/dataset'] == ${q(p.dataset)} && ` +
    `object.metadata.labels['orca.dev/runtime-unit'] == object.metadata.name.substring(10) && ` +
    `object.spec.storageClassName == '' && object.spec.volumeMode == 'Filesystem' && object.spec.accessModes == ['ReadWriteMany']`
  const pvc = `${shared} && request.namespace == ${q(p.namespace)} && object.spec.volumeName == object.metadata.name && ` +
    `!has(object.spec.selector) && !has(object.spec.dataSource) && !has(object.spec.dataSourceRef)`
  const admission = ['persistentvolumeclaims'].flatMap((resource, i) => {
    const policyName = `${name}-${i}`
    return [{ apiVersion: 'admissionregistration.k8s.io/v1', kind: 'ValidatingAdmissionPolicy', metadata: { name: policyName }, spec: {
      failurePolicy: 'Fail', matchConstraints: { resourceRules: [{ apiGroups: [''], apiVersions: ['v1'], operations: ['CREATE'],
        resources: [resource], scope: 'Namespaced' }] },
      matchConditions: [{ name: 'backend-only', expression: `request.userInfo.username == ${q(actor)}` }],
      validations: [{ expression: pvc, message: 'Backend storage creation requires an exact independent unit NFS volume' }]
    } }, { apiVersion: 'admissionregistration.k8s.io/v1', kind: 'ValidatingAdmissionPolicyBinding', metadata: { name: policyName },
      spec: { policyName, validationActions: ['Deny'] } }]
  })
  return { apiVersion: 'v1', kind: 'List', items: [...admission,
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name },
      rules: [{ apiGroups: [''], resources: ['persistentvolumes'], verbs: ['create'] }] },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name, namespace: p.namespace },
      rules: [{ apiGroups: [''], resources: ['persistentvolumeclaims'], verbs: ['create'] }] },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name }, subjects: [subject] },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name, namespace: p.namespace },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name }, subjects: [subject] }
  ] }
}
