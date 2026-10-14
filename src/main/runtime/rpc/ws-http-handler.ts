import type { RequestListener } from 'node:http'
import type { OpsHttpHandler } from '../../durable-runtime/ops/types.ts'
import { createStaticWebClientHandler } from './static-web-client-handler'

/** Capture immutable listener references once, preserving ops → static → 404 order. */
export function createWebSocketHttpHandler(
  staticRoot: string | undefined,
  httpHandler: OpsHttpHandler | undefined
): RequestListener | undefined {
  const staticListener = staticRoot ? createStaticWebClientHandler(staticRoot) : undefined
  return httpHandler
    ? (request, response) => {
        if (httpHandler(request, response)) { return }
        if (staticListener) { staticListener(request, response) }
        else { response.statusCode = 404; response.end() }
      }
    : staticListener
}
