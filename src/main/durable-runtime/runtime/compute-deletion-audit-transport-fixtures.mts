import { Readable, Writable } from 'node:stream'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { RequestOptions, request } from 'node:https'

export type AuditWireScenario = {
  status?: number
  json?: unknown
  body?: string
  errorCode?: string
  neverRespond?: boolean
  truncated?: boolean
}

class FixtureResponse extends Readable {
  statusCode: number
  complete: boolean
  private emitted = false
  constructor(private readonly scenario: AuditWireScenario) {
    super()
    this.statusCode = scenario.status ?? 200
    this.complete = !scenario.truncated
  }
  _read(): void {
    if (this.emitted) {
      return
    }
    this.emitted = true
    this.push(Buffer.from(this.scenario.body ?? JSON.stringify(this.scenario.json ?? {})))
    this.push(null)
  }
}

class FixtureRequest extends Writable {
  body = ''
  constructor(private readonly dispatch: () => void) {
    super({ autoDestroy: false })
  }
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.body += chunk.toString('utf8')
    callback()
  }
  _final(callback: () => void): void {
    callback()
    queueMicrotask(this.dispatch)
  }
}

/** Actual stream/error/close events exercise cleanup, without Cloud or a TLS bypass. */
export function auditWire(scenario: AuditWireScenario = {}) {
  const requests: FixtureRequest[] = []
  const responses: FixtureResponse[] = []
  const options: RequestOptions[] = []
  const holder = {
    expectedReceiver: true,
    request: function (this: { expectedReceiver: boolean }, input: RequestOptions,
      callback: (message: IncomingMessage) => void): ClientRequest {
      if (!this.expectedReceiver) {
        throw new Error('lost request receiver')
      }
      options.push(input)
      const req = new FixtureRequest(() => {
        if (scenario.neverRespond || req.destroyed) {
          return
        }
        if (scenario.errorCode) {
          const error = Object.assign(new Error('private transport sentinel'), { code: scenario.errorCode })
          req.emit('error', error)
          return
        }
        const response = new FixtureResponse(scenario)
        responses.push(response)
        callback(response as unknown as IncomingMessage)
      })
      requests.push(req)
      return req as unknown as ClientRequest
    } as typeof request
  }
  return { holder, requests, responses, options }
}

export async function closedStreams(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}
