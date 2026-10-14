import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { deriveCatalogAggregateAnchor, type CatalogAggregateHead } from './aggregate-anchor.ts'

// New Root anchor contract cases. Written only; heavy-slot allocation is pending.
const head = (): CatalogAggregateHead => ({
  dataset_name: 'orca-1012-dev-v1', scope: 'catalog', publication_epoch: 'synthetic-epoch:not-a-uuid'
})

test('global anchor retains the exact tuple and SHA-256 prefix with stable version-8 UUID bits', () => {
  const input = head()
  const anchor = deriveCatalogAggregateAnchor(input)
  const tuple = ['orca-1012-catalog-aggregate-v1', input.dataset_name, input.scope, input.publication_epoch]
  assert.deepEqual(anchor.sourceTuple, tuple)
  assert.equal(Object.isFrozen(anchor.sourceTuple), true)
  assert.equal(Object.isFrozen(anchor), true)
  assert.match(anchor.aggregateId, /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  const prefix = createHash('sha256').update(JSON.stringify(tuple)).digest().subarray(0, 16)
  const actual = Buffer.from(anchor.aggregateId.replaceAll('-', ''), 'hex')
  for (let index = 0; index < 16; index++) {
    const mask = index === 6 ? 0x0f : index === 8 ? 0x3f : 0xff
    assert.equal(actual[index] & mask, prefix[index] & mask)
  }
  assert.equal(deriveCatalogAggregateAnchor({ ...input }).aggregateId, anchor.aggregateId)
  const laterRevision = { ...input, revision: '999' }
  assert.equal(deriveCatalogAggregateAnchor(laterRevision).aggregateId, anchor.aggregateId)
  input.publication_epoch = 'synthetic-mutated-after-capture'
  assert.deepEqual(anchor.sourceTuple, tuple)
})

test('text publication epochs and head scopes separate anchors without requiring epoch UUIDs', () => {
  const input = head()
  const initial = deriveCatalogAggregateAnchor(input)
  const nextEpoch = deriveCatalogAggregateAnchor({ ...input, publication_epoch: 'synthetic-next-epoch' })
  const nextScope = deriveCatalogAggregateAnchor({ ...input, scope: 'ui:host' })
  assert.notEqual(nextEpoch.aggregateId, initial.aggregateId)
  assert.notEqual(nextScope.aggregateId, initial.aggregateId)
  assert.equal(nextEpoch.sourceTuple[3], 'synthetic-next-epoch')
  assert.equal(nextScope.sourceTuple[2], 'ui:host')
})
