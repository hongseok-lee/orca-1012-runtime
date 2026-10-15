import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { inspect } from 'node:util'
import { test } from 'node:test'
import { createOpsBrowserSessionAuthority, OpsBrowserSessionAuthError } from './browser-session-auth.ts'

// Synthetic trusted-caller fingerprint only: no real pairing credential, RPC
// verification, Catalog reservation, HTTP API, PG or Browser is exercised here.
await test('Ops Browser page session authority: first value callback 1', async () => {
  const workspace = '10101010-1111-2222-3333-444444444444'
  const otherWorkspace = '20202020-1111-2222-3333-444444444444'
  const syntheticPairing = 'synthetic-pairing-fixture-not-a-real-credential'
  const fingerprint = createHash('sha256').update(syntheticPairing).digest('hex')
  const otherFingerprint = 'b'.repeat(64)
  const scope = { datasetName: 'fixture-dataset', namespaceId: 'fixture-namespace',
    workspaceIds: [workspace, workspace] }
  const owner = createOpsBrowserSessionAuthority(scope)
  const { issuePageSession, findPageSession, authenticateBearer, close } = owner
  // Mutate the original server scope before even the first issue.
  scope.datasetName = 'mutated-dataset'
  scope.namespaceId = 'mutated-namespace'
  scope.workspaceIds.splice(0, scope.workspaceIds.length, otherWorkspace)
  const request = { authenticatedCallerFingerprint: fingerprint,
    browserPageId: 'browser:fixture-page', worktreePublicId: workspace }
  const first = issuePageSession.call({ receiver: 'unrelated' }, request)
  const bearer = first.readBearer()
  const firstActor = authenticateBearer(bearer)
  assert.ok(firstActor)
  assert.deepEqual(firstActor, { principalId: `pairing-sha256:${fingerprint}`,
    authorizationRef: `ops-pairing-sha256:${fingerprint}`, datasetName: 'fixture-dataset',
    namespaceId: 'fixture-namespace', workspaceIds: [workspace] })
  assert.equal(/^orca-ops-page-v1\.[A-Za-z0-9_-]{43}$/.test(bearer), true)
  assert.equal(Buffer.from(bearer.slice('orca-ops-page-v1.'.length), 'base64url').length, 32)
  assert.equal(bearer === syntheticPairing || bearer.includes(syntheticPairing) || bearer.includes(fingerprint), false)
  assert.ok(Object.isFrozen(owner) && Object.isFrozen(first) && Object.isFrozen(firstActor) && Object.isFrozen(firstActor.workspaceIds))
  assert.equal(Reflect.set(firstActor, 'datasetName', 'forged'), false)
  assert.equal(Reflect.set(firstActor.workspaceIds, '0', otherWorkspace), false)

  // The issued handle also captures the original caller DTO synchronously.
  request.authenticatedCallerFingerprint = otherFingerprint
  request.browserPageId = 'mutated-page'
  request.worktreePublicId = otherWorkspace
  assert.equal(first.authenticatedCallerFingerprint, fingerprint)
  assert.equal(first.browserPageId, 'browser:fixture-page')
  assert.equal(first.worktreePublicId, workspace)
  assert.deepEqual(authenticateBearer(bearer), firstActor)
  const second = issuePageSession({ authenticatedCallerFingerprint: fingerprint,
    browserPageId: 'browser:second-page', worktreePublicId: workspace })
  const secondBearer = second.readBearer()
  assert.equal(bearer === secondBearer, false)
  assert.deepEqual(authenticateBearer(secondBearer), firstActor)
  const repeated = issuePageSession({ authenticatedCallerFingerprint: fingerprint,
    browserPageId: first.browserPageId, worktreePublicId: workspace })
  assert.equal(repeated, first)
  assert.equal(repeated.readBearer() === bearer, true)
  const findKey = { browserPageId: first.browserPageId, worktreePublicId: workspace }
  const found = Reflect.apply(findPageSession, null, [findKey])
  findKey.browserPageId = 'later-mutation'
  assert.equal(found, first)
  assert.equal(findPageSession({ browserPageId: first.browserPageId, worktreePublicId: otherWorkspace }), null)
  assert.equal(findPageSession({ browserPageId: 'unknown-page', worktreePublicId: workspace }), null)

  function fails(body: () => unknown, code: string): OpsBrowserSessionAuthError {
    let caught: unknown
    try { body() } catch (error) { caught = error }
    assert.ok(caught instanceof OpsBrowserSessionAuthError)
    assert.equal(caught.code, code)
    for (const secret of [bearer, secondBearer, syntheticPairing, 'synthetic-sensitive-cause']) {
      assert.equal(caught.message.includes(secret), false)
      assert.equal(JSON.stringify(caught).includes(secret), false)
      assert.equal(inspect(caught).includes(secret), false)
    }
    assert.equal(Object.hasOwn(caught, 'cause'), false)
    return caught
  }
  for (const change of [{ worktreePublicId: otherWorkspace }, { authenticatedCallerFingerprint: otherFingerprint }]) {
    fails(() => issuePageSession({ authenticatedCallerFingerprint: fingerprint,
      browserPageId: first.browserPageId, worktreePublicId: workspace, ...change }), 'OPS_BROWSER_SESSION_CONFLICT')
    assert.equal(authenticateBearer(bearer), firstActor)
  }
  const third = issuePageSession({ authenticatedCallerFingerprint: otherFingerprint,
    browserPageId: 'browser:other-principal', worktreePublicId: otherWorkspace })
  const thirdBearer = third.readBearer()
  assert.equal(authenticateBearer(thirdBearer)?.principalId, `pairing-sha256:${otherFingerprint}`)
  assert.deepEqual(authenticateBearer(thirdBearer)?.workspaceIds, [workspace])

  for (const unknown of ['', syntheticPairing, fingerprint, `Bearer ${bearer}`, `${bearer}x`,
    `${bearer.slice(0, -1)}!`, `orca-ops-page-v1.${'z'.repeat(43)}`, null, {}, 17]) {
    assert.equal(Reflect.apply(authenticateBearer, undefined, [unknown]), null)
  }
  for (const invalid of [{ ...request, authenticatedCallerFingerprint: 'A'.repeat(64) },
    { ...request, browserPageId: ' trailing ' }, { ...request, worktreePublicId: '' },
    { ...request, browserPageId: 'control\u001fpage' }, null, {}, []]) {
    fails(() => Reflect.apply(issuePageSession, undefined, [invalid]), 'OPS_BROWSER_SESSION_INPUT_INVALID')
  }
  fails(() => Reflect.apply(issuePageSession, undefined, [{
    get authenticatedCallerFingerprint() { throw new Error('synthetic-sensitive-cause') },
    browserPageId: 'cause-page', worktreePublicId: workspace
  }]), 'OPS_BROWSER_SESSION_INPUT_INVALID')
  fails(() => createOpsBrowserSessionAuthority({ ...scope, workspaceIds: ['not-a-uuid'] }), 'OPS_BROWSER_SESSION_SCOPE_INVALID')
  fails(() => Reflect.apply(createOpsBrowserSessionAuthority, undefined, [null]), 'OPS_BROWSER_SESSION_SCOPE_INVALID')
  fails(() => findPageSession({ browserPageId: 'control\u007fpage', worktreePublicId: workspace }), 'OPS_BROWSER_SESSION_INPUT_INVALID')

  for (const value of [first, second, third, owner]) {
    const json = JSON.stringify(value), displayed = inspect(value)
    for (const secret of [bearer, secondBearer, thirdBearer, syntheticPairing]) {
      assert.equal(json.includes(secret), false)
      assert.equal(displayed.includes(secret), false)
    }
    for (const property of ['token', 'bearer', 'bearerDigest', 'actor', 'sessions', 'toJSON']) {
      assert.equal(Object.hasOwn(value, property), false)
    }
  }
  assert.deepEqual(Object.keys(first).sort(), ['authenticatedCallerFingerprint','browserPageId','dispose','readBearer','worktreePublicId'].sort())
  const disposeFirst = first.dispose, readFirst = first.readBearer
  disposeFirst.call(third)
  assert.equal(authenticateBearer(bearer), null)
  assert.equal(authenticateBearer(secondBearer), firstActor)
  fails(readFirst, 'OPS_BROWSER_SESSION_CLOSED')
  assert.equal(findPageSession({ browserPageId: first.browserPageId, worktreePublicId: workspace }), null)
  const reissued = issuePageSession({ authenticatedCallerFingerprint: fingerprint,
    browserPageId: first.browserPageId, worktreePublicId: workspace })
  const reissuedBearer = reissued.readBearer()
  assert.equal(reissued === first, false)
  assert.equal(reissuedBearer === bearer, false)
  disposeFirst()
  assert.equal(findPageSession({ browserPageId: first.browserPageId, worktreePublicId: workspace }), reissued)
  assert.equal(authenticateBearer(reissuedBearer)?.principalId, firstActor.principalId)
  assert.equal(authenticateBearer(bearer), null)
  close.call({ receiver: 'unrelated' })
  close()
  for (const token of [secondBearer, thirdBearer, reissuedBearer]) {
    assert.equal(authenticateBearer(token), null)
  }
  for (const handle of [first, second, third, reissued]) {
    fails(handle.readBearer, 'OPS_BROWSER_SESSION_CLOSED')
    handle.dispose()
  }
  assert.equal(findPageSession({ browserPageId: first.browserPageId, worktreePublicId: workspace }), null)
  fails(() => issuePageSession({ authenticatedCallerFingerprint: fingerprint,
    browserPageId: first.browserPageId, worktreePublicId: workspace }), 'OPS_BROWSER_SESSION_CLOSED')
  console.log(JSON.stringify({ phase: 'BROWSER_PAGE_SESSION_VALUE_COMPLETE', callbackCount: 1,
    cases: ['independent-256bit-opaque-bearers','pairing-fingerprint-and-captured-scope-only',
      'caller-scope-mutation-and-receiver-isolation','idempotence-and-page-worktree-principal-conflicts',
      'forged-unknown-bearer-and-invalid-input-refusal','own-dispose-reissue-stale-dispose-owner-close',
      'JSON-inspection-error-no-raw-secret'], authenticationIssuerVerified: false,
    PG: false, liveAPI: false, browser: false, reportCapture: false }))
})
