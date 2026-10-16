import { TextDecoder } from 'node:util'
import { defaultPodAuthHttps } from '../runtime/kubernetes-pod-auth-transport.ts'
import { AgentPodCreateError } from './agent-pod-create-types.ts'
import type { AgentPodCreateCode, AgentPodCreateHttps } from './agent-pod-create-types.ts'
import type { PodAuthRequest, PodAuthResponse } from '../runtime/kubernetes-pod-auth-types.ts'

export const defaultAgentPodCreateHttps: AgentPodCreateHttps = defaultPodAuthHttps
function connectionCode(error: unknown): AgentPodCreateCode {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return typeof code === 'string' && (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') ||
    ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_NOT_YET_VALID'].includes(code)) ? 'TLS_FAILED' : 'NETWORK_FAILED'
}

/** One original-name exchange; never follows redirects or retries a POST. */
export function exchangeAgentPodCreate(transport: AgentPodCreateHttps, origin: string, ca: Uint8Array,
  path: string, bearer: string, body: string | undefined, signal: AbortSignal): Promise<Readonly<{ status: number; value?: unknown }>> {
  return new Promise((resolve, reject) => {
    let request: PodAuthRequest | undefined, response: PodAuthResponse | undefined, settled = false, text = '', bytes = 0
    const decoder = new TextDecoder('utf-8', { fatal: true })
    function finish(error?: AgentPodCreateError, value?: Readonly<{ status: number; value?: unknown }>): void {
      if (settled) { return }
      settled = true
      signal.removeEventListener('abort', abort)
      response?.off('data', data).off('end', end).off('aborted', disconnected)
      text = ''
      // Error guards remain until close; destroying never forwards raw errors/reasons.
      response?.destroy(); request?.destroy()
      if (error) { reject(error) } else { resolve(Object.freeze(value ?? { status: 0 })) }
    }
    function abort(): void { finish(new AgentPodCreateError('ABORTED')) }
    function disconnected(): void { finish(new AgentPodCreateError('NETWORK_FAILED')) }
    function failed(error: unknown): void { finish(new AgentPodCreateError(connectionCode(error))) }
    function requestClosed(): void {
      request?.off('error', failed).off('close', requestClosed)
      if (!settled && !response) { disconnected() }
    }
    function responseClosed(): void {
      response?.off('data', data).off('end', end).off('error', disconnected).off('aborted', disconnected).off('close', responseClosed)
      if (!settled) { disconnected() }
    }
    function data(chunk: unknown): void {
      if (settled) { return }
      try {
        if (!(chunk instanceof Uint8Array) || (bytes += chunk.byteLength) > 2 * 1024 * 1024) { throw new Error() }
        text += decoder.decode(chunk, { stream: true })
      } catch { finish(new AgentPodCreateError('RESPONSE_INVALID')) }
    }
    function end(): void {
      if (settled) { return }
      try { finish(undefined, { status: response?.statusCode ?? 0, value: JSON.parse(text + decoder.decode()) }) }
      catch { finish(new AgentPodCreateError('RESPONSE_INVALID')) }
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    try {
      request = transport.request(new URL(path, origin), {
        method: body === undefined ? 'GET' : 'POST', ca: Buffer.from(ca), rejectUnauthorized: true, agent: false,
        headers: { Accept: 'application/json', Authorization: `Bearer ${bearer}`, Connection: 'close',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }) }
      }, received => {
        response = received
        response.on('error', disconnected).once('close', responseClosed)
        if (settled || signal.aborted) { response.destroy(); return }
        const status = response.statusCode
        if (status === 401 || status === 403) { finish(new AgentPodCreateError('HTTP_FORBIDDEN')) }
        else if (status === 404 && body === undefined || status === 409 && body !== undefined) { finish(undefined, { status }) }
        else if (status !== (body === undefined ? 200 : 201)) { finish(new AgentPodCreateError('HTTP_FAILED')) }
        else { response.on('data', data).once('end', end).once('aborted', disconnected) }
      })
      request.on('error', failed).once('close', requestClosed)
      if (settled || signal.aborted) { request.destroy(); return }
      request.end(body)
    } catch (error) { finish(new AgentPodCreateError(connectionCode(error))) }
  })
}
