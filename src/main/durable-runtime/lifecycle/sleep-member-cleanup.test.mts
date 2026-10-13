import assert from 'node:assert/strict'
import test from 'node:test'
import { counter } from '../../../shared/durable-runtime/identity.ts'
import { withDurableTransaction } from '../db/connection.ts'
import { reserveSleep } from './sleep.ts'
import { activity, fixture, ownPool, policy, stoppedMetadataAttempt } from './verification-fixtures.mts'

const enabled = (process.env.PGDATABASE ?? '').startsWith('orca_p113_')

// Prepared activity frames are fixture evidence, never provider/G04 proof.
test('closed cleaned member remains locked but does not block idle sibling sleep', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool)
    const a = await stoppedMetadataAttempt(pool, f, true)
    await pool.query("UPDATE durable_runtime.sessions SET lifecycle='CLOSED' WHERE id=$1", [f.sessions[0]])
    const membersBefore = await pool.query('SELECT session_id FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1 ORDER BY session_id', [f.unit])
    const result = await withDurableTransaction(pool, tx => reserveSleep(tx, {
      unitId: f.unit, actorId: 'fixture-catalog', discoveredMembers: f.sessions,
      expectedRevision: counter('row:runtime-unit', '0'), expectedIntentRevision: counter('intent-revision', '0'),
      policy, activityFreshnessMs: 60000, activity: activity(f, a)
    }))
    assert.equal(result.status, 'RESERVED')
    if (result.status === 'RESERVED') { assert.equal(result.intent.desired, 'SUSPENDED') }
    const membersAfter = await pool.query('SELECT session_id FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1 ORDER BY session_id', [f.unit])
    assert.deepEqual(membersAfter.rows, membersBefore.rows)
    assert.equal(membersAfter.rowCount, 2)
  } finally { await pool.end() }
})

test('closing member with incomplete cleanup conservatively defers sleep despite idle sibling', { skip: !enabled }, async () => {
  const pool = ownPool()
  try {
    const f = await fixture(pool)
    const a = await stoppedMetadataAttempt(pool, f, true)
    await pool.query("UPDATE durable_runtime.sessions SET lifecycle='CLOSING' WHERE id=$1", [f.sessions[0]])
    const result = await withDurableTransaction(pool, tx => reserveSleep(tx, {
      unitId: f.unit, actorId: 'fixture-catalog', discoveredMembers: f.sessions,
      expectedRevision: counter('row:runtime-unit', '0'), expectedIntentRevision: counter('intent-revision', '0'),
      policy, activityFreshnessMs: 60000, activity: activity(f, a)
    }))
    assert.deepEqual(result, { status: 'DEFERRED', reason: 'SESSION_CLOSING' })
    const unit = await pool.query('SELECT desired_mode,intent_revision FROM durable_runtime.runtime_units WHERE id=$1', [f.unit])
    assert.equal(unit.rows[0].desired_mode, 'RUNNING')
    assert.equal(unit.rows[0].intent_revision, '0')
  } finally { await pool.end() }
})
