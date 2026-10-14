import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { decodeBrowserScreencastFrame } from '../../shared/browser-screencast-protocol'
import type { RuntimeBrowserCommandHost } from '../runtime/orca-runtime-browser'
import type { BrowserScreencastStartResult } from '../runtime/runtime-browser-commands-browser-command-target-params'
import { ExternalChromiumBrowserProcess } from './external-chromium-browser-process'
import { ExternalChromiumBrowserSession, type ExternalChromiumLaunch } from './external-chromium-browser-session'

// Explicitly invoked only after Root allocates the first product adapter run; importing does not run it.
export type ExternalScreencastFixtureInput = {
  directory: string
  agentBrowserPath: string
  launch: ExternalChromiumLaunch
  boundary: 'pages-and-viewers' | 'changed-generation'
}
const GateResult = z.object({ result: z.string() })
const PaintGate = z.object({ firstEpoch: z.number(), completedEpoch: z.number() })
const Created = z.object({ browserPageId: z.string() })
function fixtureHost(): RuntimeBrowserCommandHost {
  const unused = (): never => { throw new Error('Unrequested fixture host operation.') }
  return {
    getAgentBrowserBridge: () => null,
    resolveWorktreeSelector: async selector => ({ id: selector }),
    resolveBrowserWorkspace: async selector => ({ id: selector }),
    resolveBrowserNetworkExecutionHost: unused, getBrowserHostLeaseRegistry: unused,
    getRuntimeBrowserPageRegistry: unused, getAuthoritativeWindow: unused,
    getAvailableAuthoritativeWindow: () => null, getOffscreenBrowserBackend: () => null
  }
}
function collectViewer() {
  let ready = false
  let refuse = false
  let latest: ReturnType<typeof decodeBrowserScreencastFrame> = null
  let accepted = 0
  let refused = 0
  let waiter: (() => void) | null = null
  return {
    sendBinary: (bytes: Uint8Array<ArrayBufferLike>): boolean => {
      if (!ready || refuse) { refused++; return false }
      const frame = decodeBrowserScreencastFrame(bytes)
      assert(frame, 'Existing decoder rejected product wire.')
      latest = frame
      accepted++
      waiter?.()
      return true
    },
    setReady: () => { ready = true },
    setRefuse: (value: boolean) => { refuse = value },
    counts: () => ({ accepted, refused }),
    frame: async (epoch: number) => {
      const eligible = () => latest && (latest.metadata.timestamp ?? 0) >= epoch
      if (!eligible()) {await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { waiter = null; reject(new Error('PRODUCT_FRAME_TIMEOUT')) }, 8000)
        waiter = () => { if (eligible()) { clearTimeout(timer); waiter = null; resolve() } }
      })}
      assert(latest)
      return latest
    }
  }
}

