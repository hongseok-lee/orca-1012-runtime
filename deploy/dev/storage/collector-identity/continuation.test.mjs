import assert from 'node:assert/strict'
import test from 'node:test'
import { bootstrapServiceAccount, credentialGuards } from './manifests.mjs'
import { checkedMetadataList, createCollectorIdentityInstaller, specDigest } from './install.mjs'

const sourcePin = 'c759cd406bac7b30c81bf2ae387d0e8f9aa6c991'
const uid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const rootAcceptanceRef = `sha256:${'a'.repeat(64)}`
const approval = { execute: true, rootExecutionApproved: true, rootAcceptedSourcePin: sourcePin }
const list = (items, metadata = {}) => ({ statusCode: 200,
  body: { apiVersion: 'meta.k8s.io/v1', kind: 'PartialObjectMetadataList', metadata, items } })
function fixture(mutate = () => {}) {
  const collector = { kind: 'ServiceAccount', name: 'orca-storage-collector', namespace: 'orca-dev', uid: uid(100) }
  const guardObjects = credentialGuards(collector.uid)
  const guards = guardObjects.map((object, index) => ({ kind: object.kind, name: object.metadata.name, uid: uid(200 + index) }))
  const acknowledged = { rootAcceptanceRef, collector, guards }
  const nfs = ['fixed', 'pods', 'exec', 'connect', 'endpoints'].flatMap((suffix, index) => {
    const name = `orca-namespace-orca-dev-continuation-${suffix}`
    return [{ kind: 'ValidatingAdmissionPolicy', name, uid: uid(300 + index), spec: { failurePolicy: 'Fail' } },
      { kind: 'ValidatingAdmissionPolicyBinding', name, uid: uid(400 + index), spec: { validationActions: ['Deny'] } }]
  })
  const input = { namespace: 'orca-dev', collectorName: collector.name, issuerName: 'orca-backend-inventory',
    rootAcceptedSourcePin: sourcePin, rootAcceptedNfsActivationEvidenceRef: `sha256:${'b'.repeat(64)}`,
    backingPvc: { name: 'fixture-backing', uid: uid(1) }, backingPv: { name: 'fixture-pv', uid: uid(2) },
    helperConfigMap: { name: 'fixture-helper', uid: uid(3) },
    nfsGuardObjects: nfs.map(({ spec, ...identity }) => ({ ...identity, specSHA256: specDigest(spec) })) }
  const types = { ServiceAccount: ['/api/v1/namespaces/orca-dev', 'serviceaccounts'],
    Role: ['/apis/rbac.authorization.k8s.io/v1/namespaces/orca-dev', 'roles'],
    RoleBinding: ['/apis/rbac.authorization.k8s.io/v1/namespaces/orca-dev', 'rolebindings'],
    ClusterRole: ['/apis/rbac.authorization.k8s.io/v1', 'clusterroles'],
    ClusterRoleBinding: ['/apis/rbac.authorization.k8s.io/v1', 'clusterrolebindings'],
    ValidatingAdmissionPolicy: ['/apis/admissionregistration.k8s.io/v1', 'validatingadmissionpolicies'],
    ValidatingAdmissionPolicyBinding: ['/apis/admissionregistration.k8s.io/v1', 'validatingadmissionpolicybindings'] }
  const pathFor = object => `${types[object.kind].join('/')}/${object.metadata.name}`
  const stored = new Map(), calls = []
  const sa = structuredClone(bootstrapServiceAccount())
  sa.metadata.uid = collector.uid
  stored.set(pathFor(sa), sa)
  guardObjects.forEach((object, index) => {
    const value = structuredClone(object)
    value.metadata.uid = guards[index].uid; value.metadata.generation = 1
    if (value.kind === 'ValidatingAdmissionPolicy') { value.status = { observedGeneration: 1, typeChecking: {} } }
    stored.set(pathFor(value), value)
  })
  for (const object of nfs) {
    const value = { apiVersion: 'admissionregistration.k8s.io/v1', kind: object.kind,
      metadata: { name: object.name, uid: object.uid }, spec: object.spec }
    stored.set(pathFor(value), value)
  }
  let created = 1000
  const api = { async request(options) {
    assert.equal(this, api)
    calls.push(options)
    let response
    if (options.method === 'POST') {
      assert.ok(['Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding'].includes(options.body.kind))
      const value = structuredClone(options.body)
      value.metadata.uid = uid(++created)
      stored.set(pathFor(value), value)
      response = { statusCode: 201, body: value }
    } else if (options.path.includes('?fieldSelector=') || options.path.endsWith('/secrets')) {
      assert.equal(options.accept, 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1')
      response = list(null)
    } else {
      const value = stored.get(options.path)
      response = value ? { statusCode: 200, body: structuredClone(value) } : { statusCode: 404, body: null }
    }
    mutate(options, response, { acknowledged, stored, input, pathFor })
    return response
  } }
  return { input, acknowledged, api, calls, stored, pathFor }
}

test('explicit null metadata items is a complete empty list without response mutation', () => {
  const response = list(null), original = structuredClone(response)
  assert.deepEqual(checkedMetadataList(response), [])
  assert.deepEqual(response, original)
  assert.equal(response.body.items, null)
  assert.deepEqual(checkedMetadataList(list([], { continue: '' })), [])
  const item = { apiVersion: 'meta.k8s.io/v1', kind: 'PartialObjectMetadata', metadata: { name: 'fixture' } }
  assert.deepEqual(checkedMetadataList(list([item])), [item])
})
test('metadata checker rejects missing or malformed items, full objects and incomplete pagination', () => {
  const missing = list(null); delete missing.body.items
  const cases = [missing, ...[undefined, false, 0, '', {}].map(value => list(value)),
    { statusCode: 201, body: list(null).body },
    { statusCode: 200, body: { ...list(null).body, apiVersion: 'v1', kind: 'SecretList' } },
    { statusCode: 200, body: { ...list(null).body, data: {} } },
    ...[null, false, 0, {}, [], { metadata: null }, { metadata: [] },
      { kind: 'Secret', apiVersion: 'v1', metadata: {}, data: {} }].map(item => list([item])),
    ...['next-page', null, false, 0, {}].map(value => list(null, { continue: value })),
    list(null, null), list(null, [])]
  for (const response of cases) {
    assert.throws(() => checkedMetadataList(response), { code: 'METADATA_ONLY_RESPONSE_REQUIRED' })
  }
})
test('continuation captures nine acknowledgements and performs GET gates then only six RBAC POSTs', async () => {
  let mutated = false
  const setup = fixture((options, response, context) => {
    if (!mutated && options.method === 'GET') {
      context.acknowledged.collector.uid = uid(999)
      context.acknowledged.guards[0].uid = uid(998)
      context.acknowledged.guards.length = 0
      mutated = true
    }
  })
  const installer = createCollectorIdentityInstaller(setup.input, setup.api)
  const result = await installer.continueAfterCredentialGuards(approval, setup.acknowledged, new AbortController().signal)
  assert.equal(result.phase, 'IDENTITY_AND_RBAC_CREATED_NOT_TOKEN_OR_EXEC_QUALIFIED')
  assert.equal(result.priorAcknowledged.rootAcceptanceRef, rootAcceptanceRef)
  assert.equal(result.priorAcknowledged.collector.uid, uid(100))
  assert.equal(result.priorAcknowledged.guards.length, 8)
  assert.equal(Object.isFrozen(result.priorAcknowledged), true)
  assert.equal(result.rechecks.length, 9)
  assert.equal(result.rechecks.every(row => row.verified), true)
  assert.equal(setup.calls.slice(0, 9).every(call => call.method === 'GET'), true)
  assert.equal(setup.calls[0].path.endsWith('/serviceaccounts/orca-storage-collector'), true)
  const posts = setup.calls.filter(call => call.method === 'POST')
  assert.equal(posts.length, 6)
  assert.equal(setup.calls.findIndex(call => call.method === 'POST'), 27)
  assert.equal(posts.at(-1).body.metadata.name, 'orca-storage-collector-issuer')
  assert.equal(result.created.length, 6)
  assert.equal(result.created.some(item => item.kind === 'ServiceAccount' || item.kind.startsWith('ValidatingAdmissionPolicy')), false)
  assert.equal(result.createIntents.length, 6)
  assert.equal(result.issuedTokens, 0)
  assert.equal(result.physicalPinIssued, false)
})
test('invalid acknowledgement references or identity sets issue no API requests', async () => {
  const setup = fixture(), installer = createCollectorIdentityInstaller(setup.input, setup.api)
  const mutations = [value => { value.rootAcceptanceRef = 'invalid' },
    value => { value.collector.namespace = 'other' }, value => { value.collector.uid = 'invalid' },
    value => { value.guards.pop() }, value => { value.guards[1] = value.guards[0] },
    value => { value.guards[0].uid = 'invalid' },
    value => { value.guards[0].namespace = 'orca-dev' }, value => { value.guards[0].uid = value.collector.uid },
    value => { value.guards[0].name = 'unexpected-guard' }]
  for (const mutate of mutations) {
    const input = structuredClone(setup.acknowledged); mutate(input)
    await assert.rejects(installer.continueAfterCredentialGuards(approval, input, new AbortController().signal),
      { code: 'ACKNOWLEDGED_INPUT_INVALID' })
  }
  assert.equal(setup.calls.length, 0)
})
test('changed SA or guard UID/spec and an existing RBAC name stop before any grant', async () => {
  for (const scenario of ['sa-uid', 'guard-uid', 'guard-spec', 'rbac-collision']) {
    const setup = fixture((options, response) => {
      if (scenario === 'sa-uid' && options.path.endsWith('/serviceaccounts/orca-storage-collector')) {
        response.body.metadata.uid = uid(900)
      }
      if (options.path.endsWith('/validatingadmissionpolicies/orca-storage-collector-sa')) {
        if (scenario === 'guard-uid') { response.body.metadata.uid = uid(901) }
        if (scenario === 'guard-spec') { response.body.spec.failurePolicy = 'Ignore' }
      }
      if (scenario === 'rbac-collision' && options.path.endsWith('/roles/orca-storage-collector-read')) {
        response.statusCode = 200
      }
    })
    const result = await createCollectorIdentityInstaller(setup.input, setup.api)
      .continueAfterCredentialGuards(approval, setup.acknowledged, new AbortController().signal)
    assert.equal(result.phase, 'STOPPED_NO_RETRY', scenario)
    assert.equal(result.created.length, 0, scenario)
    assert.equal(result.createIntents.length, 0, scenario)
    assert.equal(setup.calls.some(call => call.method === 'POST'), false, scenario)
  }
})
test('an already aborted continuation does not begin the first recheck', async () => {
  const setup = fixture(), controller = new AbortController(); controller.abort()
  const result = await createCollectorIdentityInstaller(setup.input, setup.api)
    .continueAfterCredentialGuards(approval, setup.acknowledged, controller.signal)
  assert.equal(result.errorCode, 'ABORTED')
  assert.equal(result.created.length, 0)
  assert.equal(setup.calls.length, 0)
})
