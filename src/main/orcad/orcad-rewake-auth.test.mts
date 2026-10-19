import test from 'node:test'
import assert from 'node:assert/strict'
import { captureRewakeCodexAuthSources, rewakeNativeFiles } from './orcad-rewake-auth.ts'

test('trusted fresh auth selection is exact-Agent Codex only and leaves other defaults intact', () => {
  const agent = 'f15720bc-6f71-4d7f-a872-f91ee9087634'
  const source = { agentId: agent, codexAuthFile: '/private/current-managed-home/auth.json' }
  const sources = captureRewakeCodexAuthSources([source])
  const defaults = Object.freeze({ codexAuthFile: '/private/historical/auth.json', nativeSha256: 'unchanged' })
  assert.equal(rewakeNativeFiles('codex', agent, defaults, sources).codexAuthFile, source.codexAuthFile)
  assert.equal(rewakeNativeFiles('codex', 'other-agent', defaults, sources), defaults)
  assert.equal(rewakeNativeFiles('claude', agent, defaults, sources), defaults)
  assert.equal(defaults.codexAuthFile, '/private/historical/auth.json')
  assert.throws(() => captureRewakeCodexAuthSources([source, source]))
  assert.throws(() => captureRewakeCodexAuthSources([{ ...source, codexAuthFile: '/private/../auth.json' }]))
  assert.throws(() => captureRewakeCodexAuthSources([{ ...source, token: 'not-accepted' }]))
})
