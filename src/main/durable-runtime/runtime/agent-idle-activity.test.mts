import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentIdleActivity } from './agent-idle-activity.ts'

test('resident idle excludes queries and blocks turn, detached writer and PID reuse before closing admission', () => {
  let rows = [{ pid: 1, parent: 0, start: '1', state: 'S' }, { pid: 10, parent: 1, start: '2', state: 'S' }]
  const activity = createAgentIdleActivity(() => rows)
  activity.initialize()
  const initial = activity.observe()
  assert.equal(initial.idle, true)
  assert.equal(activity.observe().sequence, initial.sequence)
  assert.equal(activity.observe().lastWorkAt, initial.lastWorkAt)
  activity.beginTurn()
  assert.equal(activity.observe(true).idle, false)
  activity.notification('turn/completed', {})
  rows.push({ pid: 20, parent: 1, start: '3', state: 'S' })
  assert.equal(activity.observe(true).idle, false)
  rows = rows.filter(row => row.pid !== 20)
  rows[1] = { ...rows[1], start: '4' }
  assert.equal(activity.observe(true).idle, false)
  rows[1] = { ...rows[1], start: '2' }
  assert.equal(activity.observe(true).idle, true)
  assert.throws(() => activity.beginTurn(), /AGENT_IDLE_QUIESCED/)
  assert.throws(() => activity.assertInput(), /AGENT_IDLE_QUIESCED/)
  activity.resume()
  activity.assertInput()
})
