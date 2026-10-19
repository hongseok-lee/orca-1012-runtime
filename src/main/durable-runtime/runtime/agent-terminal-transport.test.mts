import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createAgentControlSession } from './agent-control-session.ts'
import { AGENT_TERMINAL_CAPABILITY } from './agent-terminal-protocol.ts'

test('PTY traffic rejected during detach never enters the reconnect queue', async t => {
  const controlId = randomUUID(), challenge = randomUUID()
  const bearer = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln'
  const hello = { event: 'HELLO', controlId, pid: 25, startTicks: '17216', bindChallenge: challenge,
    root: { path: '/agent', device: '64', inode: '2' }, podBearer: bearer, capabilities: [AGENT_TERMINAL_CAPABILITY] }
  const sent: Record<string, unknown>[] = [], sockets: Socket[] = []
  let sequence = 0, attach!: () => void, sawAttach!: () => void
  const attaching = new Promise<void>(resolve => { sawAttach = resolve })
  class Socket extends EventEmitter {
    protocol = 'v5.channel.k8s.io'
    frame(value: unknown) { this.emit('message', Buffer.concat([Buffer.from([1]), Buffer.from(`${JSON.stringify(value)}\n`)]), true) }
    send(bytes: Buffer, done: () => void) {
      const request = JSON.parse(bytes.subarray(1).toString('utf8')) as Record<string, unknown>
      sent.push(request); done()
      if (request.method === 'INITIALIZE') { queueMicrotask(() => this.frame({ ...hello, hostSeq: ++sequence })); return }
      if (request.method === 'ATTACH') {
        attach = () => this.frame({ event: 'ATTACHED', controlId, term: 3, nextRequestId: 9, gap: null, hello })
        sawAttach(); return
      }
      queueMicrotask(() => this.frame({ id: request.id, controlId, hostSeq: ++sequence,
        result: request.method === 'CLOSE' ? { stopped: false } : { received: true } }))
    }
    terminate() { this.emit('close', 1006) }
  }
  // Synthetic socket/authentication only. The production request queue,
  // exec decoder, HELLO/ATTACH validation and reconnect state are exercised.
  const session = createAgentControlSession({ config: {
    timeoutMs: 1000, expected: { podName: 'owned', podUid: 'owned' }, policy: { protectedRoot: '/agent', bindChallenge: challenge }
  }, reviewer: async () => bearer, authenticate: async () => ({ pod: { uid: 'owned' } }),
  controllerTerm: () => 3, reconnectBudgetMs: 2000 } as never, () => {
    const socket = new Socket(); sockets.push(socket)
    queueMicrotask(() => socket.emit('open'))
    return socket as never
  })
  const control = await session.initialize(bearer, new AbortController().signal)
  t.after(async () => { await control.close(); for (const socket of sockets) { socket.terminate() } })
  assert.equal(control.terminal.supported(), true)
  await control.terminal.request('PTY_STATUS')
  sockets[0].terminate()
  await attaching
  await assert.rejects(control.terminal.request('PTY_WRITE', { incarnationId: randomUUID(), requestId: 'must-not-queue', bytes: 'eA==' }), /TRANSPORT_UNAVAILABLE/)
  await assert.rejects(control.terminal.request('PTY_RESIZE', { incarnationId: randomUUID(), cols: 80, rows: 24 }), /TRANSPORT_UNAVAILABLE/)
  attach()
  await new Promise(resolve => setImmediate(resolve))
  await control.terminal.request('PTY_STATUS')
  assert.equal(sent.filter(request => request.method === 'PTY_WRITE').length, 0)
  assert.equal(sent.filter(request => request.method === 'PTY_RESIZE').length, 0)
  assert.equal(sent.filter(request => request.method === 'PTY_STATUS').length, 2)
  assert.equal(sockets.length, 2)
})
