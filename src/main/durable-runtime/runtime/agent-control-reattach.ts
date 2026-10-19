import { TextDecoder } from 'node:util'
import WebSocket from 'ws'
import type { ClientOptions } from 'ws'
import type { ManagedLeafSocket } from '../storage/managed-leaf-collector-types.ts'
import { agentCodexBootstrap } from './agent-control-bootstrap.ts'
import { bearerValid } from './kubernetes-pod-auth-projection.ts'

const fail = (): Error => new Error('AGENT_CODEX_CONTROL_UNCONFIRMED')
export type AttachOutcome = 'ATTACHED' | 'RETRY' | 'FINAL'

export type AgentControlExecTarget = Readonly<{
  origin: URL; namespace: string; podName: string; container: string; bootstrapSha256: string; ca: Buffer; timeoutMs: number
}>
/** One exec connection running the fixed bootstrap. Each connection is
 * disposable: the Pod-local host keeps the control and provider alive. */
export function openAgentControlExec(target: AgentControlExecTarget, bearer: string): ManagedLeafSocket {
  const url = new URL(`/api/v1/namespaces/${encodeURIComponent(target.namespace)}/pods/${encodeURIComponent(target.podName)}/exec`, target.origin)
  url.protocol = 'wss:'
  for (const [key, value] of Object.entries({ container: target.container, stdin: 'true', stdout: 'true', stderr: 'true', tty: 'false' })) {
    url.searchParams.set(key, value)
  }
  for (const arg of ['/usr/local/bin/node', '-e', agentCodexBootstrap, target.bootstrapSha256]) { url.searchParams.append('command', arg) }
  return new WebSocket(url, 'v5.channel.k8s.io', { ca: Buffer.from(target.ca), rejectUnauthorized: true,
    agent: false as unknown as ClientOptions['agent'], followRedirects: false, perMessageDeflate: false,
    handshakeTimeout: target.timeoutMs, headers: { Authorization: `Bearer ${bearer}` } })
}

/** Demultiplexes one exec connection's v5 channels. stdout carries JSON lines;
 * any stderr text or malformed framing is a protocol failure (thrown). */
export function createExecChannelDecoder(line: (text: string) => void) {
  const streams = new Map([1, 2, 3].map(id => [id, { decoder: new TextDecoder('utf-8', { fatal: true }), closed: false }]))
  let buffer = '', status = ''
  return {
    message(raw: unknown, binary: boolean): void {
      if (!binary || !(raw instanceof Uint8Array) || !raw.length) { throw fail() }
      if (raw[0] === 255) {
        const stream = streams.get(raw[1])
        if (raw.length !== 2 || !stream || stream.closed) { throw fail() }
        stream.decoder.decode(); stream.closed = true; return
      }
      const stream = streams.get(raw[0])
      if (!stream || stream.closed) { throw fail() }
      const text = stream.decoder.decode(raw.subarray(1), { stream: true })
      if (raw[0] === 2 && text) { throw fail() }
      if (raw[0] === 3) { status += text; if (status.length > 65536) { throw fail() }; return }
      if (raw[0] !== 1) { return }
      buffer += text
      if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { throw fail() }
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const next = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        line(next)
      }
    },
    /** Exec exited Success with no partial stdout line left. */
    succeeded(): boolean {
      try { return !buffer && JSON.parse(status).status === 'Success' } catch { return false }
    },
  }
}

export type AttachedExpectation = Readonly<{
  controlId: string; pid: number; startTicks: string; device: string; inode: string; protectedRoot: string
  /** The nonce this owner sent on INITIALIZE; null when adopting a control another owner created. */
  allowGap?: boolean
  bindChallenge: string | null
}>
export type AttachedCheck = Readonly<{ outcome: 'FINAL' } | { outcome: 'RETRY' } | { outcome: 'VERIFY'; podBearer: string; nextRequestId: number | null; gap: {from:number;to:number}|null }>
/** First frame of a re-attach. The host must answer for the very same control
 * process and protected root this owner authenticated originally. A refusal
 * from the same-Pod host (gone, newer term, other control) is final. */
