import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OpsActor, OpsEventsQuery, OpsHttpConfig, OpsHttpServices } from './types.ts'
import { opsId, queryFields, queryLimit, jsonBody, commandBody, notificationReadBody } from './validation.ts'
import { decodeOpsAfter } from './cursor.ts'
import { OpsHttpError, badRequest } from './errors.ts'
import { streamOpsEvents } from './sse.ts'
export type OpsBoundServices = OpsHttpServices
export function bindOpsServices(services: OpsHttpServices): OpsBoundServices {
  return Object.freeze({ units: services.units.bind(services), unit: services.unit.bind(services),
    operation: services.operation.bind(services), events: services.events.bind(services),
    notifications: services.notifications.bind(services), readNotification: services.readNotification.bind(services),
    command: services.command.bind(services) })
}
export function writeOpsJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) { return }
  response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(value))
}
function eventsQuery(request: IncomingMessage, url: URL, streamId: string, stream: boolean): OpsEventsQuery {
  queryFields(url, ['unit', 'after', 'limit'])
  const last = request.headers['last-event-id']
  if (last !== undefined && typeof last !== 'string') { return badRequest() }
  const after = url.searchParams.get('after')
  if (stream && after !== null && last !== undefined && after !== last) { return badRequest() }
  const cursor = after ?? (stream ? last : null)
  const unit = url.searchParams.get('unit')
  return { after: cursor == null ? null : decodeOpsAfter(cursor, streamId),
    unit: unit === null ? null : opsId(unit), limit: queryLimit(url) }
}
export async function routeOpsRequest(
  request: IncomingMessage, response: ServerResponse, url: URL, actor: OpsActor,
  services: OpsBoundServices, config: Pick<OpsHttpConfig, 'streamId' | 'pollIntervalMs'>, signal: AbortSignal
): Promise<void> {
  const send = (status: number, value: unknown): void => { if (!signal.aborted) { writeOpsJson(response, status, value) } }
  if (request.method === 'GET' && url.pathname === '/ops/v1/runtime-units') {
    queryFields(url, []); send(200, await services.units(actor)); return
  }
  const unit = /^\/ops\/v1\/runtime-units\/([^/]+)$/.exec(url.pathname)
  if (unit && request.method === 'GET') { queryFields(url, []); send(200, await services.unit(actor, opsId(unit[1]))); return }
  const operation = /^\/ops\/v1\/operations\/([^/]+)$/.exec(url.pathname)
  if (operation && request.method === 'GET') { queryFields(url, []); send(200, await services.operation(actor, opsId(operation[1]))); return }
  if (request.method === 'GET' && (url.pathname === '/ops/v1/events' || url.pathname === '/ops/v1/events/stream')) {
    const stream = url.pathname.endsWith('/stream')
    const query = eventsQuery(request, url, config.streamId, stream)
    if (stream) {
      // Authenticate/authorize the first PG page before committing stream headers.
      const first = await services.events(actor, query)
      if (!signal.aborted) { await streamOpsEvents(response, signal, services.events, actor, query, config.pollIntervalMs, first) }
    }
    else { send(200, await services.events(actor, query)) }
    return
  }
  if (request.method === 'GET' && url.pathname === '/ops/v1/notifications') {
    queryFields(url, ['state', 'after', 'limit'])
    const state = url.searchParams.get('state'), after = url.searchParams.get('after')
    if (state !== null && state !== 'OPEN' && state !== 'RESOLVED') { return badRequest() }
    send(200, await services.notifications(actor, { state, afterId: after === null ? null : opsId(after), limit: queryLimit(url) })); return
  }
  const read = /^\/ops\/v1\/notifications\/([^/]+)\/read$/.exec(url.pathname)
  if (read && request.method === 'POST') {
    queryFields(url, []); const id = opsId(read[1]); const body = notificationReadBody(await jsonBody(request))
    if (!signal.aborted) { send(200, await services.readNotification(actor, id, body)) }; return
  }
  const command = /^\/ops\/v1\/runtime-units\/([^/]+)\/commands$/.exec(url.pathname)
  if (command && request.method === 'POST') {
    queryFields(url, []); const id = opsId(command[1]); const body = commandBody(await jsonBody(request))
    if (!signal.aborted) { send(202, await services.command(actor, id, body)) }; return
  }
  throw new OpsHttpError(404, 'not_found', 'The operations route was not found.')
}
