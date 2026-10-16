import assert from 'node:assert/strict'
import test from 'node:test'
import { bootstrapServiceAccount, credentialGuards, leastPrivilegeRbac, sourceBasePin } from './manifests.mjs'
import { createCollectorIdentityInstaller, specDigest } from './install.mjs'

const uid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
function fixtureInput() {
  const nfs = ['fixed', 'pods', 'exec', 'connect', 'endpoints'].flatMap((suffix, index) => {
    const name = `orca-namespace-orca-dev-fixture-${suffix}`
    return [{ kind: 'ValidatingAdmissionPolicy', name, uid: uid(100 + index), spec: { failurePolicy: 'Fail' } },
      { kind: 'ValidatingAdmissionPolicyBinding', name, uid: uid(200 + index), spec: { validationActions: ['Deny'] } }]
  })
  return { namespace: 'orca-dev', collectorName: 'orca-storage-collector', issuerName: 'orca-backend-inventory',
    rootAcceptedSourcePin: sourceBasePin, rootAcceptedNfsActivationEvidenceRef: `sha256:${'0'.repeat(64)}`,
    backingPvc: { name: 'fixture-backing', uid: uid(1) }, backingPv: { name: 'fixture-pv', uid: uid(2) },
    helperConfigMap: { name: 'fixture-helper', uid: uid(3) },
    nfsGuardObjects: nfs.map(({ spec, ...identity }) => ({ ...identity, specSHA256: specDigest(spec) })), _nfs: nfs }
}
function fakeOperator(input, mutate = () => {}) {
  let serial = 300
  const stored = new Map(), calls = []
  const api = { async request(options) {
    assert.equal(this, api)
    calls.push(options)
    let response
    if (options.method === 'POST') {
      const value = structuredClone(options.body)
      value.metadata.uid = uid(++serial); value.metadata.generation = 1
      if (value.kind === 'ValidatingAdmissionPolicy') { value.status = { observedGeneration: 1, typeChecking: { expressionWarnings: [] } } }
      stored.set(`${options.path}/${value.metadata.name}`, value)
      response = { statusCode: 201, body: value }
    } else if (options.path.includes('?fieldSelector=') || options.path.endsWith('/secrets')) {
      response = { statusCode: 200, body: { apiVersion: 'meta.k8s.io/v1', kind: 'PartialObjectMetadataList', items: [] } }
    } else {
      const name = options.path.split('/').at(-1), kind = options.path.includes('/validatingadmissionpolicybindings/') ?
        'ValidatingAdmissionPolicyBinding' : 'ValidatingAdmissionPolicy'
      const nfs = input._nfs.find(item => item.name === name && item.kind === kind)
      const value = stored.get(options.path) ?? (nfs ? { ...nfs, apiVersion: 'admissionregistration.k8s.io/v1',
        metadata: { name: nfs.name, uid: nfs.uid } } : null)
      response = value ? { statusCode: 200, body: structuredClone(value) } : { statusCode: 404, body: null }
    }
    mutate(options, response)
    return response
  } }
  return { api, calls }
}
const approval = { execute: true, rootExecutionApproved: true, rootAcceptedSourcePin: sourceBasePin }

