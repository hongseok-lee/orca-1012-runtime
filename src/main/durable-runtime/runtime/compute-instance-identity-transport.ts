import { TextDecoder } from 'node:util'
import { performance } from 'node:perf_hooks'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { projectComputeInstanceIdentity } from './compute-instance-identity-projection'
import type {
  CapturedComputeIdentityConfiguration, ComputeInstanceIdentityErrorCode,
  ComputeInstanceIdentityInput, ComputeInstanceIdentityResult
} from './compute-instance-identity-types'
import { identityFailure } from './compute-instance-identity-types'

/** Bounds only an upstream response buffer, not application/user input. */
export const COMPUTE_INSTANCE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024

function networkCode(error: unknown): ComputeInstanceIdentityErrorCode {
  let code = ''
  try {
    if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
      code = error.code
    }
  } catch {
    return 'NETWORK_ERROR'
  }
  return /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_|SELF_SIGNED_|UNABLE_TO_)/.test(code)
    ? 'TLS_ERROR' : 'NETWORK_ERROR'
}

function invalidToken(value: unknown): boolean {
  return typeof value !== 'string' || !value || Array.from(value).some(character =>
    /\s/.test(character) || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

function httpCode(status: number | undefined): ComputeInstanceIdentityErrorCode | null {
  if (status === 200) {
    return null
  }
  if (status === 401) {
    return 'UNAUTHORIZED'
  }
  if (status === 403) {
    return 'FORBIDDEN'
  }
  if (status === 404) {
    return 'NOT_FOUND'
  }
  return status !== undefined && status >= 300 && status < 400 ? 'REDIRECT_REJECTED' : 'HTTP_ERROR'
}

/** A single owned GET. Deadline includes credential wait; no redirect/list/retry/pagination. */
export function readComputeInstanceIdentity(
  config: CapturedComputeIdentityConfiguration,
  input: ComputeInstanceIdentityInput,
  path: string,
  signal?: AbortSignal
): Promise<ComputeInstanceIdentityResult> {
  const deadline = performance.now() + config.timeoutMs
  return new Promise(resolve => {
    const cancellation = new AbortController()
    let request: ClientRequest | undefined
    let response: IncomingMessage | undefined
    let settled = false
    let bytes = 0
    let chunks: Buffer[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: ComputeInstanceIdentityResult): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      cancellation.abort()
      chunks = []
      // Retain error listeners until close; destroy only this call's nonpooled resources.
      response?.destroy()
      request?.destroy()
      resolve(result)
    }
    const fail = (code: ComputeInstanceIdentityErrorCode): void => finish(identityFailure(code))
    const expired = (): boolean => {
      if (performance.now() >= deadline) {
        fail('TIMEOUT')
        return true
      }
      return false
    }
    const onAbort = (): void => fail('ABORTED')
    const onRequestError = (error: unknown): void => fail(networkCode(error))
    const onResponseError = (): void => fail('RESPONSE_TRUNCATED')
    const onResponseAborted = (): void => fail('RESPONSE_TRUNCATED')
    const onData = (chunk: Buffer): void => {
      if (settled || expired()) {
        return
      }
      bytes += chunk.length
      if (bytes > COMPUTE_INSTANCE_RESPONSE_MAX_BYTES) {
        fail('RESPONSE_TOO_LARGE')
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => {
      if (settled || expired()) {
        return
      }
      if (!response?.complete) {
        fail('RESPONSE_TRUNCATED')
        return
      }
      let value: unknown
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
      } catch {
        if (!expired()) {
          fail('INVALID_JSON')
        }
        return
      }
      const result = projectComputeInstanceIdentity(config.projectId, input, value)
      if (!expired()) {
        finish(result)
      }
    }
    const onResponseClose = (): void => {
      if (!settled) {
        fail('RESPONSE_TRUNCATED')
      }
      response?.off('data', onData)
      response?.off('end', onEnd)
      response?.off('error', onResponseError)
      response?.off('aborted', onResponseAborted)
      response?.off('close', onResponseClose)
    }
    const onRequestClose = (): void => {
      if (!settled) {
        fail('NETWORK_ERROR')
      }
      request?.off('error', onRequestError)
      request?.off('response', onResponse)
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
      if (expired()) {
        return
      }
      const code = httpCode(message.statusCode)
      if (code) {
        fail(code)
        return
      }
      message.on('data', onData)
      message.once('end', onEnd)
      message.once('aborted', onResponseAborted)
    }
    timer = setTimeout(() => fail('TIMEOUT'), Math.max(0, deadline - performance.now()))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    void Promise.resolve().then(() => settled || expired() ? null : config.readAccessToken(cancellation.signal)).then(token => {
      if (settled || expired()) {
        return
      }
      if (typeof token !== 'string' || invalidToken(token)) {
        fail('AUTH_FAILED')
        return
      }
      try {
        if (expired()) {
          return
        }
        request = config.request({ protocol: 'https:', hostname: 'compute.googleapis.com', port: 443,
          path, method: 'GET', rejectUnauthorized: true, agent: false,
          headers: { Authorization: `Bearer ${token}` } }, onResponse)
        request.on('error', onRequestError)
        request.once('close', onRequestClose)
        if (expired()) {
          return
        }
        request.end()
      } catch {
        if (!expired()) {
          fail('NETWORK_ERROR')
        }
      }
    }, () => {
      if (!expired()) {
        fail('AUTH_FAILED')
      }
    })
  })
}
