import type { ServerResponse } from 'node:http'
import type { OpsActor, OpsEventsQuery, OpsHttpServices } from './types.ts'
import type { OpsReplayPage } from './contract.ts'
import { encodeOpsAfter } from './cursor.ts'
import { sanitizeOpsError } from './errors.ts'
function waitForDrain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted || response.destroyed) { return Promise.resolve() }
  return new Promise(resolve => {
    const done = (): void => {
      response.off('drain', done); response.off('close', done); signal.removeEventListener('abort', done); resolve()
    }
    response.once('drain', done); response.once('close', done); signal.addEventListener('abort', done, { once: true })
  })
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) { return Promise.resolve() }
  return new Promise(resolve => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
async function frame(response: ServerResponse, signal: AbortSignal, event: string, data: unknown, id?: string): Promise<void> {
  if (signal.aborted || response.destroyed || response.writableEnded) { return }
  if (!response.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) {
    await waitForDrain(response, signal)
  }
}
export async function streamOpsEvents(
  response: ServerResponse, signal: AbortSignal, read: OpsHttpServices['events'], actor: OpsActor,
  query: OpsEventsQuery, pollIntervalMs: number, first: OpsReplayPage
): Promise<void> {
  response.statusCode = 200
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  let after = query.after
  let pending: OpsReplayPage | null = first
  while (!signal.aborted && !response.destroyed && !response.writableEnded) {
    try {
      // Exactly one query/page at a time, then one frame with backpressure; no retained queue.
      const page: OpsReplayPage = pending ?? await read(actor, { ...query, after })
      pending = null
      if (signal.aborted || response.destroyed || response.writableEnded) { break }
      if (page.status === 'RESET_REQUIRED') { await frame(response, signal, 'reset', page); break }
      after = Object.freeze({ ...page.nextCursor })
      await frame(response, signal, 'page', page, encodeOpsAfter(after))
      await pause(pollIntervalMs, signal)
    } catch (error) {
      const safe = sanitizeOpsError(error)
      await frame(response, signal, 'error', { error: { code: safe.code, message: safe.message } })
      break
    }
  }
  if (!response.destroyed && !response.writableEnded) { response.end() }
}
