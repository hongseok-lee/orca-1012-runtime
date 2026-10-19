import test from 'node:test'
import assert from 'node:assert/strict'
import { completedNativeTurn } from './orphaned-turn-settlement.ts'

const frame = (method: string, params: unknown) => ({ connectionId: 'c', sequence: '1', method, params, observedAt: new Date().toISOString() }) as never

test('completion frames name the native turn they close', () => {
  assert.equal(completedNativeTurn(frame('turn/completed', { threadId: 't', turn: { id: 'turn-1', status: 'completed' } })), 'turn-1')
  assert.equal(completedNativeTurn(frame('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } })), null)
  assert.equal(completedNativeTurn(frame('claude/message', { type: 'result', subtype: 'success', user_message_uuid: 'u-1' })), 'u-1')
  assert.equal(completedNativeTurn(frame('claude/message', { type: 'result', subtype: 'error_during_execution', user_message_uuid: 'u-1' })), null)
  assert.equal(completedNativeTurn(frame('claude/message', { type: 'assistant' })), null)
  assert.equal(completedNativeTurn(frame('item/completed', { turn: { id: 'x', status: 'completed' } })), null)
})

// New failure boundary: terminal failure closes this original turn without implying success.
test('failed original turns are terminal; unknown and running are not', () => {
  assert.equal(completedNativeTurn(frame('turn/completed', { threadId: 't', turn: { id: 'failed-turn', status: 'failed' } })), 'failed-turn')
  for (const status of ['inProgress', 'unknown', null]) {
    assert.equal(completedNativeTurn(frame('turn/completed', { threadId: 't', turn: { id: 'failed-turn', status } })), null)
  }
})
