import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import type { Readable, Writable } from 'node:stream'
import { runAgentControlBridge, startAgentControlHost } from './agent-control-host.ts'

type Frame = Record<string, unknown>
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

/** Stand-in for the provider control: HELLO on start, echoes requests,
 * `EMIT n` sends n notifications later, `CLOSE` stops. */
function fakeControl(input: Readable, output: Writable) {
  let resolveClosed!: () => void
  const closed = new Promise<void>(resolve => { resolveClosed = resolve })
  const send = (value: Frame) => output.write(`${JSON.stringify(value)}\n`)
  send({ event: 'HELLO', controlId: 'control-1', pid: 7, podBearer: 'first-token' })
  let pending = ''
  input.setEncoding('utf8')
  input.on('data', (text: string) => {
    pending += text
    let newline: number
    while ((newline = pending.indexOf('\n')) >= 0) {
      const request = JSON.parse(pending.slice(0, newline)) as Frame
      pending = pending.slice(newline + 1)
      if (request.method === 'EMIT') {
        const count = Number((request.params as Frame).count), delay = Number((request.params as Frame).delayMs ?? 0)
        send({ id: request.id, controlId: 'control-1', result: { scheduled: count } })
        setTimeout(() => {
          for (let i = 0; i < count; i++) { send({ event: 'NOTIFICATION', controlId: 'control-1', method: 'item', params: { n: i } }) }
        }, delay)
      } else if (request.method === 'CLOSE') {
        send({ id: request.id, controlId: 'control-1', result: { stopped: true } })
        setTimeout(resolveClosed, 10)
      } else {
        send({ id: request.id, controlId: 'control-1', result: { echo: request.method } })
      }
    }
  })
  return { closed }
}

function harness(maxBufferedBytes?: number) {
  const dir = mkdtempSync('/tmp/ach-')
  const socketPath = `${dir}/host.sock`
  let token = 0, creations = 0
  let host: ReturnType<typeof startAgentControlHost> | null = null
  const startHost = () => {
    host = startAgentControlHost({ socketPath, maxBufferedBytes, readPodBearer: () => `fresh-${++token}`,
      createControl: (_init, input, output) => { creations++; return fakeControl(input, output) } })
  }
  function bridge() {
    const input = new PassThrough(), output = new PassThrough()
    const frames: Frame[] = []
    let partial = ''
    output.setEncoding('utf8')
    output.on('data', (text: string) => {
      partial += text
      let newline: number
      while ((newline = partial.indexOf('\n')) >= 0) {
        frames.push(JSON.parse(partial.slice(0, newline)) as Frame)
        partial = partial.slice(newline + 1)
      }
    })
    const done = runAgentControlBridge({ socketPath, input, output, spawnHost: startHost, connectTimeoutMs: 2000 })
    return { input, frames, done, send: (value: Frame) => input.write(`${JSON.stringify(value)}\n`) }
  }
  return { dir, socketPath, bridge, host: () => host, creations: () => creations,
    cleanup: () => { host?.close(); rmSync(dir, { recursive: true, force: true }) } }
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) { if (check()) { return }; await tick(10) }
  assert.fail(`timed out waiting for ${label}`)
}

test('first INITIALIZE starts the host and is backward compatible with the existing frames', async () => {
  const h = harness()
  try {
    const first = h.bridge()
    first.send({ method: 'INITIALIZE', policy: {} })
    await until(() => first.frames.length >= 1, 'HELLO')
    assert.equal(first.frames[0].event, 'HELLO')
    assert.equal(first.frames[0].podBearer, 'first-token', 'the live HELLO keeps the token for the first authentication')
    assert.equal(first.frames[0].hostSeq, 1)
    first.send({ controlId: 'control-1', id: '1', method: 'thread/start', params: {} })
    await until(() => first.frames.length >= 2, 'response')
    assert.deepEqual(first.frames[1].result, { echo: 'thread/start' })
    assert.equal(h.creations(), 1)
  } finally { h.cleanup() }
})

test('a lost connection only detaches; ATTACH replays exactly what was missed, then streams live', async () => {
  const h = harness()
  try {
    const first = h.bridge()
    first.send({ method: 'INITIALIZE', policy: {} })
    await until(() => first.frames.length >= 1, 'HELLO')
    first.send({ controlId: 'control-1', id: '1', method: 'EMIT', params: { count: 3, delayMs: 150 } })
    await until(() => first.frames.length >= 2, 'EMIT ack')
    const lastSeq = Number(first.frames.at(-1)?.hostSeq)
    first.input.end()
    assert.equal(await first.done, 'BRIDGED')
    await until(() => !h.host()?.state().attached, 'detach')
    await tick(300)
    assert.equal(h.host()?.state().bufferedFrames, 5, 'the provider kept producing while nobody was attached')

    const second = h.bridge()
    second.send({ method: 'ATTACH', controlId: 'control-1', term: 0, lastSeq })
    await until(() => second.frames.length >= 4, 'ATTACHED + replay')
    const [attached, ...replay] = second.frames
    assert.equal(attached.event, 'ATTACHED')
    assert.equal(attached.nextRequestId, 2)
    assert.equal(attached.gap, null)
    assert.equal((attached.hello as Frame).podBearer, 'fresh-1', 're-attach carries a freshly read Pod token')
    assert.deepEqual(replay.map(frame => frame.hostSeq), [3, 4, 5])
    assert.deepEqual(replay.map(frame => (frame.params as Frame).n), [0, 1, 2])

    second.send({ controlId: 'control-1', id: '2', method: 'turn/start', params: {} })
    await until(() => second.frames.length >= 5, 'live response after re-attach')
    assert.deepEqual(second.frames[4].result, { echo: 'turn/start' })
    assert.equal(h.creations(), 1, 're-attach never creates a second control')
  } finally { h.cleanup() }
})

