import type { OpsReplayCursor } from './contract.ts'
import { badRequest } from './errors.ts'
const decimal = /^(0|[1-9][0-9]*)$/
export function encodeOpsAfter(cursor: OpsReplayCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}
export function decodeOpsAfter(value: string, streamId: string): OpsReplayCursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) { return badRequest() }
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { return badRequest() }
    const item = parsed as Record<string, unknown>
    if (Object.keys(item).sort().join(',') !== 'epoch,offset,streamId' || item.streamId !== streamId ||
      typeof item.epoch !== 'string' || typeof item.offset !== 'string' ||
      !decimal.test(item.epoch) || !decimal.test(item.offset)) { return badRequest() }
    const cursor = { streamId, epoch: item.epoch, offset: item.offset }
    if (encodeOpsAfter(cursor) !== value) { return badRequest() }
    return Object.freeze(cursor)
  } catch { return badRequest() }
}
