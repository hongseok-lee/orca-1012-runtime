import type { IncomingMessage } from 'node:http'
import { counter } from '../../../shared/durable-runtime/identity.ts'
import { badRequest } from './errors.ts'
import type { OpsCommandRequest, OpsNotificationReadRequest } from './contract.ts'
export function opsId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) { return badRequest() }
  return value
}
export function opsCounter(value: unknown): string {
  if (typeof value !== 'string') { return badRequest() }
  try { return counter('ops-counter', value) } catch { return badRequest() }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return badRequest() }
  return value as Record<string, unknown>
}
export function fields(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) { badRequest() }
}
export function queryFields(url: URL, allowed: readonly string[]): void {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) { badRequest() }
  }
}
export function queryLimit(url: URL): number {
  const text = url.searchParams.get('limit')
  if (text === null) { return 100 }
  if (!/^[1-9][0-9]*$/.test(text)) { return badRequest() }
  const limit = Number(text)
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) { return badRequest() }
  return limit
}
export async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type']
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) { return badRequest() }
  const chunks: Buffer[] = []
  for await (const chunk of request) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) }
  try { return record(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { return badRequest() }
}
export function commandBody(body: Record<string, unknown>): OpsCommandRequest {
  fields(body, ['operationId', 'expectedRevision', 'action', 'params'])
  if (typeof body.action !== 'string' || !body.action) { return badRequest() }
  const params = record(body.params)
  if (body.action === 'wake') { fields(params, ['expectedIntentRevision']); opsCounter(params.expectedIntentRevision) }
  return Object.freeze({ operationId: opsId(body.operationId), expectedRevision: opsCounter(body.expectedRevision),
    action: body.action, params: Object.freeze({ ...params }) })
}
export function notificationReadBody(body: Record<string, unknown>): OpsNotificationReadRequest {
  fields(body, ['operationId', 'expectedRevision'])
  return Object.freeze({ operationId: opsId(body.operationId), expectedRevision: opsCounter(body.expectedRevision) })
}
