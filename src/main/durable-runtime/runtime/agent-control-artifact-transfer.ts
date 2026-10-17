import { TextDecoder } from 'node:util'
import WebSocket from 'ws'
import type { ClientOptions } from 'ws'
import type { AgentCodexTransportConfiguration } from './agent-codex-transport.ts'

const fail = (): Error => new Error('AGENT_CODEX_CONTROL_UNCONFIRMED')

import { agentControlTransfer } from './agent-control-bootstrap.ts'

/** Create-only delivery of the reviewed product artifact to the SAME Agent.
 * Lost acknowledgement is unconfirmed and is never automatically retransmitted.
 * This does not write NFS/HOME, change a Pod, install a package, or open a gate. */
export function transferAgentControlBundle(config: Readonly<Omit<AgentCodexTransportConfiguration,
  'ca' | 'bootstrapBytes' | 'podAuthenticator' | 'readReviewerBearer'>>, ca: Buffer,
  artifact: Buffer, bearer: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket | undefined, settled = false, handshake = false
    const streams = new Map([1, 2, 3].map(id => [id, { decoder: new TextDecoder('utf-8', { fatal: true }), text: '', closed: false }]))
    const clean = () => { signal.removeEventListener('abort', aborted); socket?.off('open', opened).off('message', message).off('unexpected-response', unexpected) }
    function failure(): void {
      if (settled) { return }
      settled = true; clean(); socket?.terminate(); reject(fail())
    }
    function aborted(): void { failure() }
    function unexpected(request: { destroy(): void }, response: { destroy(): void }): void { failure(); response.destroy(); request.destroy() }
    function opened(): void {
      if (!socket || socket.protocol !== 'v5.channel.k8s.io' || signal.aborted) { failure(); return }
      handshake = true
      socket.send(Buffer.concat([Buffer.from([0]), artifact]), error => {
        if (error || signal.aborted) { failure(); return }
        socket?.send(Buffer.from([255, 0]), closeError => { if (closeError) { failure() } })
      })
    }
    function closeStream(id: number): void {
      const stream = streams.get(id)
      if (!stream || stream.closed) { throw fail() }
      stream.text += stream.decoder.decode(); stream.closed = true
    }
    function message(raw: WebSocket.RawData, binary: boolean): void {
      if (settled) { return }
      try {
        if (!handshake || !binary || !(raw instanceof Uint8Array) || !raw.length) { throw fail() }
        if (raw[0] === 255) { if (raw.length !== 2) { throw fail() }; closeStream(raw[1]); return }
        const stream = streams.get(raw[0])
        if (!stream || stream.closed) { throw fail() }
        stream.text += stream.decoder.decode(raw.subarray(1), { stream: true })
        if (stream.text.length > 65536 || raw[0] !== 3 && stream.text) { throw fail() }
      } catch { failure() }
    }
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) { aborted(); return }
    try {
      const url = new URL(`/api/v1/namespaces/${encodeURIComponent(config.namespace)}/pods/${encodeURIComponent(config.expected.podName)}/exec`, config.apiOrigin)
      url.protocol = 'wss:'
      for (const [key, value] of Object.entries({ container: config.container, stdin: 'true', stdout: 'true', stderr: 'true', tty: 'false' })) { url.searchParams.set(key, value) }
      for (const arg of ['/usr/local/bin/node', '-e', agentControlTransfer, config.bootstrapSha256]) { url.searchParams.append('command', arg) }
      socket = new WebSocket(url, 'v5.channel.k8s.io', { ca: Buffer.from(ca), rejectUnauthorized: true,
        agent: false as unknown as ClientOptions['agent'], followRedirects: false, perMessageDeflate: false,
        handshakeTimeout: config.timeoutMs, headers: { Authorization: `Bearer ${bearer}` } })
      socket.on('error', failure).once('open', opened).on('message', message).once('unexpected-response', unexpected).once('close', code => {
        if (!settled) {
          try {
            for (const [id, stream] of streams) { if (!stream.closed) { closeStream(id) } }
            if (!handshake || code !== 1000 || streams.get(1)!.text || streams.get(2)!.text ||
                JSON.parse(streams.get(3)!.text).status !== 'Success') { throw fail() }
            settled = true; clean(); resolve()
          } catch { failure() }
        }
        socket?.off('error', failure)
        for (const stream of streams.values()) { stream.text = '' }
      })
    } catch { failure() }
  })
}
