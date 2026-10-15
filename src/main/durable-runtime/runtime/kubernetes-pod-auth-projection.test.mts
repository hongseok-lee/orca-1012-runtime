import assert from 'node:assert/strict'
import test from 'node:test'
import { createKubernetesPodAuthenticator, KubernetesPodAuthError } from './kubernetes-pod-auth.ts'
import { capturePodAuthInput, projectAuthenticatedNode, projectAuthenticatedPod,
  projectTokenReview } from './kubernetes-pod-auth-projection.ts'
import { config, expected, harness, node, pod, podToken, reviewerToken, tokenReview } from './kubernetes-pod-auth-fixtures.mts'

const rejected = (code: string) => (error: unknown) => error instanceof KubernetesPodAuthError && error.code === code
const claims = { nodeName: 'agent-node', nodeUid: 'node-uid' }

test('TokenReview requires explicit audience, authenticated success and exact SA identity', () => {
  assert.deepEqual(projectTokenReview(tokenReview(), config(), expected()), claims)
  for (const audiences of [[], ['other-audience']]) {
    const review = tokenReview(); review.status.audiences = audiences
    assert.throws(() => projectTokenReview(review, config(), expected()), rejected('AUDIENCE_MISMATCH'))
  }
  const missingAudience = tokenReview(); Reflect.deleteProperty(missingAudience.status, 'audiences')
  assert.throws(() => projectTokenReview(missingAudience, config(), expected()), rejected('AUDIENCE_MISMATCH'))
  for (const patch of [{ authenticated: false }, { error: 'denied' }]) {
    const review = tokenReview(); Object.assign(review.status, patch)
    assert.throws(() => projectTokenReview(review, config(), expected()), rejected('AUTHENTICATION_DENIED'))
  }
  for (const patch of [{ username: 'system:serviceaccount:other:agent-sa' }, { username: 'human' }, { uid: 'replacement-sa' }]) {
    const review = tokenReview(); Object.assign(review.status.user, patch)
    assert.throws(() => projectTokenReview(review, config(), expected()), rejected('SERVICE_ACCOUNT_MISMATCH'))
  }
  for (const patch of [{ kind: 'Secret' }, { apiVersion: 'v1' }, { status: null }]) {
    assert.throws(() => projectTokenReview({ ...tokenReview(), ...patch }, config(), expected()), rejected('TOKEN_REVIEW_INVALID'))
  }
})

test('Pod-bound claims are mandatory single opaque values and optional expected Node identity is exact', () => {
  for (const name of ['pod-name', 'pod-uid', 'node-name', 'node-uid']) {
    for (const value of [undefined, [], ['first', 'second'], [''], [' whitespace'], ['bad\nvalue'], 'not-an-array']) {
      const review = tokenReview()
      Object.assign(review.status.user.extra, { [`authentication.kubernetes.io/${name}`]: value })
      assert.throws(() => projectTokenReview(review, config(), expected()), rejected('TOKEN_REVIEW_INVALID'))
    }
  }
  const review = tokenReview(); review.status.user.extra['authentication.kubernetes.io/pod-uid'] = ['recreated-pod']
  assert.throws(() => projectTokenReview(review, config(), expected()), rejected('POD_IDENTITY_MISMATCH'))
  assert.throws(() => projectTokenReview(tokenReview(), config(), { ...expected(), nodeName: 'another', nodeUid: 'node-uid' }),
    rejected('NODE_IDENTITY_MISMATCH'))
  assert.throws(() => projectTokenReview(tokenReview(), config(), { ...expected(), nodeName: 'agent-node', nodeUid: 'replacement' }),
    rejected('NODE_IDENTITY_MISMATCH'))
})

test('exact Pod projection reuses inventory role/dataset/unit/operation/epoch/spec validation', () => {
  assert.equal(projectAuthenticatedPod(pod(), config(), expected(), claims).resourceVersion, 'pod-rv')
  for (const patch of [{ uid: 'recreated' }, { resourceVersion: '' }, { namespace: 'another' }, { name: 'another' }]) {
    const object = pod(); Object.assign(object.metadata, patch)
    assert.throws(() => projectAuthenticatedPod(object, config(), expected(), claims), rejected('POD_IDENTITY_MISMATCH'))
  }
  for (const patch of [{ 'orca.dev/role': 'not-agent' }, { 'orca.dev/dataset': 'another' },
    { 'orca.dev/runtime-unit': '10000000-0000-4000-8000-000000000002' }]) {
    const object = pod(); Object.assign(object.metadata.labels, patch)
    assert.throws(() => projectAuthenticatedPod(object, config(), expected(), claims), rejected('POD_IDENTITY_MISMATCH'))
  }
  for (const patch of [{ 'orca.dev/operation-id': '20000000-0000-4000-8000-000000000002' },
    { 'orca.dev/execution-epoch': '20' }, { 'orca.dev/spec-hash': 'b'.repeat(64) }]) {
    const object = pod(); Object.assign(object.metadata.annotations, patch)
    assert.throws(() => projectAuthenticatedPod(object, config(), expected(), claims), rejected('POD_IDENTITY_MISMATCH'))
  }
  for (const patch of [{ serviceAccountName: 'another' }, { nodeName: 'another' }]) {
    const object = pod(); Object.assign(object.spec, patch)
    assert.throws(() => projectAuthenticatedPod(object, config(), expected(), claims), rejected('POD_IDENTITY_MISMATCH'))
  }
  assert.throws(() => projectAuthenticatedPod({ ...pod(), kind: 'Secret' }, config(), expected(), claims), rejected('POD_IDENTITY_MISMATCH'))
  const deleting = pod(); Object.assign(deleting.metadata, { deletionTimestamp: '2026-10-15T00:00:00Z' })
  assert.throws(() => projectAuthenticatedPod(deleting, config(), expected(), claims), rejected('RESOURCE_DELETING'))
})

