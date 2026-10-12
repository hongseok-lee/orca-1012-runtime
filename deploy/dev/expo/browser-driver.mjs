import { chromium } from 'playwright'
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const action = process.argv[2] ?? 'home'
const origin = process.env.ORCA_EXPO_ORIGIN ?? 'http://127.0.0.1:8081'
const artifacts = process.env.ORCA_BROWSER_ARTIFACTS ?? '/home/node/artifacts/expo'
await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: action === 'repo' ? 1 : 3,
  isMobile: action !== 'repo', hasTouch: action !== 'repo'
})
const page = await context.newPage()
const evidence = { kind: 'Expo Web Chromium, not native iPhone', browser: browser.version(),
  viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
  at: new Date().toISOString(), clicks: [], captures: [], backendSockets: [] }
page.on('websocket', (socket) => {
  const endpoint = new URL(socket.url())
  if (endpoint.hostname !== '127.0.0.1' || endpoint.port !== '16768') return
  const observed = { origin: endpoint.origin, sentFrames: 0, receivedFrames: 0, closed: false }
  evidence.backendSockets.push(observed)
  socket.on('framesent', () => observed.sentFrames++)
  socket.on('framereceived', () => observed.receivedFrames++)
  socket.on('close', () => { observed.closed = true })
})
try {
  if (action === 'repo') {
    const target = process.env.ORCA_REPO_CAPTURE_URL
    if (!target || !/^https:\/\/github\.com\/hongseok-lee\/orca-1012-runtime(?:\/|$)/.test(target)) {
      throw new Error('A public repository URL in the approved repository is required')
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    evidence.viewport = { width: 1440, height: 1000, deviceScaleFactor: 1 }
    await page.goto(target, { waitUntil: 'domcontentloaded' })
    const heading = process.env.ORCA_REPO_CAPTURE_HEADING
    if (heading) {
      await page.getByRole('heading', { name: heading, exact: true }).evaluate((element) => {
        element.scrollIntoView({ block: 'start', behavior: 'instant' })
        window.scrollBy({ top: -100, left: 0, behavior: 'instant' })
      })
      evidence.captureHeading = heading
      evidence.captureHeadingRect = await page.getByRole('heading', { name: heading, exact: true }).boundingBox()
      if (!evidence.captureHeadingRect || evidence.captureHeadingRect.y < 0 || evidence.captureHeadingRect.y > 400) {
        throw new Error('Capture heading is outside the readable viewport')
      }
    }
    evidence.kind = 'Public repository/infrastructure documentation capture'
    await page.screenshot({ path: path.join(artifacts, 'public-repository.png') })
    evidence.publicURL = target
    evidence.captures.push('public-repository.png')
  } else {
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    evidence.crypto = await page.evaluate(async () => {
      let randomValuesCallSucceeded = false
      let subtleDigestSucceeded = false
      try { crypto.getRandomValues(new Uint8Array(16)); randomValuesCallSucceeded = true } catch {}
      try {
        subtleDigestSucceeded = (await crypto.subtle.digest('SHA-256', new TextEncoder().encode('orca-dev-probe'))).byteLength === 32
      } catch {}
      return { origin: location.origin, isSecureContext, subtleAvailable: !!globalThis.crypto?.subtle,
        randomValuesCallSucceeded, subtleDigestSucceeded }
    })
    await page.getByText('Pair Desktop', { exact: true }).waitFor({ timeout: 120000 })
    await page.screenshot({ path: path.join(artifacts, 'home.png') })
    evidence.captures.push('home.png')
    if (action === 'pair') {
      if (!evidence.crypto.isSecureContext || !evidence.crypto.subtleAvailable ||
          !evidence.crypto.randomValuesCallSucceeded || !evidence.crypto.subtleDigestSucceeded) {
        evidence.failureReason = 'localhost-webcrypto-qualification-failed'
        throw new Error('localhost WebCrypto qualification failed')
      }
      const offerPath = process.env.ORCA_PRIVATE_PAIRING_FILE
      if (!offerPath) throw new Error('A private pairing file is required')
      const offer = (await readFile(offerPath, 'utf8')).trim()
      await page.getByText('Pair Desktop', { exact: true }).click()
      evidence.clicks.push('Pair Desktop')
      await page.getByText('Paste code instead', { exact: true }).click()
      evidence.clicks.push('Paste code instead')
      await page.getByPlaceholder('orca://pair?code=... or paste the code').fill(offer)
      await page.getByText('Save', { exact: true }).click()
      evidence.clicks.push('Save private pairing input; no capture')
      await page.getByRole('button', { name: 'Open sessions in Chat UI', exact: true }).waitFor({ timeout: 60000 })
      await page.screenshot({ path: path.join(artifacts, 'onboarding.png') })
      evidence.captures.push('onboarding.png')
      await page.getByRole('button', { name: 'Open sessions in Chat UI', exact: true }).click()
      evidence.clicks.push('Use Chat UI')
      const skip = page.getByRole('button', { name: 'Skip notifications for now', exact: true })
      await Promise.race([
        skip.waitFor({ state: 'visible', timeout: 60000 }),
        page.waitForURL(/\/h\/[^/?#]+$/, { timeout: 60000 })
      ])
      if (await skip.isVisible()) { await skip.click(); evidence.clicks.push('Not now') }
      await page.waitForURL(/\/h\/[^/?#]+$/, { timeout: 60000 })
      const catalogError = page.getByText('Could not load workspaces from this host', { exact: true })
      const empty = page.getByText('No worktrees', { exact: true })
      const workspaceName = process.env.ORCA_EXPECTED_WORKSPACE_NAME
      const outcomes = [
        catalogError.waitFor({ state: 'visible', timeout: 60000 }).then(() => 'error'),
        empty.waitFor({ state: 'visible', timeout: 60000 }).then(() => 'empty')
      ]
      if (workspaceName) {
        outcomes.push(page.getByText(workspaceName, { exact: true })
          .waitFor({ state: 'visible', timeout: 60000 }).then(() => 'workspace'))
      }
      const settled = await Promise.race(outcomes)
      evidence.catalogError = settled === 'error' || await catalogError.isVisible()
      if (evidence.catalogError) {
        evidence.failureReason = 'authenticated-catalog-error'
        throw new Error('Catalog failed')
      }
      const socket = evidence.backendSockets.find((item) => item.sentFrames > 0 && item.receivedFrames > 0)
      if (!socket) {
        evidence.failureReason = 'browser-backend-socket-not-observed'
        throw new Error('Browser backend socket was not observed')
      }
      evidence.authenticatedCatalog = { settled: true, result: settled,
        basis: 'fresh browser profile; existing connected/loaded catalog UI' }
      evidence.hostScreenVisible = true
      evidence.emptyWorkspaceState = settled === 'empty'
      await page.screenshot({ path: path.join(artifacts, 'workspace.png') })
      evidence.captures.push('workspace.png')
    }
  }
  evidence.completed = true
  if (action === 'pair' && process.env.ORCA_OBSERVE_RECONNECT === '1') {
    const initialCount = evidence.backendSockets.length
    const checkpoint = path.join(artifacts, 'initial-pair-evidence.json')
    await writeFile(checkpoint, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
    await chmod(checkpoint, 0o600)
    const deadline = Date.now() + 30 * 60 * 1000
    let reconnected = false
    while (Date.now() < deadline) {
      const replacement = evidence.backendSockets.slice(initialCount)
        .find((socket) => socket.sentFrames > 0 && socket.receivedFrames > 0)
      if (replacement && evidence.backendSockets.slice(0, initialCount).some((socket) => socket.closed)) {
        const catalogError = page.getByText('Could not load workspaces from this host', { exact: true })
        const empty = page.getByText('No worktrees', { exact: true })
        const row = process.env.ORCA_EXPECTED_WORKSPACE_NAME
        if (await catalogError.isVisible()) {
          evidence.failureReason = 'catalog-error-after-reconnect'
          throw new Error('Catalog failed after reconnect')
        }
        if (await empty.isVisible() || (row && await page.getByText(row, { exact: true }).isVisible())) {
          evidence.reconnect = { oldSocketClosed: true, replacementTrafficObserved: true,
            workspaceVisible: true, at: new Date().toISOString() }
          await page.screenshot({ path: path.join(artifacts, 'reconnected-workspace.png') })
          evidence.captures.push('reconnected-workspace.png')
          reconnected = true
          break
        }
      }
      await delay(500)
    }
    if (!reconnected) {
      evidence.failureReason = 'reconnect-observation-timeout'
      throw new Error('Reconnect observation timed out')
    }
  }
} catch (error) {
  // Errors may contain credential-bearing locators or URLs; keep them out of artifacts.
  evidence.completed = false
  evidence.failureType = error?.name ?? 'Error'
  process.exitCode = 1
} finally {
  await writeFile(path.join(artifacts, `${action}-evidence.json`), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
  await browser.close()
}
