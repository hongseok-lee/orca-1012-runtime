import { request as httpsRequest } from 'node:https'
import { TextDecoder } from 'node:util'
import { KubernetesPodAuthError } from './kubernetes-pod-auth-types.ts'
import type { KubernetesPodAuthErrorCode, KubernetesPodAuthHttps, PodAuthRequest,
  PodAuthResponse } from './kubernetes-pod-auth-types.ts'

export const defaultPodAuthHttps: KubernetesPodAuthHttps = Object.freeze({
  request: (url, options, callback) => httpsRequest(url, options, callback)
})

export function awaitPodAuthValue<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    function abort(): void { finish(new KubernetesPodAuthError('ABORTED')) }
    function finish(error: KubernetesPodAuthError): void {
      if (settled) { return }
      settled = true
      signal.removeEventListener('abort', abort)
      reject(error)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort() }
    void value.then(result => { if (!settled) { settled = true; signal.removeEventListener('abort', abort); resolve(result) } },
      () => finish(new KubernetesPodAuthError('REVIEWER_CREDENTIAL_FAILED')))
  })
}
function connectionCode(error: unknown): KubernetesPodAuthErrorCode {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return typeof code === 'string' && (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') ||
    ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_NOT_YET_VALID'].includes(code)) ?
    'TLS_FAILED' : 'NETWORK_FAILED'
}

/** One fixed-origin exchange. No redirects, retries, tokens in errors, or body retention after projection. */
export function exchangePodAuth(transport: KubernetesPodAuthHttps, origin: string, ca: Uint8Array,
  path: string, reviewer: string, body: string | undefined, missing: 'POD_NOT_FOUND' | 'NODE_NOT_FOUND',
  signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let request: PodAuthRequest | undefined, response: PodAuthResponse | undefined, settled = false
    let text = ''
    const decoder = new TextDecoder('utf-8', { fatal: true })
    function finish(error?: KubernetesPodAuthError, value?: unknown): void {
      if (settled) { return }
      settled = true
      signal.removeEventListener('abort', abort)
      response?.off('data', data).off('end', end).off('aborted', disconnected)
      text = ''
      response?.destroy()
      request?.destroy()
      if (error) { reject(error) } else { resolve(value) }
    }
    function abort(): void { finish(new KubernetesPodAuthError('ABORTED')) }
    function disconnected(): void { finish(new KubernetesPodAuthError('NETWORK_FAILED')) }
    function failed(error: unknown): void { finish(new KubernetesPodAuthError(connectionCode(error))) }
    function requestClosed(): void {
      request?.off('error', failed).off('close', requestClosed)
      if (!settled && !response) { disconnected() }
    }
    function responseClosed(): void {
      response?.off('data', data).off('end', end).off('error', disconnected)
        .off('aborted', disconnected).off('close', responseClosed)
      if (!settled) { disconnected() }
    }
    function data(chunk: unknown): void {
      if (settled) { return }
      try {
        if (!(chunk instanceof Uint8Array)) { throw new KubernetesPodAuthError('RESPONSE_INVALID') }
        text += decoder.decode(chunk, { stream: true })
      } catch { finish(new KubernetesPodAuthError('RESPONSE_INVALID')) }
    }
    function end(): void {
      if (settled) { return }
      try { finish(undefined, JSON.parse(text + decoder.decode())) }
      catch { finish(new KubernetesPodAuthError('RESPONSE_INVALID')) }
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    try {
      request = transport.request(new URL(path, origin), {
        method: body === undefined ? 'GET' : 'POST', ca: Buffer.from(ca), rejectUnauthorized: true, agent: false,
        headers: { Accept: 'application/json', Authorization: `Bearer ${reviewer}`, Connection: 'close',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }) }
      }, received => {
        response = received
        response.on('error', disconnected).once('close', responseClosed)
        if (settled || signal.aborted) { response.destroy(); return }
        const status = response.statusCode
        if (status === 401 || status === 403) { finish(new KubernetesPodAuthError('HTTP_FORBIDDEN')) }
        else if (status === 404 && body === undefined) { finish(new KubernetesPodAuthError(missing)) }
        else if (status !== 200 && !(body !== undefined && status === 201)) { finish(new KubernetesPodAuthError('HTTP_FAILED')) }
        else { response.on('data', data).once('end', end).once('aborted', disconnected) }
      })
      request.on('error', failed).once('close', requestClosed)
      if (settled || signal.aborted) { request.destroy(); return }
      request.end(body)
    } catch (error) { finish(new KubernetesPodAuthError(connectionCode(error))) }
  })
}