test('operator caller captures input and enables issuer binding only after guards and metadata gates', async () => {
  const input = fixtureInput(), fake = fakeOperator(input)
  const installer = createCollectorIdentityInstaller(input, fake.api)
  input.backingPvc.name = 'caller-mutated-after-capture'
  const result = await installer.install(approval, new AbortController().signal)
  assert.equal(result.phase, 'IDENTITY_AND_RBAC_CREATED_NOT_TOKEN_OR_EXEC_QUALIFIED')
  const posts = fake.calls.filter(call => call.method === 'POST')
  assert.equal(posts.length, 15)
  assert.equal(posts[0].body.kind, 'ServiceAccount')
  assert.equal(posts.at(-1).body.kind, 'RoleBinding')
  assert.equal(posts.at(-1).body.metadata.name, 'orca-storage-collector-issuer')
  const role = posts.find(call => call.body.kind === 'Role' && call.body.metadata.name === 'orca-storage-collector-read')
  assert.deepEqual(role.body.rules[1].resourceNames, ['fixture-backing'])
  assert.equal(fake.calls.filter(call => call.accept.includes('PartialObjectMetadataList')).length, 2)
  assert.equal(fake.calls.some(call => call.path.endsWith('/token')), false)
  assert.equal(result.issuedTokens, 0)
  assert.equal(result.physicalPinIssued, false)
})
test('existing deterministic identity is never adopted or overwritten', async () => {
  const input = fixtureInput(), fake = fakeOperator(input, (options, response) => {
    if (options.method === 'GET' && options.path.endsWith('/serviceaccounts/orca-storage-collector')) { response.statusCode = 200 }
  })
  const result = await createCollectorIdentityInstaller(input, fake.api).install(approval, new AbortController().signal)
  assert.equal(result.errorCode, 'OWNED_NAME_COLLISION')
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 0)
})
test('uncertain bootstrap is recalled once without POST retry or raw error disclosure', async () => {
  const input = fixtureInput(), fake = fakeOperator(input, options => {
    if (options.method === 'POST') { throw new Error('private-fixture-error-must-not-leak') }
  })
  const result = await createCollectorIdentityInstaller(input, fake.api).install(approval, new AbortController().signal)
  assert.equal(result.errorCode, 'CREATE_UNCERTAIN_NO_RETRY')
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal(result.observations[0].phase, 'UNCERTAIN_CREATE_RECALL')
  assert.equal(JSON.stringify(result).includes('private-fixture-error'), false)
})
test('HTTP 5xx bootstrap result is recalled once and never adopted or POSTed again', async () => {
  const input = fixtureInput(), fake = fakeOperator(input, (options, response) => {
    if (options.method === 'POST') {
      response.statusCode = 503
      response.body = { kind: 'Status', code: 503 }
    }
  })
  const result = await createCollectorIdentityInstaller(input, fake.api).install(approval, new AbortController().signal)
  const postIndex = fake.calls.findIndex(call => call.method === 'POST')
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal(fake.calls.slice(postIndex + 1).filter(call => call.method === 'GET').length, 1)
  assert.equal(result.errorCode, 'CREATE_UNCERTAIN_NO_RETRY')
  assert.equal(result.createIntents[0].statusCode, 503)
  assert.equal(result.createIntents[0].effect, 'UNKNOWN')
  assert.equal(result.created.length, 0)
  assert.equal(result.observations[0].identityConfirmed, true)
  assert.equal(result.observations[0].ownershipAccepted, false)
})
test('201 without verifiable identity is recalled once without accepting the recalled UID', async () => {
  const input = fixtureInput(), fake = fakeOperator(input, (options, response) => {
    if (options.method === 'POST') { response.body = { ...response.body,
      metadata: { ...response.body.metadata, uid: undefined } } }
  })
  const result = await createCollectorIdentityInstaller(input, fake.api).install(approval, new AbortController().signal)
  const postIndex = fake.calls.findIndex(call => call.method === 'POST')
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal(fake.calls.slice(postIndex + 1).filter(call => call.method === 'GET').length, 1)
  assert.equal(result.errorCode, 'CREATE_UNCERTAIN_NO_RETRY')
  assert.equal(result.createIntents[0].statusCode, 201)
  assert.equal(result.createIntents[0].failureCode, 'RESOURCE_IDENTITY_INVALID')
  assert.equal(result.createIntents[0].uid, null)
  assert.equal(result.created.length, 0)
  assert.equal(result.observations[0].identityConfirmed, true)
  assert.equal(result.observations[0].ownershipAccepted, false)
})
test('metadata negotiation failure closes before granting RBAC and never returns Secret content', async () => {
  const input = fixtureInput(), fake = fakeOperator(input, (options, response) => {
    if (options.path.endsWith('/secrets')) { response.body = { apiVersion: 'v1', kind: 'SecretList',
      items: [{ data: { fixture: 'must-not-leak' } }] } }
  })
  const result = await createCollectorIdentityInstaller(input, fake.api).install(approval, new AbortController().signal)
  assert.equal(result.errorCode, 'METADATA_ONLY_RESPONSE_REQUIRED')
  assert.equal(result.created.some(item => item.kind === 'RoleBinding'), false)
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false)
})
test('unexpected guard selectors cannot bypass the exact guard readback gate', async () => {
  const input = fixtureInput(), fake = fakeOperator(input, (options, response) => {
    if (options.method === 'GET' && options.path.endsWith('/validatingadmissionpolicies/orca-storage-collector-sa') && response.body) {
      response.body.spec.matchConstraints.objectSelector = { matchLabels: { bypass: 'true' } }
    }
  })
  const result = await createCollectorIdentityInstaller(input, fake.api).install(approval, new AbortController().signal)
  assert.equal(result.errorCode, 'CREDENTIAL_GUARD_READBACK_MISMATCH')
  assert.equal(result.created.some(item => item.kind === 'RoleBinding'), false)
})
test('manifests retain read-only collector and single named TokenRequest scopes', () => {
  const objects = leastPrivilegeRbac(fixtureInput())
  assert.equal(bootstrapServiceAccount().automountServiceAccountToken, false)
  assert.equal(credentialGuards(uid(300)).length, 8)
  assert.deepEqual(objects[0].rules[0], { apiGroups: [''], resources: ['pods', 'pods/exec'], verbs: ['get'] })
  assert.deepEqual(objects[2].rules, [{ apiGroups: [''], resources: ['serviceaccounts/token'],
    resourceNames: ['orca-storage-collector'], verbs: ['create'] }])
  assert.equal(objects.some(object => object.rules?.some(rule => rule.resources.includes('*') || rule.verbs.includes('*'))), false)
})
