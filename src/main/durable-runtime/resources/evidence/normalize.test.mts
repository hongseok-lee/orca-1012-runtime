import test from 'node:test'
import assert from 'node:assert/strict'
import { evidenceDigest, snapshotJson } from './normalize.ts'

test('immutable normal snapshot can be digested again without rejecting its null prototype', () => {
  const raw = { target: ['original', 'tuple'], finishedAt: '1791888315123456789' }
  const prepared = snapshotJson(raw)
  assert.equal(evidenceDigest(prepared), evidenceDigest(raw))
  assert.equal(Object.getPrototypeOf(prepared), null)
  raw.target[0] = 'mutated'
  assert.notEqual(evidenceDigest(prepared), evidenceDigest(raw))
})
