import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OpsHttpConfig, OpsHttpHandler } from './types.ts'
import { OpsHttpError, sanitizeOpsError } from './errors.ts'

/** Early UI/startup connection. Data routing is supplied by the same owned module's services. */
export function createOpsHttpHandler(config: OpsHttpConfig): OpsHttpHandler {
  const origin = new URL(config.origin)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== config.origin) {
    throw new OpsHttpError(400, 'invalid_configuration', 'A canonical HTTP origin is required.')
  }
  const verify = config.authenticateBearer.bind(config)
  const ui = config.ui
  const services = config.services
  let stopped = false
  const handle = ((request: IncomingMessage, response: ServerResponse): boolean => {
    let url: URL
    try { url = new URL(request.url ?? '/', origin) } catch { return false }
    if (url.pathname !== '/ops' && !url.pathname.startsWith('/ops/')) { return false }
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    void (async () => {
      if (stopped) { throw new OpsHttpError(503, 'stopping', 'The operations service is stopping.') }
      if (request.headers.origin !== undefined && request.headers.origin !== origin.origin) {
        throw new OpsHttpError(403, 'forbidden_origin', 'The request origin is not permitted.')
      }
      if (!url.pathname.startsWith('/ops/v1/')) {
        const asset = request.method === 'GET' || request.method === 'HEAD' ? await ui?.(url.pathname) : null
        if (!asset) { throw new OpsHttpError(404, 'not_found', 'The operations asset was not found.') }
        if (stopped || response.destroyed) { return }
        response.statusCode = 200; response.setHeader('Content-Type', asset.contentType)
        response.end(request.method === 'HEAD' ? undefined : asset.body)
        return
      }
      const header = request.headers.authorization
      const token = typeof header === 'string' ? /^Bearer ([^\s]+)$/i.exec(header)?.[1] : null
      if (!token) { throw new OpsHttpError(401, 'unauthorized', 'A valid operations key is required.') }
      const actor = await verify(token)
      if (!actor) { throw new OpsHttpError(401, 'unauthorized', 'A valid operations key is required.') }
      // The early pin deliberately cannot advertise working routes before the PG adapter is connected.
      void services; void actor
      throw new OpsHttpError(501, 'route_not_connected', 'The operations route is not connected yet.')
    })().catch((error: unknown) => {
      if (stopped || response.destroyed || response.writableEnded) { return }
      const safe = sanitizeOpsError(error)
      response.statusCode = safe.status; response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.end(JSON.stringify({ error: { code: safe.code, message: safe.message } }))
    })
    return true
  }) as OpsHttpHandler
  handle.stop = async () => { stopped = true }
  return handle
}
