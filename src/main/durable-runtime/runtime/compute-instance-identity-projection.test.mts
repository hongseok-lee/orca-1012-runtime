import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { inspect } from 'node:util'
import { projectComputeInstanceIdentity } from './compute-instance-identity-projection.ts'
import {
  isComputeNumericInstanceId, snapshotComputeIdentityInput
} from './compute-instance-identity-input.ts'
import { fixtureInput, fixtureProject, instanceResource, privateSentinel } from './compute-instance-identity-fixtures.mts'

test('positive canonical uint64 remains exact above MAX_SAFE_INTEGER and at uint64 maximum', () => {
  for (const id of ['1', '9007199254740993', '18446744073709551615']) {
    assert.equal(isComputeNumericInstanceId(id), true)
    const input = { ...fixtureInput, expectedNumericInstanceId: id }
    const result = projectComputeInstanceIdentity(fixtureProject, input, instanceResource({ id }))
    assert.equal(result.ok, true)
    if (!result.ok) {
      assert.fail('expected identity observation')
    }
    assert.equal(result.observation.numericInstanceId, id)
    assert.equal(Object.isFrozen(result), true)
    assert.equal(Object.isFrozen(result.observation), true)
  }
})

test('noncanonical, nonstring, zero, negative and overflowing numeric identities are rejected', () => {
  for (const id of ['0', '01', '-1', '+1', '1.0', '1e3', ' 1', '1\n',
    '18446744073709551616', '999999999999999999999', 1, null]) {
    assert.equal(isComputeNumericInstanceId(id), false)
    assert.deepEqual(projectComputeInstanceIdentity(fixtureProject, fixtureInput, instanceResource({ id })), {
      ok: false, error: { code: 'INVALID_NUMERIC_ID' }
    })
  }
})

test('both Google canonical origins are accepted and replacement numeric identity is rejected', () => {
  const resource = instanceResource()
  const replacement = projectComputeInstanceIdentity(fixtureProject, fixtureInput, instanceResource({ id: '1' }))
  assert.deepEqual(replacement, { ok: false, error: { code: 'INSTANCE_REPLACED' } })
  for (const origin of ['https://www.googleapis.com', 'https://compute.googleapis.com']) {
    const selfLink = String(resource.selfLink).replace('https://www.googleapis.com', origin)
    const zone = String(resource.zone).replace('https://www.googleapis.com', origin)
    assert.equal(projectComputeInstanceIdentity(fixtureProject, fixtureInput,
      instanceResource({ zone, selfLink })).ok, true)
  }
})

test('exact kind, name, project, zone and selfLink are required; URL normalization is forbidden', () => {
  assert.deepEqual(projectComputeInstanceIdentity(fixtureProject, fixtureInput,
    instanceResource({ kind: 'compute#disk' })), { ok: false, error: { code: 'INVALID_INSTANCE_KIND' } })
  const resource = instanceResource()
  const link = String(resource.selfLink)
  for (const overrides of [
    { name: 'another-instance' }, { zone: String(resource.zone).replace('-a', '-b') },
    { zone: String(resource.zone).replace(fixtureProject, 'another-project') },
    ...[`${link}?fields=id`, `${link}#fragment`, `${link}/suffix`,
      link.replace('https://', 'http://'), link.replace('https://', 'https://user:password@'),
      link.replace('.com/', '.com:443/'), link.replace('/instances/', '/instances%2f'),
      link.replace(fixtureProject, 'another-project'), link.replace('/zones/', '/zones/../zones/'),
      link.replace('www.googleapis.com', 'www.googleapis.com.attacker.invalid')]
      .map(selfLink => ({ selfLink }))
  ]) {
    assert.deepEqual(projectComputeInstanceIdentity(fixtureProject, fixtureInput, instanceResource(overrides)), {
      ok: false, error: { code: 'IDENTITY_MISMATCH' }
    })
  }
})

test('nonobjects and missing fields return immutable stable errors with no raw cause', () => {
  for (const raw of [null, [], 1, 'text', {}, ...['kind', 'name', 'id', 'zone', 'selfLink'].map(key => {
    const resource = instanceResource()
    delete resource[key]
    return resource
  })]) {
    const result = projectComputeInstanceIdentity(fixtureProject, fixtureInput, raw)
    assert.deepEqual(result, { ok: false, error: { code: 'INVALID_RESPONSE' } })
    assert.equal(Object.isFrozen(result), true)
    assert.equal(!result.ok && Object.isFrozen(result.error), true)
  }
})

test('sensitive fields and VM lifecycle status never enter observation or digest', () => {
  const resource = instanceResource()
  const baseline = projectComputeInstanceIdentity(fixtureProject, fixtureInput, resource)
  const enriched = instanceResource({ status: 'TERMINATED', projectNumber: privateSentinel,
    description: privateSentinel, labels: { privateSentinel },
    metadata: { items: [{ key: 'ssh-keys', value: privateSentinel }] },
    serviceAccounts: [{ email: privateSentinel }], networkInterfaces: [{ networkIP: privateSentinel }] })
  assert.deepEqual(projectComputeInstanceIdentity(fixtureProject, fixtureInput, enriched), baseline)
  Object.defineProperty(enriched, 'metadata', { get() { throw new Error(privateSentinel) } })
  const result = projectComputeInstanceIdentity(fixtureProject, fixtureInput, enriched)
  assert.deepEqual(result, baseline)
  assert.equal(JSON.stringify(result).includes(privateSentinel), false)
  assert.equal(inspect(result).includes(privateSentinel), false)
  if (!result.ok) {
    assert.fail('expected identity observation')
  }
  const { status, evidenceDigest, ...fields } = result.observation
  assert.equal(status, 'COMPUTE_INSTANCE_IDENTITY_OBSERVED')
  assert.equal(evidenceDigest, createHash('sha256').update(JSON.stringify(fields)).digest('hex'))
  assert.deepEqual(Object.keys(result.observation).sort(), ['status', 'source', 'projectId', 'zone',
    'instanceName', 'numericInstanceId', 'selfLink', 'evidenceDigest'].sort())
})

test('input segment validation rejects separators, whitespace, escapes, dot segments and excess length', () => {
  for (const field of ['zone', 'instanceName', 'expectedNumericInstanceId'] as const) {
    for (const value of ['', '../vm', 'vm/another', 'vm%2fnext', 'vm?query', 'vm#fragment', 'vm@host', ' vm',
      `${fixtureInput[field]}\n`]) {
      assert.equal(snapshotComputeIdentityInput({ ...fixtureInput, [field]: value }), null)
    }
  }
  assert.equal(snapshotComputeIdentityInput({ ...fixtureInput, instanceName: 'a'.repeat(64) }), null)
  assert.equal(snapshotComputeIdentityInput({ ...fixtureInput, zone: `${'a'.repeat(62)}-a` }), null)
})
