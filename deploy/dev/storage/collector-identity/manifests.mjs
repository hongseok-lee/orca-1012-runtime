export const sourceBasePin = 'd76726b5fc9156860ff7aa9f7809f07f58d8a0fd'
export const namespace = 'orca-dev'
export const collectorName = 'orca-storage-collector'
export const collectorUsername = `system:serviceaccount:${namespace}:${collectorName}`
export const issuerName = 'orca-backend-inventory'
export const issuerUsername = `system:serviceaccount:${namespace}:${issuerName}`
const literal = JSON.stringify
const names = /^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/u
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const hash = /^[0-9a-f]{64}$/u

export class CollectorIdentityError extends Error {
  constructor(code) { super(code); this.name = 'CollectorIdentityError'; this.code = code }
}
export function fail(code) { throw new CollectorIdentityError(code) }
export function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) { freeze(child) }
    Object.freeze(value)
  }
  return value
}
function resourceName(value) {
  if (typeof value !== 'string' || value.length > 253 || !names.test(value)) { fail('CONFIG_INVALID') }
  return value
}
function resource(value) {
  if (!value || !uuid.test(value.uid ?? '')) { fail('CONFIG_INVALID') }
  return { name: resourceName(value.name), uid: value.uid }
}
export function captureResourceInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.namespace !== namespace || value.collectorName !== collectorName ||
      value.issuerName !== issuerName || !/^[0-9a-f]{40}$/u.test(value.rootAcceptedSourcePin ?? '')) { fail('CONFIG_INVALID') }
  return freeze({ namespace, collectorName, issuerName, rootAcceptedSourcePin: value.rootAcceptedSourcePin,
    backingPvc: resource(value.backingPvc), backingPv: resource(value.backingPv),
    helperConfigMap: resource(value.helperConfigMap) })
}
export function captureInput(value) {
  const config = captureResourceInput(value)
  if (!/^sha256:[0-9a-f]{64}$/u.test(value.rootAcceptedNfsActivationEvidenceRef ?? '') ||
      !Array.isArray(value.nfsGuardObjects) || value.nfsGuardObjects.length !== 10) { fail('CONFIG_INVALID') }
  const nfsGuardObjects = value.nfsGuardObjects.map(item => {
    const identity = resource(item)
    if (!['ValidatingAdmissionPolicy', 'ValidatingAdmissionPolicyBinding'].includes(item.kind) ||
        !identity.name.startsWith('orca-namespace-orca-dev-') || !hash.test(item.specSHA256 ?? '')) { fail('CONFIG_INVALID') }
    return { ...identity, kind: item.kind, specSHA256: item.specSHA256 }
  })
  if (new Set(nfsGuardObjects.map(item => `${item.kind}/${item.name}`)).size !== 10 ||
      nfsGuardObjects.filter(item => item.kind === 'ValidatingAdmissionPolicy').length !== 5) { fail('CONFIG_INVALID') }
  const policies = nfsGuardObjects.filter(item => item.kind === 'ValidatingAdmissionPolicy').map(item => item.name).sort()
  const bindings = nfsGuardObjects.filter(item => item.kind === 'ValidatingAdmissionPolicyBinding').map(item => item.name).sort()
  if (JSON.stringify(policies) !== JSON.stringify(bindings)) { fail('CONFIG_INVALID') }
  return freeze({ ...config, rootAcceptedNfsActivationEvidenceRef: value.rootAcceptedNfsActivationEvidenceRef, nfsGuardObjects })
}
function object(apiVersion, kind, name, spec, namespaced = false) {
  return { apiVersion, kind, metadata: { name, ...(namespaced ? { namespace } : {}),
    labels: { 'orca.dev/role': 'storage-collector-identity' } }, ...spec }
}
export function bootstrapServiceAccount() {
  return freeze(object('v1', 'ServiceAccount', collectorName,
    { automountServiceAccountToken: false }, true))
}
function rule(resources, operations) {
  return { apiGroups: [''], apiVersions: ['v1'], resources, operations, scope: 'Namespaced' }
}
function guard(suffix, resourceRules, expression) {
  const name = `orca-storage-collector-${suffix}`
  // Exact GKE development readback; changes stop the caller's exact-spec gate.
  const namespaceSelector = { matchExpressions: [{ key: 'kubernetes.io/metadata.name', operator: 'NotIn', values: [
    'kube-system', 'gke-gmp-system', 'gke-managed-cim', 'gke-managed-volumepopulator',
    'gke-managed-checkpointing', 'gke-managed-parallelstorecsi', 'gke-managed-lustrecsi', 'gke-managed-otel',
    'gke-managed-mldiagnostics', 'gke-managed-networking-dra-driver', 'gke-managed-pod-snapshots', 'gke-managed-ambient',
  ] }] }
  const policy = object('admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicy', name, { spec: {
    failurePolicy: 'Fail', matchConstraints: { matchPolicy: 'Exact', namespaceSelector, objectSelector: {}, resourceRules },
    matchConditions: [{ name: 'exact-namespace', expression: `request.namespace == ${literal(namespace)}` }],
    validations: [{ expression, message: 'Dedicated collector credential guard rejected this request', reason: 'Forbidden' }],
  } })
  const binding = object('admissionregistration.k8s.io/v1', 'ValidatingAdmissionPolicyBinding', name, { spec: {
    policyName: name, validationActions: ['Deny'], matchResources: { matchPolicy: 'Exact', objectSelector: {},
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': namespace } } },
  } })
  return [policy, binding]
}
function targetsServiceAccount(objectName) {
  return `(${objectName} != null && has(${objectName}.metadata.name) && ` +
    `${objectName}.metadata.name == ${literal(collectorName)})`
}
function usesCollector(objectName) {
  return `(${objectName} != null && has(${objectName}.spec.serviceAccountName) && ` +
    `${objectName}.spec.serviceAccountName == ${literal(collectorName)})`
}
function longToken(objectName) {
  return `(${objectName} != null && has(${objectName}.type) && ` +
    `${objectName}.type == "kubernetes.io/service-account-token" && has(${objectName}.metadata.annotations) && ` +
    `"kubernetes.io/service-account.name" in ${objectName}.metadata.annotations && ` +
    `${objectName}.metadata.annotations["kubernetes.io/service-account.name"] == ${literal(collectorName)})`
}
/** UID is returned by the single bootstrap CREATE; it is never predicted or replaced. */
export function credentialGuards(collectorUid) {
  if (!uuid.test(collectorUid ?? '')) { fail('COLLECTOR_UID_INVALID') }
  return freeze([
    ...guard('sa', [rule(['serviceaccounts'], ['CREATE', 'UPDATE', 'DELETE'])],
      `!(request.name == ${literal(collectorName)} || ${targetsServiceAccount('object')} || ${targetsServiceAccount('oldObject')})`),
    ...guard('pod', [rule(['pods', 'pods/ephemeralcontainers', 'pods/resize'], ['CREATE', 'UPDATE'])],
      `!(${usesCollector('object')} || ${usesCollector('oldObject')})`),
    ...guard('tokenrequest', [rule(['serviceaccounts/token'], ['CREATE'])],
      `request.name != ${literal(collectorName)} || (` +
      `request.userInfo.username == ${literal(issuerUsername)} && object != null && ` +
      `has(object.metadata.name) && object.metadata.name == ${literal(collectorName)} && ` +
      `has(object.metadata.namespace) && object.metadata.namespace == ${literal(namespace)} && ` +
      `has(object.metadata.uid) && object.metadata.uid == ${literal(collectorUid)} && ` +
      `has(object.spec.expirationSeconds) && object.spec.expirationSeconds == 600 && (!has(object.spec.boundObjectRef) || object.spec.boundObjectRef == null))`),
    ...guard('secret', [rule(['secrets'], ['CREATE', 'UPDATE'])],
      `!(${longToken('object')} || ${longToken('oldObject')})`),
  ])
}
export function leastPrivilegeRbac(input) {
  const config = captureResourceInput(input)
  const rbac = 'rbac.authorization.k8s.io/v1'
  const collectorSubject = { kind: 'ServiceAccount', name: collectorName, namespace }
  const issuerSubject = { kind: 'ServiceAccount', name: issuerName, namespace }
  const readRole = 'orca-storage-collector-read', pvRole = 'orca-storage-collector-pv-read'
  const tokenRole = 'orca-storage-collector-issuer'
  const role = (kind, name, rules) => object(rbac, kind, name, { rules }, kind === 'Role')
  const bind = (kind, name, roleKind, roleName, subject) => object(rbac, kind, name, {
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: roleKind, name: roleName }, subjects: [subject],
  }, kind === 'RoleBinding')
  return freeze([
    role('Role', readRole, [
      { apiGroups: [''], resources: ['pods'], verbs: ['get'] },
      { apiGroups: [''], resources: ['pods/exec'], verbs: ['get', 'create'] },
      { apiGroups: [''], resources: ['persistentvolumeclaims'], resourceNames: [config.backingPvc.name], verbs: ['get'] },
      { apiGroups: [''], resources: ['configmaps'], resourceNames: [config.helperConfigMap.name], verbs: ['get'] },
    ]),
    role('ClusterRole', pvRole, [
      { apiGroups: [''], resources: ['persistentvolumes'], resourceNames: [config.backingPv.name], verbs: ['get'] },
    ]),
    role('Role', tokenRole, [
      { apiGroups: [''], resources: ['serviceaccounts/token'], resourceNames: [collectorName], verbs: ['create'] },
    ]),
    bind('RoleBinding', readRole, 'Role', readRole, collectorSubject),
    bind('ClusterRoleBinding', pvRole, 'ClusterRole', pvRole, collectorSubject),
    // Issuance is enabled only after all guard/association/NFS checks and collector read bindings.
    bind('RoleBinding', tokenRole, 'Role', tokenRole, issuerSubject),
  ])
}
