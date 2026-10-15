import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observeComputeDeletionAuditPage } from './compute-deletion-audit.ts'
import { auditTimestamp, computeAuditRequestBody } from './compute-deletion-audit-input.ts'
import { deletionEntries, fixtureInput, privateSentinel } from './compute-deletion-audit-fixtures.mts'
import type { AuditFixtureEntry } from './compute-deletion-audit-fixtures.mts'

function observe(entries: unknown, extra: Record<string, unknown> = {}) {
  return observeComputeDeletionAuditPage(fixtureInput, { entries, ...extra })
}
function observedStatus(entries: unknown): string {
  const result = observe(entries)
  return result.ok ? result.observation.status : result.error.code
}
function rejectChange(change: (entries: [AuditFixtureEntry, AuditFixtureEntry]) => void) {
  const entries = deletionEntries()
  change(entries)
  const result = observe(entries)
  assert.equal(result.ok && result.observation.status, 'UNCONFIRMED')
  assert.equal(JSON.stringify(result).includes(privateSentinel), false)
}

test('first+last yields an immutable exact-identity observation, not a proof or raw audit body', () => {
  const result = observe(deletionEntries())
  assert.equal(result.ok, true)
  if (!result.ok || result.observation.status !== 'DELETE_OPERATION_COMPLETED') {
    assert.fail('expected a completed observation')
  }
  const observation = result.observation
  assert.deepEqual(observation.identity, fixtureInput.scope)
  assert.equal(observation.operationId, 'operation-123456789-fixture')
  assert.equal(observation.first.insertId, 'fixture-first')
  assert.equal(observation.last.insertId, 'fixture-last')
  assert.match(observation.evidenceDigest, /^[a-f0-9]{64}$/)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(observation.identity), true)
  assert.equal(Object.isFrozen(observation.first), true)
  assert.equal(Reflect.set(observation.identity, 'numericInstanceId', 'other'), false)
  assert.equal(observation.identity.numericInstanceId, fixtureInput.scope.numericInstanceId)
  const serialized = JSON.stringify(result)
  for (const field of [privateSentinel, 'authenticationInfo', 'principalEmail', 'request',
    'exactEntryDigest', 'ComputeStoppedProof', 'ProviderEffectPermit']) {
    assert.equal(serialized.includes(field), false)
  }
})

test('status{} and numeric zero both qualify; last needs no response/DONE value', () => {
  const entries = deletionEntries()
  entries[0].protoPayload.status = { code: 0, message: privateSentinel }
  entries[1].protoPayload.status = { details: [{ authentication: privateSentinel }] }
  const result = observe(entries)
  assert.equal(result.ok && result.observation.status, 'DELETE_OPERATION_COMPLETED')
  assert.equal(JSON.stringify(result).includes(privateSentinel), false)
})

test('one exact entry with first and last is a valid immediate completion', () => {
  const [first] = deletionEntries()
  first.operation.last = true
  const result = observe([first])
  assert.equal(result.ok && result.observation.status, 'DELETE_OPERATION_COMPLETED')
})

test('empty success differs from pagination and malformed API JSON shape', () => {
  assert.deepEqual(observe([]), { ok: true, observation: { status: 'NOT_OBSERVED', reason: 'NO_ENTRIES' } })
  assert.deepEqual(observeComputeDeletionAuditPage(fixtureInput, {}), observe([]))
  assert.deepEqual(observe([], { nextPageToken: privateSentinel }), {
    ok: true, observation: { status: 'INCOMPLETE', reason: 'NEXT_PAGE_PRESENT' }
  })
  assert.deepEqual(observe('invalid'), { ok: false, error: { code: 'INVALID_RESPONSE' } })
  assert.deepEqual(observe([], { nextPageToken: {} }), { ok: false, error: { code: 'INVALID_RESPONSE' } })
  const entries = Array.from({ length: 101 }, () => deletionEntries()[0])
  assert.equal(observedStatus(entries), 'INCOMPLETE')
})

test('all non-OK status forms and missing status are unconfirmed', () => {
  for (const status of [{ code: 7 }, { code: '0' }, { code: null }, { code: false },
    { code: 0.5 }, null, [], undefined]) {
    const entries = deletionEntries()
    const raw = JSON.parse(JSON.stringify(entries))
    raw[1].protoPayload.status = status
    const result = observe(raw)
    assert.equal(result.ok && result.observation.status, 'UNCONFIRMED')
  }
})

