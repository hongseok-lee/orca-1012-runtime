import { describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import { ExternalChromiumCdpConnection } from './external-chromium-cdp-connection'
import { ExternalChromiumTargetScreencast } from './external-chromium-target-screencast'

const Request = z.object({ id: z.number(), method: z.string(), sessionId: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional() })

// This controlled CDP peer exposes ordering; actual Chrome/wire evidence remains the separate fixture.
describe('external target stop command fence', () => {
  for (const boundary of ['opening', 'updates', 'metrics'] as const) {
    it(`drains ${boundary} without another normal start after stop`, async () => {
      const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
      await new Promise<void>(resolve => server.once('listening', resolve))
      const address = server.address()
      if (typeof address === 'string' || !address) throw new Error('Missing controlled peer port')
      const methods: string[] = []
      const requests: z.infer<typeof Request>[] = []
      let release!: () => void
      let observed!: () => void
      const held = new Promise<void>(resolve => { observed = resolve })
      let hold = boundary === 'opening' ? 'Page.enable'
        : boundary === 'metrics' ? 'Emulation.setDeviceMetricsOverride' : 'Page.stopScreencast'
      server.on('connection', socket => {
        socket.on('message', bytes => {
          const request = Request.parse(JSON.parse(bytes.toString()))
          methods.push(request.method)
          requests.push(request)
          const result = request.method === 'Target.getTargets'
            ? { targetInfos: [{ targetId: 'owned-target', type: 'page', url: 'about:blank' }] }
            : request.method === 'Target.attachToTarget' ? { sessionId: 'owned-cdp-session' } : {}
          const reply = () => socket.send(JSON.stringify({ id: request.id, result,
            ...(request.sessionId ? { sessionId: request.sessionId } : {}) }))
          if (request.method === hold) { hold = ''; release = reply; observed(); return }
          reply()
        })
      })
      const connection = new ExternalChromiumCdpConnection()
      await connection.connect(`ws://127.0.0.1:${address.port}/devtools/browser/controlled`)
      const stream = new ExternalChromiumTargetScreencast(connection, {
        publicPageId: 'page', agentPageId: 't1', targetId: 'owned-target', browserGeneration: connection.generation
      }, { format: 'jpeg', quality: 70, maxWidth: 640, maxHeight: 480, everyNthFrame: 1,
        minFrameIntervalMs: 0, viewportWidth: 640, viewportHeight: 480, onFrame: () => true })
      let work: Promise<void>
      if (boundary !== 'updates') work = stream.start()
      else {
        await stream.start()
        work = stream.updateFrameBudget({ quality: 50, maxWidth: 640, maxHeight: 480,
          everyNthFrame: 1, minFrameIntervalMs: 0 })
      }
      // Observe rejection immediately so cancellation cannot create an unhandled promise.
      const settled = work.then(() => 'resolved', () => 'rejected')
      try {
        await held
        const boundaryIndex = methods.length
        stream.stop()
        release()
        expect(await settled).toBe('rejected')
        await stream.done
        expect(methods.slice(boundaryIndex)).not.toContain('Page.startScreencast')
        expect(methods.slice(boundaryIndex)).not.toContain('Emulation.setDeviceMetricsOverride')
        expect(methods.at(-1)).toBe('Target.detachFromTarget')
        if (boundary === 'metrics') {
          expect(methods.slice(boundaryIndex)).toEqual(['Emulation.clearDeviceMetricsOverride', 'Target.detachFromTarget'])
          expect(requests[boundaryIndex].sessionId).toBe('owned-cdp-session')
          expect(requests[boundaryIndex + 1].params?.sessionId).toBe('owned-cdp-session')
        }
        stream.stop()
      } finally {
        stream.stop()
        connection.close()
        await stream.done
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    })
  }
})
