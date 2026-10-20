import assert from 'node:assert/strict'
import test from 'node:test'
import { catalogUnitStorageDirectory, readCatalogUnitStorageAllocation } from './unit-storage-allocation.ts'

const unit = '10000000-0000-4000-8000-000000000001'
const other = '10000000-0000-4000-8000-000000000002'
const template = '/dataset/10000000-0000-4000-8000-000000000000'
const canonical = catalogUnitStorageDirectory(template, unit)
const request = { server: { storageAllocation: { kind: 'RUNTIME_UNIT_LEAF', unitId: unit,
  leafId: unit, templateCanonicalDirectory: template }, storagePathMapping: { canonicalDirectory: canonical } } }

test('independent units get sibling domains; recovery validates stored allocation', () => {
  assert.equal(canonical, `/dataset/${unit}`)
  assert.notEqual(canonical, catalogUnitStorageDirectory(template, other))
  assert.equal(readCatalogUnitStorageAllocation(request, unit, canonical)?.leafId, unit)
  assert.equal(readCatalogUnitStorageAllocation({ server: {} }, unit, template), null)
  assert.throws(() => readCatalogUnitStorageAllocation(request, other, canonical), /ALLOCATION_INVALID/)
  assert.throws(() => readCatalogUnitStorageAllocation(request, unit, template), /ALLOCATION_INVALID/)
  assert.throws(() => readCatalogUnitStorageAllocation({ server: { ...request.server,
    storagePathMapping: { canonicalDirectory: template } } }, unit, canonical), /ALLOCATION_INVALID/)
  for (const path of ['/', '/dataset/../escape', '/dataset//leaf', '/dataset/leaf/']) {
    assert.throws(() => catalogUnitStorageDirectory(path, unit), /STORAGE_CONFIGURATION/)
  }
  assert.throws(() => catalogUnitStorageDirectory(canonical, unit), /ALLOCATION_COLLISION/)
})