export async function runExternalChromiumScreencastFixture(input: ExternalScreencastFixtureInput) {
  assert(/^\/tmp\/orca-external-wire-[A-Za-z0-9-]+$/.test(input.directory))
  await mkdir(input.directory, { mode: 0o700 })
  for (const name of ['home', 'sock', 'tmp']) {await mkdir(join(input.directory, name), { mode: 0o700 })}
  const environment: NodeJS.ProcessEnv = {
    PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: join(input.directory, 'home'),
    XDG_CONFIG_HOME: join(input.directory, 'home', '.config'),
    XDG_CACHE_HOME: join(input.directory, 'home', '.cache'),
    XDG_STATE_HOME: join(input.directory, 'home', '.local', 'state'),
    AGENT_BROWSER_SOCKET_DIR: join(input.directory, 'sock'), TMPDIR: join(input.directory, 'tmp')
  }
  const uuid = randomUUID()
  const server = http.createServer((request, response) => {
    response.writeHead(request.url === '/same' ? 200 : 404, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
    response.end(`<!doctype html><html data-owned="${uuid}"><body>OWNED PRODUCT FIXTURE</body></html>`)
  })
  const process = new ExternalChromiumBrowserProcess(input.agentBrowserPath, input.launch, input.directory, environment)
  const subscriptions: BrowserScreencastStartResult[] = []
  let stopping: Promise<void> | null = null
  const stopOwned = () => stopping ??= process.stop()
  const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), boundary: input.boundary,
    status: '미완료', interpretation: '실제 adapter 최초 경계의 결과이며 standalone probe 재실행이 아닙니다.' }
  const overallTimer = setTimeout(() => { for (const subscription of subscriptions) {subscription.session.stop();} void stopOwned() }, 100000)
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address === 'object')
    const url = `http://127.0.0.1:${address.port}/same`
    await process.start()
    const commands = process.createCommands(fixtureHost())
    const a = Created.parse(await commands.browserTabCreate({ page: `fixture-${uuid}-a`, url, worktree: 'owned' }))
    const b = Created.parse(await commands.browserTabCreate({ page: `fixture-${uuid}-b`, url, worktree: 'owned' }))
    assert.notEqual(a.browserPageId, b.browserPageId)
    const mark = async (page: string, marker: string, color: string) => {
      const expression = `(async () => {
        if (document.documentElement.dataset.owned !== ${JSON.stringify(uuid)}) throw Error('NOT_OWNED');
        document.body.textContent = ${JSON.stringify(marker)};
        document.body.style.cssText = 'background:${color};color:white;font-size:100px';
        const gate = await new Promise(resolve => requestAnimationFrame(() => {
          const firstEpoch = Date.now()/1000;
          requestAnimationFrame(() => resolve({firstEpoch,completedEpoch:Date.now()/1000}));
        })); return JSON.stringify(gate);
      })()`
      const result = GateResult.parse(await commands.browserEval({ page, worktree: 'owned', expression }))
      const gate = PaintGate.parse(JSON.parse(result.result))
      assert(gate.completedEpoch >= gate.firstEpoch)
      return gate.firstEpoch
    }
    const start = async (page: string, viewer: ReturnType<typeof collectViewer>, device: string) => {
      const subscription = await commands.browserScreencast({ page, worktree: 'owned', format: 'jpeg',
        everyNthFrame: 1, minFrameIntervalMs: 0, viewportWidth: 640, viewportHeight: 480 },
      { sendBinary: viewer.sendBinary, pairedDeviceId: device })
      subscriptions.push(subscription)
      assert.equal(subscription.ready.browserPageId, page)
      viewer.setReady()
      subscription.flushPendingFrame()
      return subscription
    }
    const first = collectViewer(), second = collectViewer(), otherPage = collectViewer()
    const firstSubscription = await start(a.browserPageId, first, 'first')
    await start(b.browserPageId, otherPage, 'other')
    const epochA = await mark(a.browserPageId, 'PRODUCT PAGE A', '#16599e')
    const frameA = await first.frame(epochA)
    await writeFile(join(input.directory, 'product-a.jpg'), frameA.image, { flag: 'wx', mode: 0o600 })
    const epochB = await mark(b.browserPageId, 'PRODUCT PAGE B', '#982d29')
    const frameB = await otherPage.frame(epochB)
    await writeFile(join(input.directory, 'product-b.jpg'), frameB.image, { flag: 'wx', mode: 0o600 })
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
    assert.notEqual(hash(frameA.image), hash(frameB.image))
    const secondSubscription = await start(a.browserPageId, second, 'second')
    assert(second.counts().accepted > 0, 'A static page joiner must flush its retained pre-ready frame.')
    if (input.boundary === 'changed-generation') {
      const replacement = new ExternalChromiumBrowserSession(input.agentBrowserPath, input.launch, input.directory, environment)
      try {
        await replacement.stop()
        await replacement.start()
        const before = first.counts().accepted
        await assert.rejects(() => commands.browserScreencast({ page: a.browserPageId, worktree: 'owned', format: 'jpeg' },
          { sendBinary: first.sendBinary }))
        await firstSubscription.session.done
        assert.equal(first.counts().accepted, before)
        evidence.generationRejection = true
      } finally { await replacement.stop() }
    } else {
      const slowBefore = second.counts()
      second.setRefuse(true)
      const epochA2 = await mark(a.browserPageId, 'PRODUCT PAGE A2', '#16599e')
      const frameA2 = await first.frame(epochA2)
      assert(second.counts().refused > slowBefore.refused)
      assert.equal(second.counts().accepted, slowBefore.accepted)
      second.setRefuse(false)
      secondSubscription.flushPendingFrame()
      assert.equal(hash((await second.frame(epochA2)).image), hash(frameA2.image))
      firstSubscription.session.stop()
      await firstSubscription.session.done
      const stoppedCount = first.counts().accepted
      const epochA3 = await mark(a.browserPageId, 'PRODUCT PAGE A3', '#16599e')
      await second.frame(epochA3)
      assert.equal(first.counts().accepted, stoppedCount)
      firstSubscription.session.stop()
      await commands.browserTabClose({ page: a.browserPageId, worktree: 'owned' })
      await secondSubscription.session.done
      await assert.rejects(() => commands.browserScreencast({ page: a.browserPageId, worktree: 'owned', format: 'jpeg' },
        { sendBinary: first.sendBinary }))
      const epochB2 = await mark(b.browserPageId, 'PRODUCT PAGE B2', '#982d29')
      await otherPage.frame(epochB2)
      evidence.viewerIsolationAndTargetClose = true
    }
    evidence.frames = [{ page: 'A', hash: hash(frameA.image), metadata: frameA.metadata },
      { page: 'B', hash: hash(frameB.image), metadata: frameB.metadata }]
    evidence.viewerCounts = [first.counts(), second.counts(), otherPage.counts()]
    evidence.status = '제품 adapter의 지정 경계를 관측했습니다. 원 JPEG의 실제 표식은 Root가 별도로 확인해야 합니다.'
  } catch (error) {
    evidence.status = '지정 최초 경계에서 실패했습니다. 조건 완화 및 추가 실행은 하지 않습니다.'
    evidence.error = error instanceof Error ? { name: error.name, message: error.message } : { name: 'UnknownError' }
    throw error
  } finally {
    clearTimeout(overallTimer)
    for (const subscription of subscriptions) {subscription.session.stop()}
    await stopOwned()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    evidence.endedAt = new Date().toISOString()
    await writeFile(join(input.directory, 'fixture-result.json'), JSON.stringify(evidence, null, 2), { flag: 'wx', mode: 0o600 })
  }
  return evidence
}
