import { request as httpsRequest } from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { TextDecoder } from 'node:util'
import type { AbortableInventoryTransport } from '../ha/pass.ts'
import type { ListedResource, ResourceWatchEvent } from './watch.ts'
import { KubernetesInventoryError, inventoryDataset, inventoryName, inventoryNamespace,
  inventoryOpaque, inventoryPod, inventoryRecord } from './kubernetes-identity.ts'

export { KubernetesInventoryError } from './kubernetes-identity.ts'

export type KubernetesInventoryConfig = {
  readonly apiOrigin: string
  readonly ca: Uint8Array
  readonly namespace: string
  readonly dataset: string
  readonly requestTimeoutMs: number
  readonly watchTimeoutSeconds: number
  readonly listLimit?: number
  readonly readBearerToken: (this: Readonly<KubernetesInventoryConfig>, signal: AbortSignal) => string | Promise<string>
}
type WatchResult = Awaited<ReturnType<AbortableInventoryTransport['watch']>>
type HttpResult = { readonly status: number; readonly body: string; readonly watched?: WatchResult }

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new KubernetesInventoryError('CONFIG_INVALID')
  }
  return value
}
function parsedJson(text: string): unknown {
  try { return JSON.parse(text) } catch { throw new KubernetesInventoryError('JSON_INVALID') }
}
function alive(signal: AbortSignal): void {
  if (signal.aborted) { throw new KubernetesInventoryError('ABORTED') }
}

