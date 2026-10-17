import { TextDecoder } from 'node:util'
import { performance } from 'node:perf_hooks'
import WebSocket from 'ws'
import type { ClientOptions } from 'ws'
import { createManagedLeafCollector } from './managed-leaf-collector.ts'
import { captureManagedLeafConfig, managedLeafUuid } from './managed-leaf-collector-config.ts'
import { projectManagedLeafOutput } from './managed-leaf-collector-output.ts'
import { sameDirectory } from './canonical.ts'
import { managedLeafPinCommand } from './managed-leaf-pin-command.ts'
import type { AuthenticatedManagedLeafObservation, ManagedLeafCollectorConfig,
  ManagedLeafCollectorDependencies, ManagedLeafSocket, ManagedLeafCollectorCode } from './managed-leaf-collector-types.ts'
import { ManagedLeafCollectorError } from './managed-leaf-collector-types.ts'
import { awaitPodAuthValue, defaultPodAuthHttps } from '../runtime/kubernetes-pod-auth-transport.ts'
import { bearerValid } from '../runtime/kubernetes-pod-auth-projection.ts'

export type HeldManagedLeafDirectory = Readonly<{
  observation: AuthenticatedManagedLeafObservation
  holderPid: number
  held(): boolean
  release(): Promise<void>
  physicalPinIssued: false
}>
const issued = new WeakSet<HeldManagedLeafDirectory>()
export function heldManagedLeafDirectoryValid(value: HeldManagedLeafDirectory): boolean {
  return issued.has(value) && value.held()
}
const defaults: ManagedLeafCollectorDependencies = Object.freeze({ https: defaultPodAuthHttps,
  openWebSocket: (url, protocol, options) => new WebSocket(url, protocol, options) })

/** Actual authenticated collection plus a live kernel directory FD. No timer
 * expires a held lifetime. Acquisition timeout only bounds initial collection;
 * release failure leaves the namespace owner responsible for reconciliation. */
export function createManagedLeafPinHolder(caller: ManagedLeafCollectorConfig,
  dependencies: ManagedLeafCollectorDependencies = defaults): Readonly<{
    acquire(leafId: string, signal: AbortSignal): Promise<HeldManagedLeafDirectory>
  }> {
  const config = captureManagedLeafConfig(caller)
  const collector = createManagedLeafCollector(config, dependencies)
  const collect = collector.collect.bind(collector), open = dependencies.openWebSocket.bind(dependencies)
  const reviewer = config.readReviewerBearer.bind(config)
  return Object.freeze({ async acquire(input: string, signal: AbortSignal) {
    const deadline = performance.now() + config.timeoutMs, leafId = managedLeafUuid(input)
    const observation = await collect(leafId, signal)
    const acquisition = new AbortController(), abort = () => acquisition.abort()
    const timer = setTimeout(abort, Math.max(0, deadline - performance.now()))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { acquisition.abort() }
    let bearer = ''
    try {
      try { bearer = await awaitPodAuthValue(Promise.resolve(reviewer(acquisition.signal)), acquisition.signal) }
      catch { throw new ManagedLeafCollectorError(signal.aborted ? 'ABORTED' : acquisition.signal.aborted ? 'TIMEOUT' : 'CREDENTIAL_FAILED') }
      if (!bearerValid(bearer) || bearer.trim() !== bearer) { throw new ManagedLeafCollectorError('CREDENTIAL_FAILED') }
      if (signal.aborted) { throw new ManagedLeafCollectorError('ABORTED') }
      if (acquisition.signal.aborted || performance.now() >= deadline) { throw new ManagedLeafCollectorError('TIMEOUT') }
      return await hold(open, config, leafId, observation, bearer, signal, deadline)
    } finally {
      bearer = ''; clearTimeout(timer); signal.removeEventListener('abort', abort); acquisition.abort()
    }
  } })
}

