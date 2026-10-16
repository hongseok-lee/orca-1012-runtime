import { createHash } from 'node:crypto'
import {
  bootstrapServiceAccount, captureInput, collectorName, credentialGuards,
  fail, freeze, leastPrivilegeRbac, namespace,
} from './manifests.mjs'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const metadataAccept = 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1'
const resources = Object.freeze({
  ServiceAccount: ['v1', 'serviceaccounts'],
  Role: ['rbac.authorization.k8s.io/v1', 'roles'],
  RoleBinding: ['rbac.authorization.k8s.io/v1', 'rolebindings'],
  ClusterRole: ['rbac.authorization.k8s.io/v1', 'clusterroles'],
  ClusterRoleBinding: ['rbac.authorization.k8s.io/v1', 'clusterrolebindings'],
  ValidatingAdmissionPolicy: ['admissionregistration.k8s.io/v1', 'validatingadmissionpolicies'],
  ValidatingAdmissionPolicyBinding: ['admissionregistration.k8s.io/v1', 'validatingadmissionpolicybindings'],
})
export function canonicalJson(value) {
  if (Array.isArray(value)) { return `[${value.map(canonicalJson).join(',')}]` }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
export function specDigest(spec) {
  return createHash('sha256').update(canonicalJson(spec)).digest('hex')
}
function collection(object) {
  const [apiVersion, resource] = resources[object.kind] ?? []
  if (!apiVersion) { fail('RESOURCE_KIND_INVALID') }
  const prefix = apiVersion === 'v1' ? '/api/v1' : `/apis/${apiVersion}`
  return `${prefix}${object.metadata.namespace ? `/namespaces/${namespace}` : ''}/${resource}`
}
function objectPath(object) { return `${collection(object)}/${encodeURIComponent(object.metadata.name)}` }
function identity(value, desired) {
  if (!value || value.kind !== desired.kind || value.metadata?.name !== desired.metadata.name ||
      (value.metadata?.namespace ?? '') !== (desired.metadata.namespace ?? '') || !uuid.test(value.metadata?.uid ?? '')) {
    fail('RESOURCE_IDENTITY_INVALID')
  }
  return { kind: value.kind, name: value.metadata.name,
    ...(desired.metadata.namespace ? { namespace } : {}), uid: value.metadata.uid }
}
export function checkedMetadataList(response) {
  const value = response?.body
  if (response?.statusCode !== 200 || !value || typeof value !== 'object' || Array.isArray(value) ||
      value.apiVersion !== 'meta.k8s.io/v1' || value.kind !== 'PartialObjectMetadataList' ||
      !Object.hasOwn(value, 'items') || (value.items !== null && !Array.isArray(value.items)) ||
      Object.keys(value).some(key => !['apiVersion', 'kind', 'metadata', 'items'].includes(key))) {
    fail('METADATA_ONLY_RESPONSE_REQUIRED')
  }
  if (Object.hasOwn(value, 'metadata') && (!value.metadata || typeof value.metadata !== 'object' ||
      Array.isArray(value.metadata))) { fail('METADATA_ONLY_RESPONSE_REQUIRED') }
  if (value.metadata && Object.hasOwn(value.metadata, 'continue') && value.metadata.continue !== '') {
    fail('METADATA_ONLY_RESPONSE_REQUIRED')
  }
  const items = value.items === null ? [] : value.items
  if (items.some(item => !item || typeof item !== 'object' || Array.isArray(item) ||
      !item.metadata || typeof item.metadata !== 'object' || Array.isArray(item.metadata) ||
      (Object.hasOwn(item, 'apiVersion') && item.apiVersion !== 'meta.k8s.io/v1') ||
      (Object.hasOwn(item, 'kind') && item.kind !== 'PartialObjectMetadata') ||
      Object.keys(item).some(key => !['apiVersion', 'kind', 'metadata'].includes(key)))) {
    fail('METADATA_ONLY_RESPONSE_REQUIRED')
  }
  return items
}
function captureAcknowledged(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { fail('ACKNOWLEDGED_INPUT_INVALID') }
  const rootAcceptanceRef = value.rootAcceptanceRef, rawCollector = value.collector, rawGuards = value.guards
  if (typeof rootAcceptanceRef !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(rootAcceptanceRef) ||
      !rawCollector || typeof rawCollector !== 'object' || Array.isArray(rawCollector) ||
      !Array.isArray(rawGuards) || rawGuards.length !== 8) { fail('ACKNOWLEDGED_INPUT_INVALID') }
  const collector = { kind: rawCollector.kind, name: rawCollector.name, namespace: rawCollector.namespace, uid: rawCollector.uid }
  if (collector.kind !== 'ServiceAccount' || collector.name !== collectorName || collector.namespace !== namespace ||
      typeof collector.uid !== 'string' || !uuid.test(collector.uid)) { fail('ACKNOWLEDGED_INPUT_INVALID') }
  const expected = credentialGuards(collector.uid), captured = new Map()
  for (const item of rawGuards) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.hasOwn(item, 'namespace')) {
      fail('ACKNOWLEDGED_INPUT_INVALID')
    }
    const entry = { kind: item.kind, name: item.name, uid: item.uid }, key = `${entry.kind}/${entry.name}`
    if (typeof entry.kind !== 'string' || typeof entry.name !== 'string' || typeof entry.uid !== 'string' ||
        !uuid.test(entry.uid) || captured.has(key) || !expected.some(object => `${object.kind}/${object.metadata.name}` === key)) {
      fail('ACKNOWLEDGED_INPUT_INVALID')
    }
    captured.set(key, entry)
  }
  const guards = expected.map(object => captured.get(`${object.kind}/${object.metadata.name}`))
  if (guards.some(item => !item) || new Set([collector.uid, ...guards.map(item => item.uid)]).size !== 9) {
    fail('ACKNOWLEDGED_INPUT_INVALID')
  }
  return freeze({ rootAcceptanceRef, collector, guards })
}

