import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { eraseRpcMethods } from '../../runtime/rpc/core.ts'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher.ts'
import { REPO_METHODS } from '../../runtime/rpc/methods/repo.ts'
import { WORKTREE_METHODS } from '../../runtime/rpc/methods/worktree.ts'
import { SESSION_TAB_METHODS } from '../../runtime/rpc/methods/session-tabs.ts'
import { CLIENT_UI_METHODS } from '../../runtime/rpc/methods/client-ui.ts'
import { TERMINAL_METHODS } from '../../runtime/rpc/methods/terminal.ts'
import { DurableCatalogReadAdapter } from './public.ts'
import { CATALOG_PUBLIC_METADATA_METHODS } from './metadata.ts'
import { fixtureConfig, fixtureRuntime, fixtureContext } from './fixture-support.mts'

// Written only. First execution requires a separate Root allocation.
if (process.env.ORCA_P116_METADATA_APPROVED !== 'root-source-reviewed') { throw new Error('Root metadata source review required') }
const original = eraseRpcMethods([...REPO_METHODS, ...WORKTREE_METHODS, ...SESSION_TAB_METHODS, ...CLIENT_UI_METHODS, ...TERMINAL_METHODS])

await test('six metadata bindings preserve incumbent declarations; lifecycle remains explicitly disconnected', async () => {
  let checkouts = 0
  const borrowed = { connect: () => { checkouts++; throw new Error('Unexpected checkout') } } as unknown as Pool
  const { runtime, unexpected } = fixtureRuntime(), adapter = new DurableCatalogReadAdapter(fixtureConfig(borrowed))
  try {
    const bound = adapter.bind(original)
    assert.equal(bound.length, original.length)
    for (const name of CATALOG_PUBLIC_METADATA_METHODS) {
      const old = original.find(method => method.name === name)!, next = bound.find(method => method.name === name)!
      assert.ok(old && next); assert.notEqual(next.handler, old.handler)
      const { handler: _old, ...oldDeclaration } = old
      const { handler: _next, ...nextDeclaration } = next
      assert.deepEqual(nextDeclaration, oldDeclaration)
    }
    const dispatcher = new RpcDispatcher({ runtime, methods: bound })
    for (const [method, params] of [
      ['worktree.sleep', { worktree: 'synthetic' }], ['worktree.rm', { worktree: 'synthetic' }],
      ['session.tabs.createTerminal', { worktree: 'synthetic' }], ['session.tabs.close', { worktree: 'synthetic', tabId: 'synthetic' }],
      ['terminal.close', { terminal: 'synthetic' }]
    ] as const) {
      const response = await dispatcher.dispatch({ id: method, method, params, authToken: '' }, { authenticatedCallerFingerprint: 'a'.repeat(64) })
      assert.equal(response.ok, false)
      if (!response.ok) { assert.match(response.error.message, /CATALOG_METHOD_NOT_CONNECTED/) }
    }
    assert.equal(checkouts, 0); assert.deepEqual(unexpected, [])
    // No adapter is installed in the unset startup path: these original objects
    // and handlers remain available unchanged to its incumbent dispatcher.
    assert.equal(original.find(method => method.name === 'terminal.read'), bound.find(method => method.name === 'terminal.read'))
  } finally { adapter.dispose() }
})

await test('missing or forged transport caller and disposed metadata are rejected before Pool access', async () => {
  let checkouts = 0
  const borrowed = { connect: () => { checkouts++; throw new Error('Unexpected checkout') } } as unknown as Pool
  const { runtime, cleanups, unexpected } = fixtureRuntime(), adapter = new DurableCatalogReadAdapter(fixtureConfig(borrowed))
  try {
    for (const fingerprint of [undefined, 'forged-caller']) {
      await assert.rejects(adapter.mutate('ui.set', { sidebarWidth: 300, clientId: 'a'.repeat(64) },
        fixtureContext(runtime, { authenticatedCallerFingerprint: fingerprint })),
      (error: unknown) => error instanceof Error && error.message === 'CATALOG_AUTHENTICATED_CALLER_REQUIRED')
    }
    adapter.dispose()
    for (const method of CATALOG_PUBLIC_METADATA_METHODS) {
      await assert.rejects(adapter.mutate(method, {}, fixtureContext(runtime)),
        (error: unknown) => error instanceof Error && error.message === 'CATALOG_ADAPTER_DISPOSED')
    }
    assert.equal(checkouts, 0); assert.equal(cleanups.size, 0); assert.deepEqual(unexpected, [])
  } finally { adapter.dispose() }
})
