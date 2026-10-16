import { TextDecoder } from 'node:util'
import { performance } from 'node:perf_hooks'
import type { ClientOptions } from 'ws'
import type { CapturedAgentMountInput } from './agent-mount-collector-projection.ts'
import { agentMountOutputLimit, agentMountProbeSource } from './agent-mount-collector-probe.ts'
import { AgentMountCollectorError } from './agent-mount-collector-types.ts'
import type { AgentMountCollectorConfig, AgentMountCollectorDependencies } from './agent-mount-collector-types.ts'
import type { ManagedLeafSocket } from './managed-leaf-collector-types.ts'

export function agentMountExecUrl(config: AgentMountCollectorConfig, input: CapturedAgentMountInput): URL {
  const url = new URL(`/api/v1/namespaces/${encodeURIComponent(config.namespace)}/pods/${encodeURIComponent(input.original.name)}/exec`, config.apiOrigin)
  url.protocol = 'wss:'
  for (const [key, value] of Object.entries({ container: input.containerName, stdin: 'false', tty: 'false', stdout: 'true', stderr: 'true' })) {
    url.searchParams.set(key, value)
  }
  for (const argument of ['/usr/local/bin/node', '-e', agentMountProbeSource,
    JSON.stringify({ roots: input.mounts.map(item => item.clientPath) })]) { url.searchParams.append('command', argument) }
  return url
}

/** V5 close frames half-close streams; closing transport does not prove a remote NFS syscall has ended. */
export function collectAgentMountExec(open: AgentMountCollectorDependencies['openWebSocket'],
  config: AgentMountCollectorConfig, input: CapturedAgentMountInput, reviewer: string, signal: AbortSignal,
  absoluteDeadline: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let socket: ManagedLeafSocket | undefined, settled = false, handshake = false, bytes = 0
    const streams = new Map([1, 2, 3].map(id => [id, { decoder: new TextDecoder('utf-8', { fatal: true }), text: '', closed: false }]))
    function removeActive(): void {
      signal.removeEventListener('abort', aborted)
      socket?.off('open', opened).off('message', message).off('unexpected-response', unexpected)
    }
    function fail(code: 'EXEC_PROTOCOL' | 'EXEC_FAILED' | 'NETWORK_FAILED' | 'ABORTED' | 'TIMEOUT'): void {
      if (settled) { return }
      settled = true
      removeActive()
      for (const stream of streams.values()) { stream.text = '' }
      // Keep the error consumer until close so terminate/late handshake errors remain handled.
      socket?.terminate()
      reject(new AgentMountCollectorError(code))
    }
    function aborted(): void { fail('ABORTED') }
    function failed(): void { fail('NETWORK_FAILED') }
    function opened(): void {
      if (settled) { return }
      if (socket?.protocol !== 'v5.channel.k8s.io') { fail('EXEC_PROTOCOL'); return }
      handshake = true
    }
    function unexpected(request: { destroy(): void }, response: { destroy(): void }): void {
      fail('EXEC_FAILED'); response.destroy(); request.destroy()
    }
    function closeStream(id: number): void {
      const stream = streams.get(id)
      if (!stream || stream.closed) { throw new AgentMountCollectorError('EXEC_PROTOCOL') }
      stream.text += stream.decoder.decode()
      stream.closed = true
    }
    function message(data: unknown, binary: boolean): void {
      if (settled) { return }
      try {
        if (!handshake || !binary || !(data instanceof Uint8Array) || data.length < 1) { throw new AgentMountCollectorError('EXEC_PROTOCOL') }
        if (data[0] === 255) {
          if (data.length !== 2) { throw new AgentMountCollectorError('EXEC_PROTOCOL') }
          closeStream(data[1]); return
        }
        if ((bytes += data.byteLength - 1) > agentMountOutputLimit) { throw new AgentMountCollectorError('EXEC_PROTOCOL') }
        const stream = streams.get(data[0])
        if (!stream || stream.closed) { throw new AgentMountCollectorError('EXEC_PROTOCOL') }
        stream.text += stream.decoder.decode(data.subarray(1), { stream: true })
        if (data[0] === 2 && data.length > 1) { fail('EXEC_FAILED') }
      } catch { fail('EXEC_PROTOCOL') }
    }
    function closed(code: number): void {
      if (!settled) {
        if (!handshake || code !== 1000 || signal.aborted) { fail(signal.aborted ? 'ABORTED' : 'EXEC_PROTOCOL') }
        else {
          try {
            for (const [id, stream] of streams) { if (!stream.closed) { closeStream(id) } }
            const status: unknown = JSON.parse(streams.get(3)?.text ?? '')
            if (typeof status !== 'object' || status === null || Array.isArray(status) ||
                !('status' in status) || status.status !== 'Success' ||
                ('reason' in status && status.reason !== '') ||
                ('code' in status && status.code !== 0 && status.code !== 200)) { throw new AgentMountCollectorError('EXEC_FAILED') }
            const stdout = streams.get(1)?.text ?? ''
            if (!stdout || streams.get(2)?.text) { throw new AgentMountCollectorError('EXEC_FAILED') }
            settled = true; removeActive(); resolve(stdout)
          } catch { fail('EXEC_FAILED') }
        }
      }
      socket?.off('error', failed).off('close', closed)
      for (const stream of streams.values()) { stream.text = '' }
    }
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) { aborted(); return }
    try {
      const url = agentMountExecUrl(config, input), ca = Buffer.from(config.ca)
      const remainingMs = absoluteDeadline - performance.now()
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) { fail('TIMEOUT'); return }
      socket = open(url, 'v5.channel.k8s.io', {
        // ws forwards false to Node HTTPS; @types/ws 8.18.1 omits this supported value.
        ca, rejectUnauthorized: true, agent: false as unknown as ClientOptions['agent'], followRedirects: false,
        handshakeTimeout: Math.max(1, Math.ceil(remainingMs)), perMessageDeflate: false,
        maxPayload: agentMountOutputLimit + 1,
        headers: { Authorization: `Bearer ${reviewer}` },
      })
      socket.on('error', failed).once('close', closed)
      if (settled || signal.aborted) { socket.terminate(); return }
      socket.once('open', opened).on('message', message).once('unexpected-response', unexpected)
    } catch { fail('NETWORK_FAILED') }
  })
}
