import * as https from 'node:https'
import { TextDecoder } from 'node:util'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { projectComputeAuditPage } from './compute-deletion-audit-projection'
import type { ComputeAuditErrorCode, ComputeAuditPageResult } from './compute-deletion-audit-types'
import { freezeAuditValue } from './compute-deletion-audit-types'

export type ComputeAuditTransportConfiguration = Readonly<{
  tokenProvider: { getAccessToken(signal: AbortSignal): Promise<string> }
  timeoutMs?: number
  maxResponseBytes?: number
  /** Trusted composition seam for transport fixtures, never an application-supplied URL. */
  https?: { request: typeof https.request }
}>

type TransportSnapshot = Readonly<{
  token: (signal: AbortSignal) => Promise<string>
  request: typeof https.request
  timeoutMs: number
  maxResponseBytes: number
}>

export function snapshotAuditTransport(
  config: ComputeAuditTransportConfiguration
): TransportSnapshot | null {
  const timeoutMs = config.timeoutMs ?? 30_000
  const maxResponseBytes = config.maxResponseBytes ?? 4 * 1024 * 1024
  const provider = config.tokenProvider
  const transport = config.https ?? https
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 ||
      typeof provider?.getAccessToken !== 'function' || typeof transport.request !== 'function') {
    return null
  }
  return Object.freeze({
    token: provider.getAccessToken.bind(provider), request: transport.request.bind(transport),
    timeoutMs, maxResponseBytes
  })
}

function networkCode(error: unknown): ComputeAuditErrorCode {
  const code = error !== null && typeof error === 'object' && 'code' in error
    ? String(error.code) : ''
  return /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_|SELF_SIGNED_|UNABLE_TO_)/.test(code)
    ? 'TLS_ERROR' : 'NETWORK_ERROR'
}

function invalidToken(token: string): boolean {
  return Array.from(token).some(character => /\s/.test(character) ||
    character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

function httpCode(status: number | undefined): ComputeAuditErrorCode | null {
  if (status === 200) {
    return null
  }
  if (status === 401) {
    return 'UNAUTHORIZED'
  }
  if (status === 403) {
    return 'FORBIDDEN'
  }
  return status !== undefined && status >= 300 && status < 400 ? 'REDIRECT_REJECTED' : 'HTTP_ERROR'
}

/** One owned HTTPS request, no redirect/retry/pagination; deadline includes token acquisition. */
export function readComputeAuditPage(
  config: TransportSnapshot,
  body: string,
  signal?: AbortSignal
): Promise<ComputeAuditPageResult> {
  return new Promise(resolve => {
    const cancellation = new AbortController()
    let request: ClientRequest | undefined
    let response: IncomingMessage | undefined
    let settled = false
    let chunks: Buffer[] = []
    let bytes = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const failure = (code: ComputeAuditErrorCode): ComputeAuditPageResult =>
      freezeAuditValue<ComputeAuditPageResult>({ ok: false, error: { code } })
    const incomplete = (reason: 'RESPONSE_TRUNCATED' | 'RESPONSE_BYTE_LIMIT'):
      ComputeAuditPageResult => freezeAuditValue<ComputeAuditPageResult>({ ok: true, page: { entries: [], incomplete: reason } })
    const finish = (result: ComputeAuditPageResult): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      cancellation.abort()
      chunks = []
      // Keep owned error listeners until close so cancellation cannot emit an unhandled error.
      response?.destroy()
      request?.destroy()
      resolve(result)
    }
    const onAbort = (): void => finish(failure('ABORTED'))
    const onRequestError = (error: unknown): void => finish(failure(networkCode(error)))
    const onResponseError = (): void => finish(incomplete('RESPONSE_TRUNCATED'))
    const onResponseAborted = (): void => finish(incomplete('RESPONSE_TRUNCATED'))
    const onData = (chunk: Buffer): void => {
      if (settled) {
        return
      }
      bytes += chunk.length
      if (bytes > config.maxResponseBytes) {
        finish(incomplete('RESPONSE_BYTE_LIMIT'))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => {
      if (settled) {
        return
      }
      if (!response?.complete) {
        finish(incomplete('RESPONSE_TRUNCATED'))
        return
      }
      let value: unknown
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
      } catch {
        finish(failure('INVALID_JSON'))
        return
      }
      // Project immediately; no raw body, provider cause or authentication fields are retained.
      finish(projectComputeAuditPage(value))
    }
    const onResponseClose = (): void => {
      if (!settled) {
        finish(incomplete('RESPONSE_TRUNCATED'))
      }
      response?.off('data', onData)
      response?.off('end', onEnd)
      response?.off('error', onResponseError)
      response?.off('aborted', onResponseAborted)
      response?.off('close', onResponseClose)
    }
    const onRequestClose = (): void => {
      if (!settled) {
        finish(failure('NETWORK_ERROR'))
      }
      request?.off('error', onRequestError)
      request?.off('close', onRequestClose)
    }
    const onResponse = (message: IncomingMessage): void => {
      response = message
      message.on('error', onResponseError)
      message.once('close', onResponseClose)
      if (settled) {
        message.destroy()
        return
      }
      const error = httpCode(message.statusCode)
      if (error) {
        finish(failure(error))
        return
      }
      message.on('data', onData)
      message.once('end', onEnd)
      message.once('aborted', onResponseAborted)
    }
    timer = setTimeout(() => finish(failure('TIMEOUT')), config.timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    // Resolve asynchronous and synchronous token-provider failures without exposing their cause.
    void Promise.resolve().then(() => settled ? null : config.token(cancellation.signal)).then(token => {
      if (settled) {
        return
      }
      if (typeof token !== 'string' || !token || invalidToken(token)) {
        finish(failure('AUTH_FAILED'))
        return
      }
      try {
        request = config.request({
          protocol: 'https:', hostname: 'logging.googleapis.com', port: 443,
          path: '/v2/entries:list', method: 'POST', rejectUnauthorized: true, agent: false,
          headers: {
            Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          }
        }, onResponse)
        request.on('error', onRequestError)
        request.once('close', onRequestClose)
        request.end(body)
      } catch {
        finish(failure('NETWORK_ERROR'))
      }
    }, () => finish(failure('AUTH_FAILED')))
  })
}
