import { chromium } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const action = process.argv[2] ?? 'home'
const origin = process.env.ORCA_EXPO_ORIGIN ?? 'http://127.0.0.1:8081'
const artifacts = process.env.ORCA_BROWSER_ARTIFACTS ?? '/home/node/artifacts/expo'
await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
  isMobile: true, hasTouch: true
})
const page = await context.newPage()
const evidence = { kind: 'Expo Web Chromium, not native iPhone', browser: browser.version(),
  viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
  at: new Date().toISOString(), clicks: [], captures: [], backendSockets: [] }
page.on('websocket', (socket) => {
  const endpoint = new URL(socket.url())
  if (endpoint.hostname !== '127.0.0.1' || endpoint.port !== '16768') return
  const observed = { origin: endpoint.origin, sentFrames: 0, receivedFrames: 0 }
  evidence.backendSockets.push(observed)
  socket.on('framesent', () => observed.sentFrames++)
  socket.on('framereceived', () => observed.receivedFrames++)
})
try {
  if (action === 'repo') {
    const target = process.env.ORCA_REPO_CAPTURE_URL
    if (!target || !/^https:\/\/github\.com\/hongseok-lee\/orca-1012-runtime(?:\/|$)/.test(target)) {
      throw new Error('A public repository URL in the approved repository is required')
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    evidence.viewport = { width: 1440, height: 1000, deviceScaleFactor: 3 }
    await page.goto(target, { waitUntil: 'domcontentloaded' })
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
} catch (error) {
  // Errors may contain credential-bearing locators or URLs; keep them out of artifacts.
  evidence.completed = false
  evidence.failureType = error?.name ?? 'Error'
  process.exitCode = 1
} finally {
  await writeFile(path.join(artifacts, `${action}-evidence.json`), JSON.stringify(evidence, null, 2) + '\n')
  await browser.close()
}
