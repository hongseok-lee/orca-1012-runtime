import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveMobileNativeChat, resolveMobileNativeChatFileSessionId, type MobileNativeChatTab } from '../../../../mobile/src/session/mobile-native-chat-eligibility.ts'
import { mobileSessionTabsEqual } from '../../../../mobile/src/session/mobile-terminal-records.ts'
import { isRuntimeTerminalNativeChatSession } from '../../../shared/runtime-mobile-session-tab-contracts.ts'
import { parseCatalogTab } from './payload.ts'
import type { CatalogTab } from './read.ts'

test('original Terminal native identity wins, absent retains legacy, invalid never falls back', () => {
  const identity = { agent: 'codex' as const, sessionId: 'synthetic-original-thread' }
  const legacy = { type: 'terminal', launchAgent: 'codex', agentStatus: {
    agentType: 'codex', providerSession: { id: 'legacy-thread', transcriptPath: '/synthetic/legacy' }
  } } as MobileNativeChatTab
  assert.deepEqual(resolveMobileNativeChat({ ...legacy, nativeChatSession: identity }), {
    agent: 'codex', sessionId: identity.sessionId, transcriptPath: null
  })
  assert.equal(resolveMobileNativeChatFileSessionId({ ...legacy, nativeChatSession: identity }), identity.sessionId)
  assert.equal(resolveMobileNativeChat(legacy)?.sessionId, 'legacy-thread')
  assert.equal(resolveMobileNativeChatFileSessionId(legacy), 'legacy-thread')
  for (const invalid of [null, { agent: 'gemini', sessionId: 'wrong' }, { agent: 'codex', sessionId: '' },
    { agent: 'codex', sessionId: ' padded ' }, { agent: 'codex', sessionId: 'line\nbreak' }]) {
    assert.equal(isRuntimeTerminalNativeChatSession(invalid), false)
    assert.equal(resolveMobileNativeChat({ ...legacy, nativeChatSession: invalid } as never), null)
    assert.equal(resolveMobileNativeChatFileSessionId({ ...legacy, nativeChatSession: invalid } as never), null)
  }
  assert.deepEqual(resolveMobileNativeChat({ type: 'agent-session', agent: 'codex', sessionId: 'structured',
    nativeChatSession: identity }), { agent: 'codex', sessionId: 'structured', transcriptPath: null })
  const tab = { type: 'terminal' as const, id: 'tab', title: 'Synthetic', isActive: true,
    parentTabId: 'tab', leafId: 'leaf', status: 'ready' as const, terminal: 'terminal' }
  assert.equal(mobileSessionTabsEqual([tab], [{ ...tab, nativeChatSession: identity }]), false)
  assert.equal(mobileSessionTabsEqual([{ ...tab, nativeChatSession: identity }], [{ ...tab, nativeChatSession: { ...identity } }]), true)
  const row = { public_tab_id: 'tab', payload: tab, terminal_handle: 'terminal', kind: 'terminal' } as CatalogTab
  assert.deepEqual(parseCatalogTab({ ...row, terminal_native_chat_session: identity }), { ...tab, nativeChatSession: identity })
  assert.equal(Object.hasOwn(row.payload, 'nativeChatSession'), false)
  assert.throws(() => parseCatalogTab({ ...row, payload: { ...tab, nativeChatSession: identity } }), /CATALOG_NATIVE_SESSION_STORED_PAYLOAD/)
})

test('a READY native session is addressed by its durable handle; without one the stored tab is unchanged', () => {
  const identity = { agent: 'codex' as const, sessionId: 'synthetic-original-thread' }
  const pending = { type: 'terminal' as const, id: 'tab', title: 'Synthetic', isActive: true,
    parentTabId: 'tab', leafId: 'leaf', status: 'pending-handle' as const, terminal: null }
  const row = { public_tab_id: 'tab', payload: pending, terminal_handle: 'term_durable', kind: 'terminal' } as unknown as CatalogTab
  assert.deepEqual({ ...parseCatalogTab({ ...row, terminal_native_chat_session: identity }) },
    { ...pending, status: 'ready', terminal: 'term_durable', nativeChatSession: identity })
  assert.deepEqual({ ...parseCatalogTab(row) }, pending)
  assert.throws(() => parseCatalogTab({ ...row, terminal_handle: null, terminal_native_chat_session: identity } as never), /CATALOG_NATIVE_SESSION_REFERENCE/)
})

test('an Agent tab is addressed by its durable handle before its first READY; other tabs are unchanged', () => {
  const pending = { type: 'terminal' as const, id: 'tab', title: 'Agent', isActive: true, parentTabId: 'tab', leafId: 'leaf',
    status: 'pending-handle' as const, terminal: null, launchAgent: 'claude' }
  const row = { public_tab_id: 'tab', payload: pending, terminal_handle: 'term_durable', kind: 'terminal' } as unknown as CatalogTab
  assert.deepEqual({ ...parseCatalogTab(row) }, { ...pending, status: 'ready', terminal: 'term_durable' })
  const { launchAgent: _agent, ...shell } = pending
  assert.deepEqual({ ...parseCatalogTab({ ...row, payload: shell } as never) }, shell)
})

