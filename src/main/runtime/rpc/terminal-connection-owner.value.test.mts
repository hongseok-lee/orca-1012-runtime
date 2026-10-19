import test from 'node:test'
import assert from 'node:assert/strict'
import { TerminalConnectionOwner } from './terminal-connection-owner.ts'

const target = { handle: 'term_1', sessionId: 'session-1', mode: 'AGENT_CHAT_COMPAT' as const }
const mac = { device: 'device-mac', caller: 'a'.repeat(64) }, phone = { device: 'device-phone', caller: 'b'.repeat(64) }
function connect(owner: TerminalConnectionOwner, id: string, who: { device: string; caller: string }) {
  owner.register(id, who.device)
  return owner.capture(id, who.device, who.caller, () => true)
}

test('another device takes the logical floor over only when it names the current holder', () => {
  const owner = new TerminalConnectionOwner()
  const first = connect(owner, 'mac', mac), second = connect(owner, 'phone', phone)
  first.reserveLogicalFloor(target, null).commit()
  assert.throws(() => second.reserveLogicalFloor(target, null, true), /LOGICAL_FLOOR_OWNED/)
  assert.throws(() => second.reserveLogicalFloor(target, 'stale-connection', true), /LOGICAL_FLOOR_OWNED/)
  second.reserveLogicalFloor(target, first.connectionIncarnation, true).commit()
  first.reserveLogicalFloor(target, second.connectionIncarnation, true).commit()
})

test('the same device on a live second connection still needs the first one invalidated', () => {
  const owner = new TerminalConnectionOwner()
  const first = connect(owner, 'mac-1', mac), again = connect(owner, 'mac-2', mac)
  first.reserveLogicalFloor(target, null).commit()
  assert.throws(() => again.reserveLogicalFloor(target, first.connectionIncarnation), /INVALIDATION_UNPROVEN/)
  owner.invalidate('mac-1')
  again.reserveLogicalFloor(target, first.connectionIncarnation).commit()
})

test('after a server restart the same device and caller take the earlier floor over', () => {
  const earlier = connect(new TerminalConnectionOwner(), 'mac', mac)
  const restarted = new TerminalConnectionOwner()
  connect(restarted, 'mac', mac).reserveLogicalFloor(target, earlier.connectionIncarnation).commit()
  assert.throws(() => connect(restarted, 'other-mac', mac).assertPreviousInvalidated(earlier.connectionIncarnation, phone.device, mac.caller),
    /INVALIDATION_UNPROVEN/)
})