/** Read observations only. No PG, renewal, retry, actuator, or fencing permit. */
export function createKubernetesInventoryTransport(caller: KubernetesInventoryConfig): AbortableInventoryTransport {
  let origin: string, namespace: string, dataset: string
  let ca: Buffer, timeout: number, watchTimeout: number, limit: number
  let tokenReader: KubernetesInventoryConfig['readBearerToken']
  try {
    const input = { apiOrigin: caller.apiOrigin, ca: caller.ca, namespace: caller.namespace, dataset: caller.dataset,
      requestTimeoutMs: caller.requestTimeoutMs, watchTimeoutSeconds: caller.watchTimeoutSeconds,
      listLimit: caller.listLimit, readBearerToken: caller.readBearerToken }
    tokenReader = input.readBearerToken
    const url = new URL(input.apiOrigin)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        url.pathname !== '/' || (input.apiOrigin !== url.origin && input.apiOrigin !== `${url.origin}/`) ||
        !(input.ca instanceof Uint8Array) || input.ca.byteLength === 0 || typeof tokenReader !== 'function') {
      throw new KubernetesInventoryError('CONFIG_INVALID')
    }
    origin = url.origin
    namespace = inventoryNamespace(input.namespace)
    dataset = inventoryDataset(input.dataset)
    ca = Buffer.from(input.ca)
    timeout = positive(input.requestTimeoutMs)
    watchTimeout = positive(input.watchTimeoutSeconds)
    limit = positive(input.listLimit ?? 500)
  } catch { throw new KubernetesInventoryError('CONFIG_INVALID') }
  // Capture the method and its receiver, including a separate CA copy, before any await.
  const tokenReceiver = Object.freeze({ apiOrigin: origin, namespace, dataset, ca: Buffer.from(ca),
    requestTimeoutMs: timeout, watchTimeoutSeconds: watchTimeout, listLimit: limit, readBearerToken: tokenReader })
  const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`
  const selector = `orca.dev/role=runtime-agent,orca.dev/dataset=${dataset}`

  function exchange(target: string, query: URLSearchParams, signal: AbortSignal,
    watchVersion?: string, allowNotFound = false): Promise<HttpResult> {
    alive(signal)
    // The budget includes waiting for the token supplier. Late supplier completion
    // cannot open a request after external cancellation or budget expiry.
    return new Promise((resolve, reject) => {
      const tokenSignal = new AbortController()
      let request: ClientRequest | undefined, response: IncomingMessage | undefined
      let settled = false, body = '', remainder = '', lastVersion = watchVersion ?? ''
      const events: ResourceWatchEvent[] = []
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const watched = (status: WatchResult['status']): WatchResult =>
        Object.freeze({ status, resourceVersion: lastVersion, events: Object.freeze([...events]) })
      const timer = setTimeout(() => finish(new KubernetesInventoryError('REQUEST_TIMEOUT')), timeout)
      function finish(error?: KubernetesInventoryError, result?: HttpResult): void {
        if (settled) { return }
        if (signal.aborted) { error = new KubernetesInventoryError('ABORTED') }
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        tokenSignal.abort()
        // Destroy without forwarding errors/reasons that may contain credentials.
        response?.off('data', onData).off('end', onEnd).off('aborted', onDisconnected)
        response?.destroy()
        request?.destroy()
        // Error guards stay until close, then all owned listeners are removed.
        if (error) { reject(error) } else if (result) { resolve(Object.freeze(result)) }
      }
      function onAbort(): void { finish(new KubernetesInventoryError('ABORTED')) }
      function onDisconnected(): void {
        if (watchVersion !== undefined && response?.statusCode === 200) {
          finish(undefined, { status: 200, body: '', watched: watched('DISCONNECTED') })
        } else { finish(new KubernetesInventoryError('CONNECTION_FAILED')) }
      }
      function onRequestError(error: NodeJS.ErrnoException): void {
        if (settled) { return }
        const network = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
          'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(error.code ?? '')
        if (watchVersion !== undefined && network) {
          finish(undefined, { status: 200, body: '', watched: watched('DISCONNECTED') })
        } else { finish(new KubernetesInventoryError('CONNECTION_FAILED')) }
      }
      function releaseRequest(): void {
        request?.off('error', onRequestError).off('close', releaseRequest)
        if (!settled && !response) { onDisconnected() }
      }
      function releaseResponse(): void {
        response?.off('data', onData).off('end', onEnd).off('error', onDisconnected)
          .off('aborted', onDisconnected).off('close', releaseResponse)
        if (!settled) { onDisconnected() }
      }
      function frame(line: string): boolean {
        alive(signal)
        const event = inventoryRecord(parsedJson(line))
        if (event.type === 'ERROR') {
          const status = inventoryRecord(event.object)
          if (status.apiVersion === 'v1' && status.kind === 'Status' && status.code === 410) {
            finish(undefined, { status: 200, body: '', watched: watched('EXPIRED_410') })
            return false
          }
          throw new KubernetesInventoryError('WATCH_FAILED')
        }
        if (event.type === 'BOOKMARK') {
          const object = inventoryRecord(event.object)
          if (object.apiVersion !== 'v1' || object.kind !== 'Pod') {
            throw new KubernetesInventoryError('IDENTITY_INVALID')
          }
          lastVersion = inventoryOpaque(inventoryRecord(object.metadata).resourceVersion)
          events.push(Object.freeze({ type: 'BOOKMARK', resourceVersion: lastVersion }))
        } else if (event.type === 'ADDED' || event.type === 'MODIFIED' || event.type === 'DELETED') {
          const object = inventoryPod(event.object, namespace, dataset)
          lastVersion = object.resourceVersion
          events.push(Object.freeze({ type: event.type, object }))
        } else { throw new KubernetesInventoryError('WATCH_FAILED') }
        return true
      }
      function onData(chunk: Buffer): void {
        if (settled) { return }
        try {
          alive(signal)
          const text = decoder.decode(chunk, { stream: true })
          if (watchVersion === undefined) { body += text; return }
          remainder += text
          let newline: number
          while ((newline = remainder.indexOf('\n')) !== -1) {
            const line = remainder.slice(0, newline)
            remainder = remainder.slice(newline + 1)
            if (line.trim() && !frame(line)) { return }
          }
        } catch (error) {
          finish(error instanceof KubernetesInventoryError ? error : new KubernetesInventoryError('JSON_INVALID'))
        }
      }
      function onEnd(): void {
        if (settled) { return }
        try {
          alive(signal)
          let tail: string
          try { tail = decoder.decode() } catch {
            if (watchVersion !== undefined) { onDisconnected(); return }
            throw new KubernetesInventoryError('JSON_INVALID')
          }
          if (watchVersion !== undefined) {
            remainder += tail
            finish(undefined, { status: 200, body: '', watched: watched(remainder ? 'DISCONNECTED' : 'EVENTS') })
          } else { finish(undefined, { status: 200, body: body + tail }) }
        } catch (error) {
          finish(error instanceof KubernetesInventoryError ? error : new KubernetesInventoryError('JSON_INVALID'))
        }
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) { onAbort(); return }
      void (async () => {
        try {
          alive(signal)
          let token: string
          try { token = await tokenReader.call(tokenReceiver, tokenSignal.signal) }
          catch { throw new KubernetesInventoryError('TOKEN_FAILED') }
          if (settled) { return }
          alive(signal)
          if (typeof token !== 'string' || !/^[A-Za-z0-9\-._~+/]+=*$/u.test(token)) {
            throw new KubernetesInventoryError('TOKEN_FAILED')
          }
          const url = new URL(target, origin)
          url.search = query.toString()
          request = httpsRequest(url, { method: 'GET', ca, rejectUnauthorized: true, agent: false,
            headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, Connection: 'close' } }, received => {
            response = received
            response.on('error', onDisconnected).once('close', releaseResponse)
            if (settled || signal.aborted) { onAbort(); response.destroy(); return }
            const status = response.statusCode
            if (watchVersion !== undefined && status === 410) {
              finish(undefined, { status, body: '', watched: watched('EXPIRED_410') })
            } else if (allowNotFound && status === 404) { finish(undefined, { status, body: '' }) }
            else if (status !== 200) { finish(new KubernetesInventoryError('HTTP_FAILED')) }
            else { response.on('data', onData).once('end', onEnd).once('aborted', onDisconnected) }
          })
          request.on('error', onRequestError).once('close', releaseRequest)
          if (signal.aborted || settled) { onAbort(); request.destroy(); return }
          request.end()
        } catch (error) {
          finish(error instanceof KubernetesInventoryError ? error : new KubernetesInventoryError('CONNECTION_FAILED'))
        }
      })()
    })
  }

  return Object.freeze({
    async list(signal: AbortSignal) {
      alive(signal)
      const objects: ListedResource[] = [], seen = new Set<string>()
      let resourceVersion: string | undefined, continuation = ''
      do {
        alive(signal)
        const query = new URLSearchParams({ labelSelector: selector, limit: String(limit) })
        if (continuation) { query.set('continue', continuation) }
        const received = await exchange(path, query, signal)
        alive(signal)
        const page = inventoryRecord(parsedJson(received.body))
        if (page.apiVersion !== 'v1' || page.kind !== 'PodList' || !Array.isArray(page.items)) {
          throw new KubernetesInventoryError('IDENTITY_INVALID')
        }
        const metadata = inventoryRecord(page.metadata)
        const version = inventoryOpaque(metadata.resourceVersion)
        if (resourceVersion !== undefined && version !== resourceVersion) {
          throw new KubernetesInventoryError('LIST_VERSION_CHANGED')
        }
        resourceVersion = version
        for (const item of page.items) { objects.push(inventoryPod(item, namespace, dataset)) }
        const next = metadata.continue === undefined ? '' : metadata.continue
        if (typeof next !== 'string') { throw new KubernetesInventoryError('IDENTITY_INVALID') }
        continuation = next
        if (continuation) {
          if (seen.has(continuation)) { throw new KubernetesInventoryError('CONTINUE_REPEATED') }
          seen.add(continuation)
        }
      } while (continuation)
      return Object.freeze({ resourceVersion: inventoryOpaque(resourceVersion), objects: Object.freeze(objects) })
    },
    async watch(resourceVersion: string, signal: AbortSignal) {
      alive(signal)
      const version = inventoryOpaque(resourceVersion)
      // The special RV=0 means "any", not the caller's exact snapshot.
      if (version === '0') { throw new KubernetesInventoryError('IDENTITY_INVALID') }
      const query = new URLSearchParams({ labelSelector: selector, watch: 'true', resourceVersion: version,
        timeoutSeconds: String(watchTimeout), allowWatchBookmarks: 'true' })
      const received = await exchange(path, query, signal, version)
      alive(signal)
      if (!received.watched) { throw new KubernetesInventoryError('WATCH_FAILED') }
      return received.watched
    },
    async get(requestNamespace: string, name: string, signal: AbortSignal) {
      alive(signal)
      if (inventoryNamespace(requestNamespace) !== namespace) { throw new KubernetesInventoryError('IDENTITY_INVALID') }
      const capturedName = inventoryName(name)
      const received = await exchange(`${path}/${encodeURIComponent(capturedName)}`, new URLSearchParams(), signal, undefined, true)
      alive(signal)
      return received.status === 404 ? null : inventoryPod(parsedJson(received.body), namespace, dataset, capturedName)
    }
  })
}
