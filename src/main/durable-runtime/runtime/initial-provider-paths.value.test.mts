import assert from 'node:assert/strict'
import test from 'node:test'
import { captureInitialProviderPaths } from './initial-provider-paths.ts'
import { captureReleaseGateInput } from './release-gate-input.ts'

test('first cold uses the stored Agent HOME and preserves exclusive NEW/manifest inputs', () => {
  const agentId = '0ea030c4-f7d8-41e3-a5af-9ef10be715cc'
  const workspaceId = '446b8348-7fd2-4b4c-8174-af4dc41c4296'
  const canonicalDirectory = '/orca-1012-dev-v1/792206cf-ff1b-4942-ae43-9074689971c6'
  const original = { workspaceId, agentId, kind: 'REPO_FOLDER', repositoryKind: 'folder', reservedPath: '/agent/checkout',
    canonicalDirectory, launchRequest: { server: { agentHomePath: `/agent/home/${agentId}`,
      storagePathMapping: { localDirectory: '/agent', canonicalDirectory } } } }
  const declaration = { kind: 'FRESH_EMPTY_FOLDER' as const, workspaceId, canonicalDirectory, checkout: '/agent/checkout' as const }
  const paths = captureInitialProviderPaths(original, declaration)
  assert.equal(paths.home, `/agent/home/${agentId}`)
  assert.equal(paths.checkoutPreparation, 'FRESH_EMPTY_FOLDER')
  assert.ok(Object.isFrozen(paths))
  original.launchRequest.server.agentHomePath = '/agent/home'
  assert.equal(paths.home, `/agent/home/${agentId}`)
  assert.throws(() => captureInitialProviderPaths(original, declaration), /INITIAL_PROVIDER_CATALOG_PATHS/)
  original.launchRequest.server.agentHomePath = paths.home
  assert.throws(() => captureInitialProviderPaths({ ...original, kind: 'GIT', repositoryKind: 'git' }, declaration), /INITIAL_PROVIDER_CATALOG_PATHS/)
  assert.throws(() => captureInitialProviderPaths({ ...original, repositoryKind: 'git' }, declaration), /INITIAL_PROVIDER_CATALOG_PATHS/)
  assert.throws(() => captureInitialProviderPaths({ ...original, canonicalDirectory: '/old-binding' }, declaration), /INITIAL_PROVIDER_CATALOG_PATHS/)
  assert.throws(() => captureInitialProviderPaths({ ...original, reservedPath: '/agent/checkout/../shared' }, declaration), /INITIAL_PROVIDER_CATALOG_PATHS/)
  assert.throws(() => captureInitialProviderPaths(original, { ...declaration, workspaceId: agentId }), /INITIAL_PROVIDER_CATALOG_PATHS/)
  assert.throws(() => captureInitialProviderPaths(original, undefined!), /INITIAL_PROVIDER_CATALOG_PATHS/)
  const attemptId = '59ce8600-d332-494a-81e5-1d0e436eeff3', planDigest = 'a'.repeat(64)
  const first = captureReleaseGateInput({ attemptId, coldStart: { kind: 'INITIAL_NEW', planDigest } })
  assert.deepEqual(first, { attemptId, coldStart: { kind: 'INITIAL_NEW', planDigest } })
  assert.deepEqual(captureReleaseGateInput({ attemptId, manifestDecisionRevision: '8' }), { attemptId, manifestDecisionRevision: '8' })
  assert.throws(() => captureReleaseGateInput({ ...first, manifestDecisionRevision: '8' }), /RELEASE_GATE_INPUT/)
  assert.throws(() => captureReleaseGateInput({ attemptId, coldStart: { kind: 'RESUME', planDigest } }), /RELEASE_GATE_INPUT/)
  assert.throws(() => captureReleaseGateInput({ attemptId, coldStart: { kind: 'INITIAL_NEW', planDigest: 'invalid' } }), /RELEASE_GATE_INPUT/)
})