/** The existing operator API adapter supplies auth/TLS/deadlines. No transport or token issuer is implemented here. */
export function createCollectorIdentityInstaller(rawInput, operatorApi) {
  const config = captureInput(rawInput)
  let request
  try { request = operatorApi.request.bind(operatorApi) } catch { fail('OPERATOR_TRANSPORT_REQUIRED') }
  async function run(approval, acknowledged, signal) {
    if (!approval || approval.execute !== true || approval.rootExecutionApproved !== true ||
        approval.rootAcceptedSourcePin !== config.rootAcceptedSourcePin) { fail('ROOT_EXECUTION_APPROVAL_REQUIRED') }
    const state = { kind: 'COLLECTOR_IDENTITY_INSTALLATION', rootAcceptedSourcePin: config.rootAcceptedSourcePin,
      phase: 'PREFLIGHT', startedAt: new Date().toISOString(), createIntents: [], created: [], observations: [],
      issuedTokens: 0, physicalPinIssued: false, actualCollectorExec: 0 }
    if (acknowledged) {
      state.priorAcknowledged = acknowledged
      state.rechecks = []
    }
    async function api(method, path, body, accept = 'application/json') {
      if (signal.aborted) { fail('ABORTED') }
      const options = { method, path, accept, timeoutMs: 15000, signal,
        ...(body === undefined ? {} : { body: JSON.parse(JSON.stringify(body)) }),
        followRedirects: false, automaticRetry: 0 }
      try {
        const response = await request(options)
        if (signal.aborted) { fail('ABORTED') }
        return response
      } catch { fail(signal.aborted ? 'ABORTED' : 'OPERATOR_REQUEST_FAILED') }
    }
    async function absent(object) {
      const response = await api('GET', objectPath(object))
      if (response.statusCode !== 404) { fail(response.statusCode === 200 ? 'OWNED_NAME_COLLISION' : 'PREFLIGHT_HTTP_FAILED') }
    }
    async function recallUncertainCreate(object, intent, originalCode) {
      intent.effect = 'UNKNOWN'
      intent.failureCode = originalCode
      // Cancellation never starts a fresh GET. A recalled UID is an observation, never accepted ownership.
      if (signal.aborted) {
        state.observations.push({ phase: 'UNCERTAIN_CREATE_RECALL_SKIPPED_ABORTED', kind: object.kind, name: object.metadata.name })
        fail('ABORTED')
      }
      try {
        const recovered = await api('GET', objectPath(object))
        const observation = { phase: 'UNCERTAIN_CREATE_RECALL', kind: object.kind,
          name: object.metadata.name, statusCode: recovered.statusCode, ownershipAccepted: false }
        if (recovered.statusCode === 200) {
          try { Object.assign(observation, identity(recovered.body, object), { identityConfirmed: true }) }
          catch { observation.identityConfirmed = false }
        }
        state.observations.push(observation)
      } catch { state.observations.push({ phase: 'UNCERTAIN_CREATE_RECALL_FAILED', kind: object.kind, name: object.metadata.name }) }
      fail('CREATE_UNCERTAIN_NO_RETRY')
    }
    async function create(object) {
      const intent = { kind: object.kind, name: object.metadata.name,
        ...(object.metadata.namespace ? { namespace } : {}), uid: null, attemptedAt: new Date().toISOString() }
      state.createIntents.push(intent)
      let response
      try { response = await api('POST', collection(object), object) } catch (error) {
        return recallUncertainCreate(object, intent, error.code)
      }
      intent.statusCode = response.statusCode
      if (response.statusCode >= 500 && response.statusCode <= 599) {
        return recallUncertainCreate(object, intent, 'CREATE_HTTP5XX_UNKNOWN')
      }
      if (response.statusCode !== 201) { fail('CREATE_HTTP_FAILED') }
      let captured
      try { captured = identity(response.body, object) }
      catch { return recallUncertainCreate(object, intent, 'RESOURCE_IDENTITY_INVALID') }
      intent.uid = captured.uid
      state.created.push(captured)
      if (object.kind === 'ServiceAccount' && (response.body.automountServiceAccountToken !== false ||
          (response.body.secrets ?? []).length !== 0)) { fail('BOOTSTRAP_SERVICE_ACCOUNT_CHANGED') }
      for (const key of ['rules', 'roleRef', 'subjects']) {
        if (key in object && canonicalJson(response.body[key]) !== canonicalJson(object[key])) { fail('RBAC_CREATE_RESPONSE_CHANGED') }
      }
      return captured
    }
    function recheck(desired, expected, response) {
      if (!acknowledged) { return null }
      const observedUid = response.body?.metadata?.uid
      const row = { kind: desired.kind, name: desired.metadata.name, expectedUid: expected.uid,
        ...(desired.metadata.namespace ? { namespace } : {}), statusCode: response.statusCode, verified: false,
        ...(uuid.test(observedUid ?? '') ? { observedUid } : {}) }
      state.rechecks.push(row)
      return row
    }
    async function verifyGuards(guards, guardIdentities) {
      for (const [index, guard] of guards.entries()) {
        const response = await api('GET', objectPath(guard))
        const row = recheck(guard, guardIdentities[index], response)
        if (response.statusCode !== 200 || identity(response.body, guard).uid !== guardIdentities[index].uid ||
            canonicalJson(response.body.spec) !== canonicalJson(guard.spec)) { fail('CREDENTIAL_GUARD_READBACK_MISMATCH') }
        if (guard.kind === 'ValidatingAdmissionPolicy' &&
            (!Number.isSafeInteger(response.body.status?.observedGeneration) ||
             response.body.status.observedGeneration < response.body.metadata.generation ||
             !response.body.status.typeChecking ||
             (response.body.status.typeChecking.expressionWarnings ?? []).length !== 0)) { fail('CREDENTIAL_GUARD_NOT_READY') }
        if (row) { row.verified = true }
      }
    }
    async function verifyServiceAccount(sa, collector) {
      const frozenSa = await api('GET', objectPath(sa))
      const row = recheck(sa, collector, frozenSa)
      if (frozenSa.statusCode !== 200 || identity(frozenSa.body, sa).uid !== collector.uid ||
          frozenSa.body.automountServiceAccountToken !== false || (frozenSa.body.secrets ?? []).length !== 0) {
        fail('COLLECTOR_IDENTITY_CHANGED_BEFORE_GRANTS')
      }
      if (row) { row.verified = true }
    }
    try {
      const sa = bootstrapServiceAccount(), rbac = leastPrivilegeRbac(config)
      if (acknowledged) {
        state.phase = 'ACKNOWLEDGED_CREDENTIAL_GUARDS_RECHECK'
        state.collector = acknowledged.collector
        await verifyServiceAccount(sa, acknowledged.collector)
        await verifyGuards(credentialGuards(acknowledged.collector.uid), acknowledged.guards)
        for (const object of rbac) { await absent(object) }
      } else {
        await absent(sa)
        // Preflight deterministic names before creating an identity; this is not an audit of all effective RBAC.
        for (const object of rbac) { await absent(object) }
        state.phase = 'BOOTSTRAP_SERVICE_ACCOUNT'
        const collector = await create(sa)
        state.collector = collector
        const guards = credentialGuards(collector.uid)
        for (const guard of guards) { await absent(guard) }
        state.phase = 'CREDENTIAL_GUARDS'
        const guardIdentities = []
        for (const guard of guards) { guardIdentities.push(await create(guard)) }
        await verifyGuards(guards, guardIdentities)
        await verifyServiceAccount(sa, collector)
      }
      state.phase = 'ASSOCIATION_METADATA'
      const podPath = `/api/v1/namespaces/${namespace}/pods?fieldSelector=${encodeURIComponent(`spec.serviceAccountName=${collectorName}`)}`
      const pods = checkedMetadataList(await api('GET', podPath, undefined, metadataAccept))
      if (pods.length !== 0) { fail('COLLECTOR_POD_ASSOCIATION_EXISTS') }
      const secrets = checkedMetadataList(await api('GET', `/api/v1/namespaces/${namespace}/secrets`, undefined, metadataAccept))
      if (secrets.some(item => item.metadata.annotations?.['kubernetes.io/service-account.name'] === collectorName)) {
        fail('COLLECTOR_SECRET_ASSOCIATION_EXISTS')
      }
      state.observations.push({ phase: 'ASSOCIATION_METADATA', collectorPodCount: 0, collectorSecretAnnotationCount: 0,
        secretContentRead: false, metadataOnly: true })
      state.phase = 'EXISTING_NFS_GUARDS'
      for (const expected of config.nfsGuardObjects) {
        const desired = { kind: expected.kind, metadata: { name: expected.name } }
        const response = await api('GET', objectPath(desired))
        if (response.statusCode !== 200 || identity(response.body, desired).uid !== expected.uid ||
            specDigest(response.body.spec) !== expected.specSHA256 ||
            (expected.kind === 'ValidatingAdmissionPolicy' ? response.body.spec.failurePolicy !== 'Fail' :
              canonicalJson(response.body.spec.validationActions) !== '["Deny"]')) { fail('NFS_GUARD_IDENTITY_OR_SPEC_CHANGED') }
      }
      state.nfsActivationEvidenceRef = config.rootAcceptedNfsActivationEvidenceRef
      state.phase = 'COLLECTOR_RBAC_THEN_ISSUER_BINDING_LAST'
      for (const object of rbac) { await create(object) }
      state.phase = 'IDENTITY_AND_RBAC_CREATED_NOT_TOKEN_OR_EXEC_QUALIFIED'
    } catch (error) {
      state.phase = 'STOPPED_NO_RETRY'
      state.errorCode = /^[A-Z0-9_]+$/u.test(error?.code ?? '') ? error.code : 'PREPARATION_OR_RESPONSE_FAILED'
    }
    state.finishedAt = new Date().toISOString()
    // No raw API object, Secret data, token, CA, response/cause, or general user metadata leaves this caller.
    return freeze(state)
  }
  return freeze({
    async install(approval, signal) { return run(approval, null, signal) },
    async continueAfterCredentialGuards(approval, acknowledged, signal) {
      const captured = captureAcknowledged(acknowledged)
      return run(approval, captured, signal)
    },
  })
}