test('a newer controller term evicts the current attachment; an older term is refused', async () => {
  const h = harness()
  try {
    const first = h.bridge()
    first.send({ method: 'INITIALIZE', policy: {}, term: 5 })
    await until(() => first.frames.length >= 1, 'HELLO')
    const stale = h.bridge()
    stale.send({ method: 'ATTACH', controlId: 'control-1', term: 4, lastSeq: 1 })
    await until(() => stale.frames.length >= 1, 'stale refusal')
    assert.deepEqual(stale.frames[0], { event: 'HOST_REJECTED', reason: 'STALE_TERM' })
    assert.equal(h.host()?.state().term, 5)

    const newer = h.bridge()
    newer.send({ method: 'ATTACH', controlId: 'control-1', term: 6, lastSeq: 1 })
    await until(() => newer.frames.length >= 1, 'newer ATTACHED')
    assert.equal(newer.frames[0].event, 'ATTACHED')
    await until(() => first.frames.some(frame => frame.event === 'HOST_EVICTED'), 'eviction notice')
    assert.equal(await first.done, 'BRIDGED')
    assert.equal(h.host()?.state().term, 6)
  } finally { h.cleanup() }
})

test('ATTACH with no host answers NO_HOST and never starts one', async () => {
  const h = harness()
  try {
    const orphan = h.bridge()
    orphan.send({ method: 'ATTACH', controlId: 'control-1', term: 0, lastSeq: 0 })
    assert.equal(await orphan.done, 'NO_HOST')
    assert.deepEqual(orphan.frames, [{ event: 'HOST_REJECTED', reason: 'NO_HOST' }])
    assert.equal(h.host(), null)
    assert.equal(existsSync(h.socketPath), false)
  } finally { h.cleanup() }
})

test('a second INITIALIZE and a wrong controlId are refused without touching the control', async () => {
  const h = harness()
  try {
    const first = h.bridge()
    first.send({ method: 'INITIALIZE', policy: {} })
    await until(() => first.frames.length >= 1, 'HELLO')
    const again = h.bridge()
    again.send({ method: 'INITIALIZE', policy: {} })
    await until(() => again.frames.length >= 1, 'refusal')
    assert.deepEqual(again.frames[0], { event: 'HOST_REJECTED', reason: 'CONTROL_EXISTS' })
    const wrong = h.bridge()
    wrong.send({ method: 'ATTACH', controlId: 'someone-else', term: 0, lastSeq: 0 })
    await until(() => wrong.frames.length >= 1, 'mismatch')
    assert.deepEqual(wrong.frames[0], { event: 'HOST_REJECTED', reason: 'CONTROL_MISMATCH' })
    assert.equal(h.creations(), 1)
    assert.equal(h.host()?.state().attached, true, 'the original attachment is unaffected')
  } finally { h.cleanup() }
})

test('an overflowed buffer is reported as a gap instead of silently skipping frames', async () => {
  const h = harness(600)
  try {
    const first = h.bridge()
    first.send({ method: 'INITIALIZE', policy: {} })
    await until(() => first.frames.length >= 1, 'HELLO')
    first.input.end()
    await first.done
    await until(() => !h.host()?.state().attached, 'detach')
    // Requests cannot arrive while detached, so emit through a short attachment first.
    const trigger = h.bridge()
    trigger.send({ method: 'ATTACH', controlId: 'control-1', term: 0, lastSeq: 1 })
    await until(() => trigger.frames.length >= 1, 'ATTACHED')
    trigger.send({ controlId: 'control-1', id: '1', method: 'EMIT', params: { count: 20, delayMs: 100 } })
    await until(() => trigger.frames.length >= 2, 'EMIT ack')
    trigger.input.end()
    await trigger.done
    await tick(250)
    const late = h.bridge()
    late.send({ method: 'ATTACH', controlId: 'control-1', term: 0, lastSeq: 2 })
    await until(() => late.frames.length >= 2, 'ATTACHED with gap')
    const gap = late.frames[0].gap as Frame
    assert.equal(late.frames[0].event, 'ATTACHED')
    assert.equal(gap.from, 3)
    assert.equal(Number(gap.to) + 1, late.frames[1].hostSeq, 'replay resumes right after the reported gap')
  } finally { h.cleanup() }
})

test('hostAck releases delivered frames; the host removes its socket when the control stops', async () => {
  const h = harness()
  try {
    const first = h.bridge()
    first.send({ method: 'INITIALIZE', policy: {} })
    await until(() => first.frames.length >= 1, 'HELLO')
    first.send({ controlId: 'control-1', id: '1', method: 'ping', params: {} })
    await until(() => first.frames.length >= 2, 'response')
    first.send({ hostAck: 2 })
    await until(() => h.host()?.state().bufferedFrames === 0, 'acknowledged frames released')
    first.send({ controlId: 'control-1', id: '2', method: 'CLOSE', params: {} })
    await h.host()?.closed
    assert.equal(existsSync(h.socketPath), false)
    assert.equal(await first.done, 'BRIDGED')
  } finally { h.cleanup() }
})
