import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observeComputeCreationIdentityPage } from './compute-creation-identity.ts'
import { creationAuditRequestBody } from './compute-creation-identity-input.ts'
import { creationEntries, creationInput, creationSentinel } from './compute-creation-identity-fixtures.mts'
import type { CreationFixtureEntry } from './compute-creation-identity-fixtures.mts'
import { deletionEntries, fixtureInput as deletionInput } from './compute-deletion-audit-fixtures.mts'
import { projectComputeAuditPage } from './compute-deletion-audit-projection.ts'
import { evaluateComputeAuditPage } from './compute-deletion-audit-parser.ts'

function observe(entries: unknown, extra: Record<string, unknown> = {}) {
  return observeComputeCreationIdentityPage(creationInput, { entries, ...extra })
}
function rejected(change: (entries: [CreationFixtureEntry, CreationFixtureEntry]) => void) {
  const entries = creationEntries()
  change(entries)
  const result = observe(entries)
  assert.equal(result.ok && result.observation.status, 'UNCONFIRMED')
  assert.equal(JSON.stringify(result).includes(creationSentinel), false)
}

test('creation first response and absent final response preserve exact uint64 and no authority', () => {
  const entries = creationEntries(), result = observe(entries)
  assert.ok(result.ok && result.observation.status === 'CREATE_OPERATION_COMPLETED')
  const observation = result.observation
  assert.equal(observation.source, 'CLOUD_AUDIT_LOGS')
  assert.deepEqual(observation.identity, creationInput.scope)
  assert.equal(observation.identity.numericInstanceId, '18446744073709551615')
  assert.equal(observation.operationId, entries[0].operation.id)
  assert.ok(Object.isFrozen(result) && Object.isFrozen(observation.identity) && Object.isFrozen(observation.last))
  assert.match(observation.evidenceDigest, /^[a-f0-9]{64}$/)
  for (const excluded of [creationSentinel, 'exactEntryDigest', 'RUNNING', 'response',
    'VerifiedWorkloadIdentity', 'ComputeStoppedProof', 'permit']) {
    assert.equal(JSON.stringify(result).includes(excluded), false)
  }
  entries[0].protoPayload.authenticationInfo.principalEmail = 'another-synthetic-private-field'
  assert.deepEqual(observe(entries), result, 'raw-entry dedup digest is not public evidence')
  const [single] = creationEntries(); single.operation.last = true
  const immediate = observe([single])
  assert.equal(immediate.ok && immediate.observation.status, 'CREATE_OPERATION_COMPLETED')
})

test('creation input captures canonical scope and rejects overflow, separators and trailing newline', () => {
  for (const [field, invalid] of [
    ['numericInstanceId', '18446744073709551616'], ['numericInstanceId', '0'],
    ['numericInstanceId', '01'], ['numericInstanceId', '+1'], ['numericInstanceId', '1e10'],
    ['numericInstanceId', '123\n'], ['projectId', 'creation-fixture-project\n'],
    ['projectNumber', '123\n'], ['projectNumber', '0123'], ['zone', 'asia-northeast3-a\n'],
    ['instanceName', 'fixture-created-node\n'], ['instanceName', 'name/other'],
    ['instanceName', 'name" OR true'], ['zone', 'zone\\escape']
  ]) {
    const input = { ...creationInput, scope: { ...creationInput.scope, [field]: invalid } }
    assert.deepEqual(observeComputeCreationIdentityPage(input, {}), { ok: false, error: { code: 'INVALID_INPUT' } })
  }
  for (const startTime of ['2026-02-30T00:00:00Z', '2026-10-13T10:46:00Z', creationInput.startTime + '\n']) {
    assert.deepEqual(observeComputeCreationIdentityPage({ ...creationInput, startTime }, {}), {
      ok: false, error: { code: 'INVALID_INPUT' }
    })
  }
  const body = JSON.parse(creationAuditRequestBody(creationInput))
  assert.deepEqual(body.resourceNames, ['projects/creation-fixture-project'])
  assert.equal(body.pageSize, 100); assert.equal(body.orderBy, 'timestamp asc')
  assert.equal(body.pageToken, undefined)
  assert.equal(body.filter.includes('protoPayload.methodName="v1.compute.instances.insert"'), true)
  assert.equal(body.filter.includes('resource.labels.instance_id="18446744073709551615"'), true)
  assert.equal(body.filter.includes('projects/123456789012/zones/asia-northeast3-a/instances/fixture-created-node'), true)
})

test('creation rejects identity replacement, missing labels/type, wrong method and status ambiguity', () => {
  const changes: ((entries: [CreationFixtureEntry, CreationFixtureEntry]) => void)[] = [
    e => { e[1].resource.labels!.instance_id = '18446744073709551614' },
    e => { e[1].resource.labels!.instance_id = '018446744073709551615' },
    e => { e[1].resource.labels!.project_id = 'another-project' },
    e => { e[1].resource.labels!.zone = 'asia-northeast3-b' },
    e => { delete e[1].resource.labels },
    e => { delete e[1].protoPayload['@type'] },
    e => { e[1].protoPayload.methodName = 'v1.compute.instances.delete' },
    e => { e[1].protoPayload.serviceName = 'container.googleapis.com' },
    e => { e[1].protoPayload.resourceName += '-replacement' },
    e => { e[0].protoPayload.response!.targetId = '9007199254740997' },
    e => { e[0].protoPayload.response!.targetLink += '?unexpected=true' },
    e => { e[0].protoPayload.response!.zone += '/other' },
    e => { e[1].operation.last = 'true' },
    e => { e[1].insertId = '' },
    e => { e[1].timestamp = creationInput.endTime + '\n' }
  ]
  for (const change of changes) { rejected(change) }
  for (const index of [0, 1]) {
    for (const status of [undefined, null, [], '0', { code: '0' }, { code: 1 }, { code: 0.5 }]) {
      rejected(e => { e[index].protoPayload.status = status })
    }
  }
  const entries = creationEntries()
  entries[0].protoPayload.status = { code: 0 }; entries[1].protoPayload.status = {}
  const valid = observe(entries)
  assert.equal(valid.ok && valid.observation.status, 'CREATE_OPERATION_COMPLETED')
})