function hold(open: ManagedLeafCollectorDependencies['openWebSocket'], config: ManagedLeafCollectorConfig,
  leafId: string, observation: AuthenticatedManagedLeafObservation, bearer: string,
  signal: AbortSignal, deadline: number): Promise<HeldManagedLeafDirectory> {
  return new Promise((resolve, reject) => {
    let socket: ManagedLeafSocket | undefined, send: unknown
    let active = false, acquired = false, terminal = false, handshake = false, releaseRequested = false
    let terminalError: ManagedLeafCollectorError | undefined
    let releaseResolve: (() => void) | undefined, releaseReject: ((error: Error) => void) | undefined
    let releasing: Promise<void> | undefined
    let heldOutput = ''
    let releaseTimer: ReturnType<typeof setTimeout> | undefined
    const streams = new Map([1, 2, 3].map(id => [id, {
      decoder: new TextDecoder('utf-8', { fatal: true }), text: '', closed: false,
    }]))
    const timer = setTimeout(() => fail('TIMEOUT'), Math.max(0, deadline - performance.now()))
    function removeActive(): void {
      clearTimeout(timer); clearTimeout(releaseTimer)
      signal.removeEventListener('abort', aborted)
      socket?.off('open', opened).off('message', message).off('unexpected-response', unexpected)
    }
    function fail(code: ManagedLeafCollectorCode): void {
      if (terminal) { return }
      terminal = true; active = false; removeActive()
      for (const stream of streams.values()) { stream.text = '' }
      const error = new ManagedLeafCollectorError(code)
      terminalError = error
      if (!acquired) { reject(error) }
      releaseReject?.(error)
      // Keep error/close consumers through close; late errors cannot leak URLs.
      socket?.terminate()
    }
    function aborted(): void { fail('ABORTED') }
    function failed(): void { fail('NETWORK_FAILED') }
    function opened(): void {
      if (socket?.protocol !== 'v5.channel.k8s.io' || typeof send !== 'function') { fail('EXEC_PROTOCOL'); return }
      handshake = true
    }
    function unexpected(request: { destroy(): void }, response: { destroy(): void }): void {
      fail('EXEC_FAILED'); response.destroy(); request.destroy()
    }
    function closeStream(id: number): void {
      const stream = streams.get(id)
      if (!stream || stream.closed) { throw new ManagedLeafCollectorError('EXEC_PROTOCOL') }
      stream.text += stream.decoder.decode(); stream.closed = true
    }
    function closed(code: number): void {
      active = false
      if (!terminal) {
        try {
          if (!handshake || !acquired || code !== 1000) { throw new ManagedLeafCollectorError('EXEC_FAILED') }
          for (const [id, stream] of streams) { if (!stream.closed) { closeStream(id) } }
          const stdout = streams.get(1)!.text, stderr = streams.get(2)!.text
          const status = JSON.parse(streams.get(3)!.text)
          if (!releaseRequested || !stdout.endsWith('ORCA_MANAGED_LEAF_PIN_RELEASED\n') ||
              stderr || !status || status.status !== 'Success') { throw new ManagedLeafCollectorError('EXEC_FAILED') }
          terminal = true; removeActive(); releaseResolve?.()
        } catch { fail('EXEC_FAILED') }
      }
      socket?.off('error', failed).off('close', closed)
      for (const stream of streams.values()) { stream.text = '' }
    }
    function message(raw: unknown, binary: boolean): void {
      if (terminal) { return }
      try {
        if (!handshake || !binary || !(raw instanceof Uint8Array) || raw.length < 1) { throw new ManagedLeafCollectorError('EXEC_PROTOCOL') }
        if (raw[0] === 255) {
          if (raw.length !== 2) { throw new ManagedLeafCollectorError('EXEC_PROTOCOL') }
          if (!releaseRequested) { throw new ManagedLeafCollectorError('EXEC_FAILED') }
          closeStream(raw[1]); return
        }
        const stream = streams.get(raw[0])
        if (!stream || stream.closed) { throw new ManagedLeafCollectorError('EXEC_PROTOCOL') }
        stream.text += stream.decoder.decode(raw.subarray(1), { stream: true })
        if (stream.text.length > 2 * 1024 * 1024 || raw[0] === 2 && stream.text) { throw new ManagedLeafCollectorError('EXEC_FAILED') }
        if (raw[0] === 3 && !releaseRequested) { throw new ManagedLeafCollectorError('EXEC_FAILED') }
        if (acquired) {
          if (raw[0] === 1 && (!releaseRequested && stream.text !== heldOutput ||
              releaseRequested && !(heldOutput + 'ORCA_MANAGED_LEAF_PIN_RELEASED\n').startsWith(stream.text))) {
            throw new ManagedLeafCollectorError('EXEC_PROTOCOL')
          }
          return
        }
        if (raw[0] !== 1) { return }
        const marker = /\nORCA_MANAGED_LEAF_PIN_HELD ([1-9]\d*) (\d+) ([1-9]\d*)\n$/.exec(stream.text)
        if (!marker) { return }
        const projected = projectManagedLeafOutput(stream.text.slice(0, marker.index + 1), config, leafId, observation.pod)
        if (!sameDirectory(projected.candidate, observation.candidate) || marker[2] !== observation.candidate.device ||
            marker[3] !== observation.candidate.inode || !Number.isSafeInteger(Number(marker[1]))) {
          fail('MOUNT_CHANGED'); return
        }
        acquired = true; active = true; heldOutput = stream.text; clearTimeout(timer)
        // Acquisition cancellation no longer owns this resource. In particular
        // request abort/cleanup cannot close the FD during PG settlement.
        signal.removeEventListener('abort', aborted)
        const holder = Object.freeze({ observation, holderPid: Number(marker[1]), held: () => active,
          physicalPinIssued: false as const,
          release(): Promise<void> {
            if (releasing) { return releasing }
            if (!active || terminal) { return Promise.reject(terminalError ?? new ManagedLeafCollectorError('EXEC_FAILED')) }
            active = false; releaseRequested = true
            releasing = new Promise<void>((done, bad) => { releaseResolve = done; releaseReject = bad })
            releaseTimer = setTimeout(() => fail('TIMEOUT'), config.timeoutMs)
            try { Reflect.apply(send as (...args: unknown[]) => unknown, socket, [Buffer.concat([
              Buffer.from([0]), Buffer.from('RELEASE_MANAGED_LEAF_PIN\n'),
            ])]) } catch { fail('NETWORK_FAILED') }
            return releasing
          },
        })
        issued.add(holder); resolve(holder)
      } catch (error) { fail(error instanceof ManagedLeafCollectorError ? error.code : 'EXEC_PROTOCOL') }
    }
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) { aborted(); return }
    try {
      const url = new URL(`/api/v1/namespaces/${encodeURIComponent(config.namespace)}/pods/${encodeURIComponent(config.podName)}/exec`, config.apiOrigin)
      url.protocol = 'wss:'
      for (const [key, value] of Object.entries({ container: config.containerName, stdin: 'true', tty: 'false', stdout: 'true', stderr: 'true' })) {
        url.searchParams.set(key, value)
      }
      for (const arg of ['/bin/sh', '-ec', managedLeafPinCommand, 'orca-managed-leaf-pin', config.helperSha256,
        config.exportsSha256, config.podUid, config.dataset, leafId]) { url.searchParams.append('command', arg) }
      socket = open(url, 'v5.channel.k8s.io', { ca: Buffer.from(config.ca), rejectUnauthorized: true,
        agent: false as unknown as ClientOptions['agent'], followRedirects: false,
        handshakeTimeout: Math.max(1, Math.ceil(deadline - performance.now())), perMessageDeflate: false,
        headers: { Authorization: `Bearer ${bearer}` } })
      send = Reflect.get(socket, 'send')
      socket.on('error', failed).once('close', closed)
      if (terminal || signal.aborted) { fail('ABORTED'); socket.terminate(); return }
      socket.once('open', opened).on('message', message).once('unexpected-response', unexpected)
    } catch { fail('NETWORK_FAILED') }
  })
}