export function checkAttached(record: Readonly<Record<string, unknown>>, expected: AttachedExpectation): AttachedCheck {
  if (record.event === 'HOST_REJECTED') { return { outcome: 'FINAL' } }
  const rawGap=record.gap
  const gap=rawGap && typeof rawGap==='object' && Number.isSafeInteger(Reflect.get(rawGap,'from')) && Number.isSafeInteger(Reflect.get(rawGap,'to')) && Reflect.get(rawGap,'from')>0 && Reflect.get(rawGap,'to')>=Reflect.get(rawGap,'from')
    ? {from:Number(Reflect.get(rawGap,'from')),to:Number(Reflect.get(rawGap,'to'))}:null
  const hello = record.hello, root = hello && typeof hello === 'object' ? Reflect.get(hello, 'root') : null
  if (record.event !== 'ATTACHED' || record.controlId !== expected.controlId || record.gap !== null && (!expected.allowGap || !gap) ||
      !hello || typeof hello !== 'object' || Reflect.get(hello, 'controlId') !== expected.controlId ||
      Reflect.get(hello, 'pid') !== expected.pid || Reflect.get(hello, 'startTicks') !== expected.startTicks ||
      expected.bindChallenge !== null && Reflect.get(hello, 'bindChallenge') !== expected.bindChallenge || !root || typeof root !== 'object' ||
      Reflect.get(root, 'path') !== expected.protectedRoot || String(Reflect.get(root, 'device')) !== expected.device ||
      String(Reflect.get(root, 'inode')) !== expected.inode) { return { outcome: 'FINAL' } }
  const podBearer = Reflect.get(hello, 'podBearer')
  if (!bearerValid(podBearer)) { return { outcome: 'RETRY' } }
  const next = record.nextRequestId
  return { outcome: 'VERIFY', podBearer, nextRequestId: Number.isSafeInteger(next) ? Number(next) : null, gap }
}

/** Bounded re-attach with backoff. Returns true once attached. */
export async function reattachWithin(budgetMs: number, stopped: () => boolean,
  attempt: (deadline: number) => Promise<AttachOutcome>): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  let delay = 200
  while (!stopped() && Date.now() < deadline) {
    const outcome = await attempt(deadline)
    if (outcome === 'ATTACHED') { return true }
    if (outcome === 'FINAL') { return false }
    await new Promise(done => setTimeout(done, Math.min(delay, Math.max(0, deadline - Date.now()))))
    delay = Math.min(delay * 2, 5000)
  }
  return false
}

export type HelloIdentity = Readonly<{ controlId: string; pid: number; startTicks: string; device: string; inode: string; podBearer: string }>
/** The control's first frame on INITIALIZE. Throws unless it names a control
 * holding exactly the policy's protected root and bind challenge. */
export function checkHello(record: Readonly<Record<string, unknown>>,
  policy: Readonly<{ bindChallenge: string; protectedRoot: string }>): HelloIdentity {
  const root = record.root
  if (typeof record.controlId !== 'string' || !/^[0-9a-f-]{36}$/.test(record.controlId) ||
      !Number.isSafeInteger(record.pid) || Number(record.pid) < 1 || typeof record.startTicks !== 'string' ||
      !/^[1-9]\d*$/.test(record.startTicks) || !bearerValid(record.podBearer) || record.bindChallenge !== policy.bindChallenge ||
      !root || typeof root !== 'object' || Reflect.get(root, 'path') !== policy.protectedRoot ||
      !/^\d+$/.test(Reflect.get(root, 'device')) || !/^[1-9]\d*$/.test(Reflect.get(root, 'inode'))) { throw fail() }
  return Object.freeze({ controlId: record.controlId, pid: Number(record.pid), startTicks: record.startTicks,
    device: String(Reflect.get(root, 'device')), inode: String(Reflect.get(root, 'inode')), podBearer: record.podBearer })
}

export type AttachAttemptDependencies = Readonly<{
  timeoutMs: number
  readBearer(signal: AbortSignal): Promise<string>
  /** Publishes the in-flight attempt to the owner; nulls clear it. */
  register(finish: ((outcome: AttachOutcome) => void) | null, firstFrame: ((record: Record<string, unknown>) => Promise<void>) | null): void
  /** Decides the outcome from the first frame, including Pod re-authentication. */
  verify(record: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<AttachOutcome>
  /** Opens a fresh exec connection that sends ATTACH once open. */
  open(bearer: string, unexpected: (statusCode: number) => void): void
  terminate(): void
}>
/** One re-attach attempt over a fresh exec connection, bounded by the deadline. */
export function attemptAttach(deadline: number, deps: AttachAttemptDependencies): Promise<AttachOutcome> {
  return new Promise(done => {
    const attempt = new AbortController()
    const timer = setTimeout(() => attempt.abort(), Math.max(1, Math.min(deps.timeoutMs, deadline - Date.now())))
    let settled = false
    const finish = (outcome: AttachOutcome): void => {
      if (settled) { return }
      settled = true; clearTimeout(timer); deps.register(null, null)
      if (outcome !== 'ATTACHED') { deps.terminate() }
      done(outcome)
    }
    deps.register(finish, null)
    attempt.signal.addEventListener('abort', () => finish('RETRY'), { once: true })
    void (async () => {
      let value = ''
      try { value = await deps.readBearer(attempt.signal) } catch { finish('RETRY'); return }
      if (settled) { return }
      if (!bearerValid(value)) { finish('RETRY'); return }
      deps.register(finish, async record => {
        try { finish(await deps.verify(record, attempt.signal)) } catch { finish('RETRY') }
      })
      deps.open(value, statusCode => finish(statusCode === 404 ? 'FINAL' : 'RETRY'))
      value = ''
    })()
  })
}