test('Node GET identity is current Kubernetes observation, not Compute proof', () => {
  const projected = projectAuthenticatedNode(node(), claims)
  assert.equal(projected.providerId, 'gce://fixture-project/fixture-zone/fixture-instance')
  assert.equal(projected.instanceId, 'fixture-instance-id')
  assert.equal(projected.observationSource, 'KUBERNETES_API')
  for (const patch of [{ uid: 'replacement-node' }, { name: 'another' }, { resourceVersion: '' }]) {
    const object = node(); Object.assign(object.metadata, patch)
    assert.throws(() => projectAuthenticatedNode(object, claims), rejected('NODE_IDENTITY_MISMATCH'))
  }
  const deleting = node(); Object.assign(deleting.metadata, { deletionTimestamp: '2026-10-15T00:00:00Z' })
  assert.throws(() => projectAuthenticatedNode(deleting, claims), rejected('RESOURCE_DELETING'))
  assert.throws(() => projectAuthenticatedNode({ ...node(), kind: 'Pod' }, claims), rejected('NODE_IDENTITY_MISMATCH'))
  const optional = node(); Reflect.deleteProperty(optional, 'spec'); Reflect.deleteProperty(optional.metadata, 'annotations')
  assert.equal(projectAuthenticatedNode(optional, claims).providerId, undefined)
})

test('configuration and input reject unsafe origin, missing authority and malformed expected identity before I/O', () => {
  for (const origin of ['http://kubernetes.invalid', 'https://user:password@kubernetes.invalid',
    'https://kubernetes.invalid/path', 'https://kubernetes.invalid/?secret=1', 'https://kubernetes.invalid/#fragment']) {
    assert.throws(() => createKubernetesPodAuthenticator({ ...config(), apiOrigin: origin }), rejected('CONFIG_INVALID'))
  }
  for (const patch of [{ ca: new Uint8Array() }, { audience: '' }, { clusterIdentityRef: '' },
    { timeoutMs: 0 }, { timeoutMs: Infinity }, { namespace: 'bad/namespace' }]) {
    assert.throws(() => createKubernetesPodAuthenticator({ ...config(), ...patch }), rejected('CONFIG_INVALID'))
  }
  for (const patch of [{ podUid: '' }, { runtimeUnitId: 'not-uuid' }, { executionEpoch: '-1' },
    { specHash: 'invalid' }, { nodeName: 'agent-node' }, { nodeUid: 'node-uid' }]) {
    assert.throws(() => capturePodAuthInput({ podBearer: podToken, expected: { ...expected(), ...patch } }), rejected('INPUT_INVALID'))
  }
  assert.throws(() => capturePodAuthInput({ podBearer: 'bad\nheader', expected: expected() }), rejected('INPUT_INVALID'))
})

test('echoed TokenReview spec and raw workload secrets never escape deeply frozen allowlist/digest', async () => {
  const h = harness(), auth = createKubernetesPodAuthenticator(config(), h.transport)
  const observation = await auth.authenticatePod({ podBearer: podToken, expected: expected() }, new AbortController().signal)
  assert.equal(observation.kind, 'AUTHENTICATED_POD_OBSERVATION')
  assert.equal(Object.isFrozen(observation), true)
  for (const part of [observation.serviceAccount, observation.pod, observation.node]) { assert.equal(Object.isFrozen(part), true) }
  assert.match(observation.evidenceDigest, /^[0-9a-f]{64}$/u)
  const serialized = JSON.stringify(observation)
  for (const forbidden of [podToken, reviewerToken, 'Authorization', 'containers', 'SYNTHETIC_SECRET', 'private', 'TokenReview']) {
    assert.equal(serialized.includes(forbidden), false)
  }
  const second = harness()
  assert.deepEqual(await createKubernetesPodAuthenticator(config(), second.transport)
    .authenticatePod({ podBearer: podToken, expected: expected() }, new AbortController().signal), observation)
  h.assertCleanup(); second.assertCleanup()
})
