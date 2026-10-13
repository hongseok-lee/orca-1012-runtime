import assert from 'node:assert/strict'
import test from 'node:test'
import { recoverListWatch, resolveCreateObservation, type ListWatchTransport, type ListedResource } from './watch.ts'

// Deterministic transport fixtures only; no actual Kubernetes/fencing/HA claim.
const object: ListedResource = { namespace: 'fixture', name: 'persisted-original-name', uid: 'fixture-uid',
  operationId: 'fixture-operation', unitId: 'fixture-unit', executionEpoch: '1', specHash: 'fixture-spec', resourceVersion: 'opaque-rv' }

test('initial LIST and WATCH use the same observer and preserve initial inventory', async () => {
  const observed: string[] = []
  const transport: ListWatchTransport = {
    async list() { return { resourceVersion: 'list-rv', objects: [object] } },
    async watch(rv) { assert.equal(rv, 'list-rv'); return { status: 'EVENTS', resourceVersion: 'watch-rv', events: [] } },
    async get() { return object }
  }
  const result = await recoverListWatch(transport, async (_, source) => { observed.push(source) })
  assert.equal(result.status, 'OBSERVED')
  if (result.status === 'OBSERVED') { assert.equal(result.objects.length, 1) }
  assert.deepEqual(observed, ['LIST'])
})

test('WATCH 410 and disconnect recover once from a fresh LIST resourceVersion', async () => {
  for (const failure of ['EXPIRED_410', 'DISCONNECTED'] as const) {
    let lists = 0, watches = 0
    const transport: ListWatchTransport = {
      async list() { lists++; return { resourceVersion: `list-${lists}`, objects: [object] } },
      async watch(rv) { watches++; assert.equal(rv, `list-${watches}`); return { status: watches === 1 ? failure : 'EVENTS', resourceVersion: 'recovered-rv', events: [] } },
      async get() { return object }
    }
    const result = await recoverListWatch(transport)
    assert.equal(result.status, 'OBSERVED')
    if (result.status === 'OBSERVED') { assert.equal(result.relisted, true) }
    assert.equal(lists, 2); assert.equal(watches, 2)
  }
})

test('create ACK loss queries the same name and rejects a name-reused conflicting identity', async () => {
  const requested: string[] = []
  let gets = 0
  const transport: ListWatchTransport = {
    async list() { return { resourceVersion: 'rv', objects: [] } },
    async watch() { return { status: 'EVENTS', resourceVersion: 'rv2', events: [] } },
    async get(namespace, name) {
      requested.push(`${namespace}/${name}`); gets++
      if (gets === 1) { throw new Error('fixture response loss') }
      return gets === 2 ? object : { ...object, uid: 'other-fixture-uid' }
    }
  }
  assert.equal((await resolveCreateObservation(transport, object)).disposition, 'UNKNOWN')
  assert.equal((await resolveCreateObservation(transport, object)).disposition, 'MATCHED_UNVERIFIED')
  assert.equal((await resolveCreateObservation(transport, object)).disposition, 'CONFLICT_BLOCKED')
  assert.deepEqual(requested, Array(3).fill('fixture/persisted-original-name'))
})

test('LIST failure and observation persistence failure stay unverifiable, not empty success', async () => {
  const unavailable: ListWatchTransport = {
    async list() { throw new Error('fixture read failure') },
    async watch() { throw new Error('must not watch') },
    async get() { return null }
  }
  assert.deepEqual(await recoverListWatch(unavailable), { status: 'UNVERIFIABLE', reason: 'LIST_FAILED' })
  const readable: ListWatchTransport = {
    ...unavailable, async list() { return { resourceVersion: 'rv', objects: [object] } }
  }
  assert.deepEqual(await recoverListWatch(readable, async () => { throw new Error('fixture persistence failure') }),
    { status: 'UNVERIFIABLE', reason: 'PERSISTENCE_FAILED' })
})

test('create result lookup keeps the original expected tuple despite caller mutation during GET', async () => {
  const expected = { ...object }
  let gets = 0
  const transport: ListWatchTransport = {
    async list() { return { resourceVersion: 'rv', objects: [] } },
    async watch() { return { status: 'EVENTS', resourceVersion: 'rv2', events: [] } },
    async get(namespace, name) {
      gets++
      assert.equal(namespace, object.namespace); assert.equal(name, object.name)
      expected.namespace = 'changed-namespace'; expected.name = 'changed-during-await'; expected.uid = 'changed-uid'
      expected.operationId = 'changed-operation'; expected.unitId = 'changed-unit'; expected.executionEpoch = '2'; expected.specHash = 'changed-spec'
      return object
    }
  }
  assert.equal((await resolveCreateObservation(transport, expected)).disposition, 'MATCHED_UNVERIFIED')
  await assert.rejects(resolveCreateObservation(transport, { ...object, executionEpoch: 'invalid' }), /Invalid durable BIGINT/)
  await assert.rejects(resolveCreateObservation(transport, { ...object, unitId: '' }), /Invalid original resource identity/)
  assert.equal(gets, 1)
})


test('WATCH exact UID DELETE preserves same-name replacement and original event history', async () => {
  const replacement = { ...object, uid: 'replacement-fixture-uid', resourceVersion: 'replacement-rv' }
  const history: string[] = []
  const transport: ListWatchTransport = {
    async list() { return { resourceVersion: 'list-rv', objects: [object, replacement] } },
    async watch() { return { status: 'EVENTS', resourceVersion: 'bookmark-rv', events: [
      { type: 'MODIFIED', object: { ...replacement, resourceVersion: 'modified-rv' } },
      { type: 'DELETED', object: { ...object, resourceVersion: 'deleted-rv' } },
      { type: 'BOOKMARK', resourceVersion: 'bookmark-rv' }
    ] } },
    async get() { return replacement }
  }
  const result = await recoverListWatch(transport, async (event, source) => {
    history.push(`${source}:${event.type}:${event.type === 'BOOKMARK' ? event.resourceVersion : event.object.uid}`)
  })
  assert.equal(result.status, 'OBSERVED')
  if (result.status === 'OBSERVED') {
    assert.deepEqual(result.objects, [{ ...replacement, resourceVersion: 'modified-rv' }])
    assert.equal(result.resourceVersion, 'bookmark-rv')
    const deleted = result.history.find(event => event.type === 'DELETED' && event.object.uid === object.uid)
    assert.ok(deleted && deleted.type !== 'BOOKMARK')
    assert.equal(deleted.object.uid, object.uid)
    assert.equal(result.history.length, 5)
  }
  assert.deepEqual(history, [`LIST:ADDED:${object.uid}`, `LIST:ADDED:${replacement.uid}`,
    `WATCH:MODIFIED:${replacement.uid}`, `WATCH:DELETED:${object.uid}`, 'WATCH:BOOKMARK:bookmark-rv'])
})
