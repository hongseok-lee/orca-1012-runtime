import { TextDecoder } from 'node:util'
import { ManagedLeafCollectorError } from './managed-leaf-collector-types.ts'
import type { ManagedLeafCollectorConfig, ManagedLeafCollectorDependencies, ManagedLeafSocket } from './managed-leaf-collector-types.ts'

// Every variable is a validated, separate argv value; there is no caller shell source.
export const managedLeafInspectCommand = `
set -eu
[ "$#" -eq 5 ]
check_hashes() {
  [ "$(sha256sum /opt/orca-nfs-tools/managed_storage.sh | cut -d ' ' -f 1)" = "$1" ]
  [ "$(sha256sum /etc/exports | cut -d ' ' -f 1)" = "$2" ]
}
check_hashes "$1" "$2"
before=$(cat /proc/self/mountinfo)
printf 'ORCA_MANAGED_LEAF_1\nMOUNTINFO_BEFORE\n%s\nHELPER_JSON\n' "$before"
/bin/sh /opt/orca-nfs-tools/managed_storage.sh inspect-leaf "$3" "$4" "$5"
after=$(cat /proc/self/mountinfo)
[ "$before" = "$after" ]
check_hashes "$1" "$2"
printf 'MOUNTINFO_AFTER\n%s\nORCA_MANAGED_LEAF_END\n' "$after"
`

export function managedLeafExecUrl(config: ManagedLeafCollectorConfig, leafId: string): URL {
  const url = new URL(`/api/v1/namespaces/${encodeURIComponent(config.namespace)}/pods/${encodeURIComponent(config.podName)}/exec`, config.apiOrigin)
  url.protocol = 'wss:'
  for (const [key, value] of Object.entries({ container: config.containerName, stdin: 'false', tty: 'false', stdout: 'true', stderr: 'true' })) {
    url.searchParams.set(key, value)
  }
  for (const argument of ['/bin/sh', '-ec', managedLeafInspectCommand, 'orca-managed-leaf-collector',
    config.helperSha256, config.exportsSha256, config.podUid, config.dataset, leafId]) { url.searchParams.append('command', argument) }
  return url
}

/** V5 close frames half-close streams; normal socket close supplies EOF for remaining streams. */
export function collectManagedLeafExec(open: ManagedLeafCollectorDependencies['openWebSocket'],
  config: ManagedLeafCollectorConfig, leafId: string, reviewer: string, signal: AbortSignal,
  remainingMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let socket: ManagedLeafSocket | undefined, settled = false, handshake = false
    const streams = new Map([1, 2, 3].map(id => [id, { decoder: new TextDecoder('utf-8', { fatal: true }), text: '', closed: false }]))
    function removeActive(): void {
      signal.removeEventListener('abort', aborted)
      socket?.off('open', opened).off('message', message).off('unexpected-response', unexpected)
    }
    function fail(code: 'EXEC_PROTOCOL' | 'EXEC_FAILED' | 'NETWORK_FAILED' | 'ABORTED'): void {
      if (settled) { return }
      settled = true
      removeActive()
      for (const stream of streams.values()) { stream.text = '' }
      // Keep the error consumer until close so terminate/late handshake errors remain handled.
      socket?.terminate()
      reject(new ManagedLeafCollectorError(code))
    }
    function aborted(): void { fail('ABORTED') }
    function failed(): void { fail('NETWORK_FAILED') }
    function opened(): void {
      if (socket?.protocol !== 'v5.channel.k8s.io') { fail('EXEC_PROTOCOL'); return }
      handshake = true
    }
    function unexpected(request: { destroy(): void }, response: { destroy(): void }): void {
      fail('EXEC_FAILED'); response.destroy(); request.destroy()
    }
    function closeStream(id: number): void {
      const stream = streams.get(id)
      if (!stream || stream.closed) { throw new ManagedLeafCollectorError('EXEC_PROTOCOL') }
      stream.text += stream.decoder.decode()
      stream.closed = true
    }
    function message(data: unknown, binary: boolean): void {
      if (settled) { return }
      try {
        if (!handshake || !binary || !(data instanceof Uint8Array) || data.length < 1) { throw new ManagedLeafCollectorError('EXEC_PROTOCOL') }
        if (data[0] === 255) {
          if (data.length !== 2) { throw new ManagedLeafCollectorError('EXEC_PROTOCOL') }
          closeStream(data[1]); return
        }
        const stream = streams.get(data[0])
        if (!stream || stream.closed) { throw new ManagedLeafCollectorError('EXEC_PROTOCOL') }
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
                ('code' in status && status.code !== 0 && status.code !== 200)) { throw new ManagedLeafCollectorError('EXEC_FAILED') }
            const stdout = streams.get(1)?.text ?? ''
            if (!stdout || streams.get(2)?.text) { throw new ManagedLeafCollectorError('EXEC_FAILED') }
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
      socket = open(managedLeafExecUrl(config, leafId), 'v5.channel.k8s.io', {
        ca: Buffer.from(config.ca), rejectUnauthorized: true, agent: false, followRedirects: false,
        handshakeTimeout: Math.max(1, Math.ceil(remainingMs)), perMessageDeflate: false,
        headers: { Authorization: `Bearer ${reviewer}` },
      })
      socket.on('error', failed).once('close', closed)
      if (settled || signal.aborted) { socket.terminate(); return }
      socket.once('open', opened).on('message', message).once('unexpected-response', unexpected)
    } catch { fail('NETWORK_FAILED') }
  })
}
