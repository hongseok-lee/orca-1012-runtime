import { Readable, Writable } from 'node:stream'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { RequestOptions, request } from 'node:https'

export type IdentityWireScenario = {
  status?: number
  json?: unknown
  body?: string | Buffer
  errorCode?: string
  neverRespond?: boolean
  neverEnd?: boolean
  truncated?: boolean
  responseFault?: 'aborted' | 'error' | 'close'
}

class FixtureResponse extends Readable {
  statusCode: number
  complete: boolean
  private emitted = false
  constructor(private readonly scenario: IdentityWireScenario) {
    super()
    this.statusCode = scenario.status ?? 200
    this.complete = !scenario.truncated
  }
  _read(): void {
    if (this.emitted) {
      return
    }
    this.emitted = true
    if (this.scenario.responseFault) {
      const fault = this.scenario.responseFault
      queueMicrotask(() => {
        if (fault === 'close') {
          this.destroy()
        } else if (fault === 'error') {
          this.destroy(new Error('fixture private response cause'))
        } else {
          this.emit('aborted')
        }
      })
      return
    }
    this.push(Buffer.from(this.scenario.body ?? JSON.stringify(this.scenario.json ?? {})))
    if (!this.scenario.neverEnd) {
      this.push(null)
    }
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

/** Injected trusted stream seam only. No HTTP server, TLS connection or Cloud API is used. */
export function identityWire(scenario: IdentityWireScenario = {}) {
  const requests: FixtureRequest[] = []
  const responses: FixtureResponse[] = []
  const options: RequestOptions[] = []
  const holder = {
    expectedReceiver: true,
    request: function (this: { expectedReceiver: boolean }, input: RequestOptions,
      callback: (message: IncomingMessage) => void): ClientRequest {
      if (!this.expectedReceiver) {
        throw new Error('fixture lost transport receiver')
      }
      options.push(input)
      const req = new FixtureRequest(() => {
        if (scenario.neverRespond || req.destroyed) {
          return
        }
        if (scenario.errorCode) {
          req.emit('error', Object.assign(new Error('fixture private transport cause'), { code: scenario.errorCode }))
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

export function deferredToken() {
  let release: (value: string) => void = () => { throw new Error('fixture token not initialized') }
  const pending = new Promise<string>(resolve => { release = resolve })
  return { pending, release }
}

export async function closedIdentityStreams(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}
