import assert from 'node:assert/strict'
import test from 'node:test'
import { captureInitialCodexNativePolicy } from './initial-codex-native-policy.ts'
import { captureInitialProviderPaths } from './initial-provider-paths.ts'

test('cold preserves original native policy and maps only the declared new Folder server paths', () => {
  const defaults = captureInitialCodexNativePolicy({})
  assert.ok(defaults.args.includes('--dangerously-bypass-approvals-and-sandbox'))
  assert.deepEqual(defaults.options, {})
  const settings = { agentDefaultArgs: { codex: '--profile review --effort high --model explicit-model' },
    agentDefaultEnv: { codex: { CUSTOM: 'retained' } },
    nativeChatSessionOptions: { codex: { model: 'selected-model', valuesByModel: { 'selected-model': { effort: 'medium' } } } } }
  const configured = captureInitialCodexNativePolicy(settings)
  assert.deepEqual(configured.args, ['--profile', 'review', '-c', 'model_reasoning_effort=high', '--model', 'explicit-model'])
  assert.deepEqual(configured.options, { model: 'selected-model', effort: 'medium' })
  assert.deepEqual(configured.env, { CUSTOM: 'retained' })
  settings.agentDefaultArgs.codex = ''
  assert.equal(configured.args[0], '--profile')
  assert.deepEqual(captureInitialCodexNativePolicy({ agentDefaultArgs: { codex: '' } }).args, [])
  const agentId = '1e647ae5-3577-461f-be7a-2d435107644a', workspaceId = '7bc0d65f-7ce8-49fc-82c8-80aff18a574f'
  const root = '/workspace/backend/first-cold-fixture', canonicalDirectory = '/orca-1012-dev-v1/157e4c33-9fd3-4514-8244-2d92c5339cd3'
  const input = { agentId, workspaceId, kind: 'REPO_FOLDER', repositoryKind: 'folder', reservedPath: `${root}/checkout`, canonicalDirectory,
    launchRequest: { server: { agentHomePath: `${root}/home/${agentId}`, storagePathMapping: { localDirectory: root, canonicalDirectory } } } }
  const declaration = { kind: 'FRESH_EMPTY_FOLDER' as const, workspaceId, canonicalDirectory,
    checkout: '/agent/checkout' as const, sourceCheckout: `${root}/checkout` }
  const paths = captureInitialProviderPaths(input, declaration)
  assert.equal(paths.home, `/agent/home/${agentId}`)
  assert.equal(paths.sourceHome, `${root}/home/${agentId}`)
  assert.equal(paths.checkout, '/agent/checkout')
  assert.equal(paths.sourceCheckout, declaration.sourceCheckout)
  assert.throws(() => captureInitialProviderPaths(input, { ...declaration, sourceCheckout: '/different/checkout' }), /INITIAL_PROVIDER_CATALOG_PATHS/)
  assert.throws(() => captureInitialProviderPaths({ ...input, reservedPath: `${root}/../checkout` }, declaration), /INITIAL_PROVIDER_CATALOG_PATHS/)
})
