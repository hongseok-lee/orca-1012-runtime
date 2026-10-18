import test from 'node:test'
import assert from 'node:assert/strict'
import { attemptAttach, checkAttached, checkHello, reattachWithin } from './agent-control-reattach.ts'
import type { AttachOutcome } from './agent-control-reattach.ts'

const token = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln'
const policy = { bindChallenge: '11111111-2222-3333-4444-555555555555', protectedRoot: '/agent' }
const hello = { event: 'HELLO', controlId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', pid: 25, startTicks: '17216',
  bindChallenge: policy.bindChallenge, root: { path: '/agent', device: '64', inode: '2' }, podBearer: token }
const expected = { controlId: hello.controlId, pid: 25, startTicks: '17216', device: '64', inode: '2', ...policy }
const attached = (patch: Record<string, unknown> = {}, helloPatch: Record<string, unknown> = {}) => ({
  event: 'ATTACHED', controlId: hello.controlId, term: 3, nextRequestId: 9, gap: null,
  hello: { ...hello, ...helloPatch }, ...patch })

test('HELLO must name the protected root and bind challenge of the policy', () => {
  assert.deepEqual(checkHello(hello, policy), { controlId: hello.controlId, pid: 25, startTicks: '17216', device: '64', inode: '2', podBearer: token })
  assert.throws(() => checkHello({ ...hello, root: { ...hello.root, path: '/shared' } }, policy))
  assert.throws(() => checkHello({ ...hello, bindChallenge: 'other' }, policy))
  assert.throws(() => checkHello({ ...hello, podBearer: '' }, policy))
})

test('ATTACHED is accepted only for the same control process and protected root', () => {
  assert.deepEqual(checkAttached(attached(), expected), { outcome: 'VERIFY', podBearer: token, nextRequestId: 9 })
  // A different process at the same controlId, or a different root, is never adopted.
  assert.equal(checkAttached(attached({}, { pid: 26 }), expected).outcome, 'FINAL')
  assert.equal(checkAttached(attached({}, { startTicks: '1' }), expected).outcome, 'FINAL')
  assert.equal(checkAttached(attached({}, { root: { path: '/agent', device: '64', inode: '3' } }), expected).outcome, 'FINAL')
  assert.equal(checkAttached(attached({ controlId: 'x' }), expected).outcome, 'FINAL')
})

test('an adopting owner without the INITIALIZE nonce still requires the same process and root', () => {
  const adopting = { ...expected, bindChallenge: null }
  assert.equal(checkAttached(attached({}, { bindChallenge: 'other-owner-nonce' }), adopting).outcome, 'VERIFY')
  assert.equal(checkAttached(attached({}, { pid: 26 }), adopting).outcome, 'FINAL')
  assert.equal(checkAttached(attached({}, { root: { path: '/agent', device: '64', inode: '3' } }), adopting).outcome, 'FINAL')
})

test('a replay gap and every same-Pod host refusal are final; a missing fresh token is retried', () => {
  assert.equal(checkAttached(attached({ gap: { from: 3, to: 9 } }), expected).outcome, 'FINAL')
  for (const reason of ['NO_HOST', 'NO_CONTROL', 'STALE_TERM', 'CONTROL_MISMATCH']) {
    assert.equal(checkAttached({ event: 'HOST_REJECTED', reason }, expected).outcome, 'FINAL', reason)
  }
  assert.equal(checkAttached(attached({}, { podBearer: '' }), expected).outcome, 'RETRY')
})

test('reattachWithin retries RETRY with backoff, stops on FINAL, and respects the budget', async () => {
  const seen: AttachOutcome[] = ['RETRY', 'RETRY', 'ATTACHED']
  let calls = 0
  assert.equal(await reattachWithin(5000, () => false, async () => seen[calls++]), true)
  assert.equal(calls, 3)
  calls = 0
  assert.equal(await reattachWithin(5000, () => false, async () => { calls++; return 'FINAL' }), false)
  assert.equal(calls, 1)
  const started = Date.now()
  assert.equal(await reattachWithin(300, () => false, async () => 'RETRY'), false)
  assert.ok(Date.now() - started < 1500)
  assert.equal(await reattachWithin(5000, () => true, async () => 'ATTACHED'), false, 'a lost owner does not re-attach')
})

test('attemptAttach maps the exec answer: 404 is final, other HTTP failures retry, the first frame decides', async () => {
  function run(behaviour: (open: { firstFrame: ((r: Record<string, unknown>) => Promise<void>) | null; unexpected: (s: number) => void }) => void,
    verify: AttachOutcome = 'ATTACHED') {
    let firstFrame: ((r: Record<string, unknown>) => Promise<void>) | null = null, terminated = 0
    const outcome = attemptAttach(Date.now() + 2000, {
      timeoutMs: 1000, readBearer: async () => token, verify: async () => verify, terminate: () => { terminated++ },
      register(_finish, frame) { firstFrame = frame },
      open(_bearer, unexpected) { setTimeout(() => behaviour({ firstFrame, unexpected }), 5) },
    })
    return outcome.then(value => ({ value, terminated }))
  }
  assert.deepEqual(await run(({ unexpected }) => unexpected(404)), { value: 'FINAL', terminated: 1 })
  assert.deepEqual(await run(({ unexpected }) => unexpected(503)), { value: 'RETRY', terminated: 1 })
  assert.deepEqual(await run(({ firstFrame }) => { void firstFrame?.({ event: 'ATTACHED' }) }), { value: 'ATTACHED', terminated: 0 })
  assert.deepEqual(await run(({ firstFrame }) => { void firstFrame?.({}) }, 'FINAL'), { value: 'FINAL', terminated: 1 })
})
