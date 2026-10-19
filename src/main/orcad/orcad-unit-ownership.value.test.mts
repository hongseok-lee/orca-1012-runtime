import assert from 'node:assert/strict'
import test from 'node:test'
import { createUnitOwnership } from './orcad-unit-ownership.ts'

// PG stand-in: which attempts are the unit's live active attempt, and which operations are open.
function harness() {
  const liveAttempts = new Set<string>(), openOperations = new Set<string>()
  const pool = { async query(_sql: string, [, attemptId, operationId]: [string, string | null, string | null]) {
    return { rowCount: (attemptId && liveAttempts.has(attemptId)) || (operationId && openOperations.has(operationId)) ? 1 : 0 }
  } }
  return { ownership: createUnitOwnership(pool as never), liveAttempts, openOperations }
}

test('one owner per unit while its claim holds in PG; a fenced claim gives way', async () => {
  const { ownership, liveAttempts } = harness()
  liveAttempts.add('attempt-1')
  assert.equal(await ownership.claim('unit', 'session', 'adopted', { attemptId: 'attempt-1' }), true)
  assert.equal(await ownership.claim('unit', 'session', 'first-managed', { attemptId: 'attempt-1' }), false)
  assert.equal(ownership.ownerOfSession('session'), 'adopted')
  liveAttempts.delete('attempt-1') // orphan reconciliation stopped it
  assert.equal(await ownership.claim('unit', 'session', 'rewake', { operationId: 'wake-2', attemptId: 'attempt-2' }), true)
  assert.equal(ownership.ownerOfSession('session'), 'rewake')
})

test('a wake holds the unit through its open operation, then through its attempt', async () => {
  const { ownership, liveAttempts, openOperations } = harness()
  openOperations.add('wake')
  assert.equal(await ownership.claim('unit', 'session', 'rewake', { operationId: 'wake', attemptId: 'attempt' }), true)
  assert.equal(await ownership.claim('unit', 'session', 'adopted', { attemptId: 'attempt' }), false)
  openOperations.delete('wake'); liveAttempts.add('attempt') // READY: operation settled, attempt active
  assert.equal(await ownership.claim('unit', 'session', 'adopted', { attemptId: 'attempt' }), false)
  ownership.release('unit', 'rewake')
  assert.equal(await ownership.claim('unit', 'session', 'adopted', { attemptId: 'attempt' }), true)
})
