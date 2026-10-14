import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OpsHttpConfig, OpsHttpHandler } from './types.ts'
import { OpsHttpError, sanitizeOpsError } from './errors.ts'
import { snapshotOpsActor } from './auth.ts'
import { bindOpsServices, routeOpsRequest, writeOpsJson } from './routes.ts'

type RequestOwner = { response: ServerResponse; controller: AbortController }
export function createOpsHttpHandler(config: OpsHttpConfig): OpsHttpHandler {
  const origin = new URL(config.origin)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== config.origin || !config.streamId ||
    !Number.isSafeInteger(config.pollIntervalMs) || config.pollIntervalMs <= 0) {
    throw new OpsHttpError(400, 'invalid_configuration', 'A canonical origin and stream configuration are required.')
  }
  // Capture the original methods/receivers and primitive config before any request can await authentication.
  const verify = config.authenticateBearer.bind(config)
  const ui = config.ui?.bind(config)
  const services = bindOpsServices(config.services)
  const selected = Object.freeze({ streamId: config.streamId, pollIntervalMs: config.pollIntervalMs })
  const owners = new Set<RequestOwner>()
  let stopped = false
  const handle = ((request: IncomingMessage, response: ServerResponse): boolean => {
    let url: URL
    try { url = new URL(request.url ?? '/', origin) } catch { return false }
    if (url.pathname !== '/ops' && !url.pathname.startsWith('/ops/')) { return false }
    const owner = { response, controller: new AbortController() }
    owners.add(owner)
    const finish = (): void => { owner.controller.abort(); owners.delete(owner); request.off('aborted', finish); response.off('close', finish); response.off('finish', finish) }
    request.once('aborted', finish); response.once('close', finish); response.once('finish', finish)
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    void (async () => {
      if (stopped) { throw new OpsHttpError(503, 'stopping', 'The operations service is stopping.') }
      if (url.origin !== origin.origin) { throw new OpsHttpError(400, 'bad_request', 'Invalid operations request.') }
      if (request.headers.origin !== undefined && request.headers.origin !== origin.origin) {
        throw new OpsHttpError(403, 'forbidden_origin', 'The request origin is not permitted.')
      }
      if (!url.pathname.startsWith('/ops/v1/')) {
        if (url.search) { throw new OpsHttpError(400, 'bad_request', 'Invalid operations request.') }
        const asset = request.method === 'GET' || request.method === 'HEAD' ? await ui?.(url.pathname) : null
        if (owner.controller.signal.aborted) { return }
        if (!asset) { throw new OpsHttpError(404, 'not_found', 'The operations asset was not found.') }
        response.statusCode = 200; response.setHeader('Content-Type', asset.contentType)
        response.end(request.method === 'HEAD' ? undefined : asset.body); return
      }
      const header = request.headers.authorization
      const token = typeof header === 'string' ? /^Bearer ([^\s]+)$/i.exec(header)?.[1] : null
      if (!token) { throw new OpsHttpError(401, 'unauthorized', 'A valid operations key is required.') }
      const verified = await verify(token)
      if (owner.controller.signal.aborted) { return }
      if (!verified) { throw new OpsHttpError(401, 'unauthorized', 'A valid operations key is required.') }
      // No await between verifier completion and immutable scope snapshot.
      const actor = snapshotOpsActor(verified)
      await routeOpsRequest(request, response, url, actor, services, selected, owner.controller.signal)
    })().catch((error: unknown) => {
      if (owner.controller.signal.aborted || response.destroyed || response.writableEnded) { return }
      const safe = sanitizeOpsError(error)
      if (response.headersSent) { response.end(); return }
      writeOpsJson(response, safe.status, { error: { code: safe.code, message: safe.message } })
    })
    return true
  }) as OpsHttpHandler
  handle.stop = async () => {
    stopped = true
    for (const owner of [...owners]) {
      owner.controller.abort()
      if (!owner.response.destroyed && !owner.response.writableEnded) {
        if (owner.response.headersSent) { owner.response.end() }
        else { writeOpsJson(owner.response, 503, { error: { code: 'stopping', message: 'The operations service is stopping.' } }) }
      }
      owners.delete(owner)
    }
  }
  return handle
}