test('project ID, project number, VM identity and resource labels are independently exact', () => {
  const changes: ((entries: [AuditFixtureEntry, AuditFixtureEntry]) => void)[] = [
    e => { e[1].resource.labels.instance_id = '1143681254863137002' },
    e => { e[1].resource.labels.project_id = 'other-project' },
    e => { e[1].resource.labels.zone = 'asia-northeast3-b' },
    e => { e[1].resource.type = 'k8s_node' },
    e => { e[1].protoPayload.resourceName = e[1].protoPayload.resourceName.replace('123456789012', 'audit-fixture-project') },
    e => { e[0].protoPayload.response!.targetId = 'other-numeric-id' },
    e => { e[0].protoPayload.response!.operationType = 'stop' },
    e => { e[0].protoPayload.response!.name = 'operation-different' },
    e => { e[1].logName = 'projects/other-project/logs/cloudaudit.googleapis.com%2Factivity' },
    e => { e[1].protoPayload.methodName = 'v1.compute.instances.stop' },
    e => { e[1].protoPayload.serviceName = 'container.googleapis.com' }
  ]
  for (const change of changes) {
    rejectChange(change)
  }
})

test('canonical Compute origin/path is required; no query, fragment, userinfo or lookalike host', () => {
  for (const transform of [
    (s: string) => `${s}?credential=${privateSentinel}`,
    (s: string) => `${s}#fragment`,
    (s: string) => s.replace('www.googleapis.com', 'www.googleapis.com.invalid'),
    (s: string) => s.replace('https://', 'https://user@'),
    (s: string) => s.replace('audit-fixture-project', '123456789012'),
    (s: string) => s.replace('https://', 'http://')
  ]) {
    rejectChange(e => { e[0].protoPayload.response!.targetLink = transform(e[0].protoPayload.response!.targetLink) })
  }
  rejectChange(e => { e[0].protoPayload.response!.zone += '/other' })
})

test('producer, operation linking and required first/last cannot be inferred from last=true', () => {
  rejectChange(e => { e[1].operation.producer = 'other.googleapis.com' })
  rejectChange(e => { e[1].operation.id = 'operation-other' })
  rejectChange(e => { e[0].operation.first = false })
  rejectChange(e => { e[1].operation.last = false })
  const [, last] = deletionEntries()
  assert.equal(observedStatus([last]), 'UNCONFIRMED')
})

test('invalid/out-of-window/reversed nanosecond timestamps cannot complete', () => {
  for (const timestamp of ['2026-02-30T00:00:00Z', 'not-a-time', '2026-10-14T11:29:59Z',
    '2026-10-14T11:40:00.000000001Z']) {
    rejectChange(e => { e[1].timestamp = timestamp })
  }
  rejectChange(e => {
    e[0].timestamp = '2026-10-14T11:34:00.000000002Z'
    e[1].timestamp = '2026-10-14T11:34:00.000000001Z'
  })
  assert.equal(auditTimestamp('2026-10-14T12:00:00+01:00'), auditTimestamp('2026-10-14T11:00:00Z'))
})

test('only exact original duplicates collapse; conflicting insert ID or multiple success pairs are unknown', () => {
  const entries = deletionEntries()
  assert.equal(observedStatus([...entries, structuredClone(entries[0])]), 'DELETE_OPERATION_COMPLETED')
  const conflict = structuredClone(entries[0])
  conflict.protoPayload.authenticationInfo.principalEmail = 'different-private-sentinel'
  assert.equal(observedStatus([...entries, conflict]), 'UNCONFIRMED')
  const another = deletionEntries()
  for (const entry of another) {
    entry.insertId += '-other'
    entry.operation.id += '-other'
  }
  another[0].protoPayload.response!.name = another[0].operation.id
  const result = observe([...entries, ...another])
  assert.equal(result.ok && result.observation.status, 'UNCONFIRMED')
})

test('request is exact, escaped and single-page; numeric identity stays a string', () => {
  const body = JSON.parse(computeAuditRequestBody(fixtureInput))
  assert.deepEqual(body.resourceNames, ['projects/audit-fixture-project'])
  assert.equal(body.pageSize, 100)
  assert.equal(body.pageToken, undefined)
  assert.equal(body.filter.includes('resource.labels.instance_id="1143681254863137001"'), true)
  assert.equal(body.filter.includes('protoPayload.resourceName="projects/123456789012/'), true)
  const invalid = { ...fixtureInput, scope: { ...fixtureInput.scope, instanceName: 'name" OR true' } }
  assert.deepEqual(observeComputeDeletionAuditPage(invalid, {}), { ok: false, error: { code: 'INVALID_INPUT' } })
})