test('last response absence differs from malformed shape, invalid field types and provided contradictions', () => {
  for (const response of [null, [], 'invalid', 1, { targetId: null }, { name: 1 },
    { operationType: false }, { targetLink: [] }, { id: '0' }, { id: '18446744073709551616' },
    { zone: null }, { error: null }, { targetId: '123' }, { name: 'other-operation' },
    { operationType: 'delete' }, { targetLink: 'https://compute.googleapis.com/other' }]) {
    rejected(e => { Object.assign(e[1].protoPayload, { response }) })
  }
  for (const field of ['name', 'operationType', 'targetId', 'targetLink']) {
    rejected(e => { delete e[0].protoPayload.response![field] })
  }
  rejected(e => { e[0].protoPayload.response!.error = {} })
  const entries = creationEntries()
  entries[1].protoPayload.response = { targetId: creationInput.scope.numericInstanceId }
  delete entries[0].protoPayload.response!.zone
  const partial = observe(entries)
  assert.equal(partial.ok && partial.observation.status, 'CREATE_OPERATION_COMPLETED')
})

test('one operation only, exact dedup, one first/last and nanosecond order are required', () => {
  const entries = creationEntries()
  const duplicate = observe([...entries, structuredClone(entries[0])])
  assert.equal(duplicate.ok && duplicate.observation.status, 'CREATE_OPERATION_COMPLETED')
  const conflict = structuredClone(entries[0])
  conflict.protoPayload.authenticationInfo.principalEmail = 'different-raw-entry'
  const conflicting = observe([...entries, conflict])
  assert.deepEqual(conflicting, { ok: true, observation: { status: 'UNCONFIRMED', reason: 'CONFLICTING_INSERT_ID' } })
  for (const remaining of [[entries[0]], [entries[1]]]) {
    const missing = observe(remaining)
    assert.equal(missing.ok && missing.observation.status, 'UNCONFIRMED')
  }
  const another = structuredClone(entries[1])
  another.insertId += '-other'; another.operation.id += '-other'
  const ambiguous = observe([...entries, another])
  assert.deepEqual(ambiguous, { ok: true, observation: { status: 'UNCONFIRMED', reason: 'AMBIGUOUS_OPERATION' } })
  const secondFirst = structuredClone(entries[0]); secondFirst.insertId += '-other'
  const multipleFirsts = observe([...entries, secondFirst])
  assert.equal(multipleFirsts.ok && multipleFirsts.observation.status, 'UNCONFIRMED')
  rejected(e => { e[1].operation.producer = 'other.googleapis.com' })
  rejected(e => { e[0].timestamp = '2026-10-13T10:42:00.000000002Z'; e[1].timestamp = '2026-10-13T10:42:00.000000001Z' })
  rejected(e => { e[1].timestamp = '2026-10-13T10:45:00.000000001Z' })
})

test('creation empty observation, bounded pages and parser errors remain distinct', () => {
  assert.deepEqual(observe([]), { ok: true, observation: { status: 'NOT_OBSERVED', reason: 'NO_ENTRIES' } })
  assert.deepEqual(observe([], { nextPageToken: creationSentinel }), {
    ok: true, observation: { status: 'INCOMPLETE', reason: 'NEXT_PAGE_PRESENT' }
  })
  assert.deepEqual(observe(Array.from({ length: 101 }, () => creationEntries()[0])), {
    ok: true, observation: { status: 'INCOMPLETE', reason: 'PAGE_SIZE_EXCEEDED' }
  })
  assert.deepEqual(observe('invalid'), { ok: false, error: { code: 'INVALID_RESPONSE' } })
})

test('an intermediate row cannot borrow last-only response omission from a valid pair', () => {
  const entries = creationEntries(), intermediate = structuredClone(entries[1])
  intermediate.insertId = 'creation-intermediate'
  intermediate.timestamp = '2026-10-13T10:41:25.000000001Z'
  delete intermediate.operation.last
  const result = observe([entries[0], intermediate, entries[1]])
  assert.deepEqual(result, {
    ok: true, observation: { status: 'UNCONFIRMED', reason: 'IDENTITY_MISMATCH' }
  })
})

test('one deletion compatibility vector keeps its existing observation/digest when shape metadata is added', () => {
  const projected = projectComputeAuditPage({ entries: deletionEntries() })
  assert.ok(projected.ok)
  const legacyPage = structuredClone(projected.page)
  for (const entry of legacyPage.entries) {
    Reflect.deleteProperty(entry, 'responseShape')
  }
  // The unchanged deletion evaluator consumed this exact pre-metadata field shape.
  const before = evaluateComputeAuditPage(deletionInput, legacyPage)
  const after = evaluateComputeAuditPage(deletionInput, projected.page)
  assert.equal(before.status, 'DELETE_OPERATION_COMPLETED')
  assert.deepEqual(after, before)
})
