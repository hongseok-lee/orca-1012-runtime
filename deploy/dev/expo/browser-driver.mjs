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
const privatePageErrors = []
page.on('pageerror', (error) => privatePageErrors.push({ at: new Date().toISOString(),
  name: error.name, message: error.message, stack: error.stack }))
page.on('console', async (message) => {
  // Only the existing caught pairing exception, never general console/payload logs.
  if (!message.text().startsWith('[pair] connect failed')) return
  privatePageErrors.push({ at: new Date().toISOString(), name: 'caught-pairing-exception',
    message: message.text() })
  await writeFile(path.join(artifacts, 'private-browser-errors.json'),
    JSON.stringify(privatePageErrors, null, 2) + '\n', { mode: 0o600 })
})
async function observeUiAndPersistence() {
  const observed = await page.evaluate(() => {
    const pathname = location.pathname
    const route = ['/', '/pair-scan', '/pair-confirm', '/mobile-onboarding'].includes(pathname)
      ? pathname : /^\/h\/[^/]+/.test(pathname) ? '/h/[hostId]' : 'other-route'
    const labels = ['Open sessions in Chat UI', 'Skip notifications for now', 'Continue',
      'Paste code instead', 'Save', 'Use Chat UI', 'Not now']
    const controls = [...document.querySelectorAll('button,[role="button"]')]
    const visibleControls = labels.filter((label) => controls.some((element) => {
      const name = element.getAttribute('aria-label') ?? element.textContent?.trim()
      const rect = element.getBoundingClientRect()
      return name === label && rect.width > 0 && rect.height > 0
    }))
    const text = document.body.innerText
    const hostRaw = localStorage.getItem('orca:hosts')
    let hostsFormat = hostRaw === null ? 'absent' : 'invalid-json'
    let hostCount = 0
    let metadataShapeValid = false
    if (hostRaw !== null) {
      try {
        const hosts = JSON.parse(hostRaw)
        hostsFormat = Array.isArray(hosts) ? 'array' : typeof hosts
        if (Array.isArray(hosts)) {
          hostCount = hosts.length
          metadataShapeValid = hosts.every((host) => host && typeof host.id === 'string' &&
            typeof host.endpoint === 'string' && typeof host.publicKeyB64 === 'string' &&
            !Object.hasOwn(host, 'deviceToken'))
        }
      } catch {}
    }
    const tokenKeys = Object.keys(localStorage).filter((key) => key.startsWith('orca:web-host-token:'))
    return { route, visibleRoleButtons: visibleControls,
      visibleLabels: labels.filter((label) => [...document.querySelectorAll('*')].some((element) => {
        if (element.textContent?.trim() !== label) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' &&
          rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth
      })), pairingFailureVisible: text.includes('Pairing failed:'),
      pairingTimeoutVisible: text.includes("Couldn't connect within"),
      permissionFallbackVisible: text.includes('Pair with desktop') || text.includes('Camera Access Disabled'),
      persistence: { hostsPresent: hostRaw !== null, hostsFormat, hostCount, metadataShapeValid,
        tokenEntryCount: tokenKeys.length,
        tokenEntriesNonempty: tokenKeys.length > 0 && tokenKeys.every((key) => !!localStorage.getItem(key)) } }
  })
  await writeFile(path.join(artifacts, 'ui-persistence-status.json'),
    JSON.stringify({ at: new Date().toISOString(), ...observed, backendSockets: evidence.backendSockets,
      handshakeMarkers: evidence.handshakeMarkers }, null, 2) + '\n', { mode: 0o600 })
}
let uiObserver
let caughtExceptionDiagnostics
if (process.env.ORCA_DIAGNOSE_CAUGHT_EXCEPTION === '1') {
  const cdp = await context.newCDPSession(page)
  const scriptURLs = new Map()
  cdp.on('Debugger.scriptParsed', (event) => scriptURLs.set(event.scriptId, event.url))
  caughtExceptionDiagnostics = { enabled: true, caughtPauses: 0, illegalInvocation: [] }
  cdp.on('Debugger.paused', async (event) => {
    caughtExceptionDiagnostics.caughtPauses++
    // Inspect only exception class/known message and code locations. No locals/payloads.
    const illegal = event.data?.className === 'TypeError' &&
      event.data?.description?.includes('Illegal invocation')
    const frames = illegal ? event.callFrames.map((frame) => ({
      file: frame.url || scriptURLs.get(frame.location.scriptId), methodName: frame.functionName,
      lineNumber: frame.location.lineNumber + 1,
      column: frame.location.columnNumber + 1
    })) : null
    await cdp.send('Debugger.resume').catch(() => {})
    if (!illegal) return
    const safe = { name: 'TypeError', message: 'Illegal invocation', at: new Date().toISOString(),
      frames: [] }
    try {
      const response = await fetch(`${origin}/symbolicate`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stack: frames }) })
      const result = await response.json()
      safe.frames = (result.stack ?? []).filter((frame) =>
        frame.file?.startsWith('/tmp/orca-expo-local/')).map((frame) => ({
          file: frame.file.replace('/tmp/orca-expo-local/', ''),
          methodName: frame.methodName, lineNumber: frame.lineNumber, column: frame.column
        }))
    } catch {}
    // A failed source-map lookup is recorded without raw bundle URLs or script contents.
    safe.symbolicated = safe.frames.length > 0
    safe.generatedPositions = frames.map(({ lineNumber, column }) => ({ lineNumber, column }))
    caughtExceptionDiagnostics.illegalInvocation.push(safe)
    await writeFile(path.join(artifacts, 'caught-exception-evidence.json'),
      JSON.stringify(caughtExceptionDiagnostics, null, 2) + '\n', { mode: 0o600 })
  })
  await cdp.send('Debugger.enable')
  await cdp.send('Debugger.setPauseOnExceptions', { state: 'all' })
}
const evidence = { kind: 'Expo Web Chromium, not native iPhone', browser: browser.version(),
  viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
  at: new Date().toISOString(), clicks: [], captures: [], backendSockets: [], handshakeMarkers: [] }
page.on('console', (message) => {
  const known = ['[net] ws.onopen', '[net] handshake-timeout fired (e2ee_authenticated never arrived)',
    '[net] e2ee auth FAILED', '[net] mobile capability negotiation could not be sent',
    '[net] mobile capability negotiation unanswered', '[net] mobile capability negotiation unavailable']
  const marker = known.find((item) => message.text().startsWith(item))
  if (marker) evidence.handshakeMarkers.push({ marker, at: new Date().toISOString() })
})
page.on('websocket', (socket) => {
  const endpoint = new URL(socket.url())
  if (endpoint.hostname !== '127.0.0.1' || endpoint.port !== '16768') return
  const observed = { origin: endpoint.origin, sentFrames: 0, receivedFrames: 0, closed: false, frameKinds: [] }
  evidence.backendSockets.push(observed)
  function kind(frame) {
    if (typeof frame.payload !== 'string') return 'binary-envelope'
    try {
      const type = JSON.parse(frame.payload).type
      if (['e2ee_hello', 'e2ee_ready', 'e2ee_authenticated', 'e2ee_error'].includes(type)) return type
      return 'other-json-envelope'
    } catch { return 'encrypted-text-envelope' }
  }
  socket.on('framesent', (frame) => {
    observed.sentFrames++
    observed.frameKinds.push({ direction: 'sent', kind: kind(frame) })
  })
  socket.on('framereceived', (frame) => {
    observed.receivedFrames++
    observed.frameKinds.push({ direction: 'received', kind: kind(frame) })
  })
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
    evidence.phase = 'initial-web-navigation'
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 300000 })
    evidence.phase = 'home-render'
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
      const validityPath = process.env.ORCA_PRIVATE_OFFER_VALIDITY_FILE
      const validity = validityPath ? JSON.parse(await readFile(validityPath, 'utf8')) : null
      if (validity?.valid !== true || validity?.registryMatch !== true) {
        evidence.failureReason = 'offer-validity-not-confirmed-before-save'
        throw new Error('Offer validity metadata is required before Save')
      }
      evidence.offerValidity = { valid: true, registryMatch: true, pending: validity.pending, checkedAt: validity.checkedAt,
        directTimeExpiryApplied: false }
      await page.getByText('Save', { exact: true }).click()
      evidence.clicks.push('Save private pairing input; no capture')
      evidence.phase = 'pair-save-to-onboarding'
      await observeUiAndPersistence()
      uiObserver = setInterval(() => { observeUiAndPersistence().catch(() => {}) }, 2000)
      await writeFile(path.join(artifacts, 'pair-progress.json'),
        JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
      const pairingError = page.getByText(/^Pairing failed:/).first()
      const pairingOutcome = await Promise.race([
        page.getByRole('button', { name: 'Open sessions in Chat UI', exact: true })
          .waitFor({ timeout: 60000 }).then(() => 'onboarding'),
        pairingError.waitFor({ timeout: 60000 }).then(() => 'ui-error')
      ])
      if (pairingOutcome === 'ui-error') {
        const errorPath = path.join(artifacts, 'private-pairing-ui-error.json')
        await writeFile(errorPath, JSON.stringify({ at: new Date().toISOString(),
          error: await pairingError.innerText() }, null, 2) + '\n', { mode: 0o600 })
        evidence.failureReason = 'normal-pairing-ui-error'
        throw new Error('Normal pairing UI reported an error; details remain private')
      }
      evidence.phase = 'onboarding'
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
    const checkpoint = path.join(artifacts, 'initial-pair-evidence.json')
    await writeFile(checkpoint, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
    await chmod(checkpoint, 0o600)
    const stages = ['1새runner채택', '2임시source변경watch', '3source원복watch']
    const backendEvidenceDir = process.env.ORCA_PRIVATE_RECONNECT_EVIDENCE_DIR
    if (!backendEvidenceDir) throw new Error('Private backend stage evidence directory is required')
    let previousBackendPid = Number(process.env.ORCA_INITIAL_BACKEND_PID)
    evidence.reconnects = []
    for (let cycle = 1; cycle <= stages.length; cycle++) {
      const stage = stages[cycle - 1]
      const initialCount = evidence.backendSockets.length
      const activeSocket = evidence.backendSockets
        .filter((socket) => !socket.closed && socket.sentFrames > 0 && socket.receivedFrames > 0).at(-1)
      const deadline = Date.now() + 30 * 60 * 1000
      let reconnected = false
      while (Date.now() < deadline) {
        const replacement = evidence.backendSockets.slice(initialCount)
          .find((socket) => !socket.closed && socket.sentFrames > 0 && socket.receivedFrames > 0)
        let proof = null
        try { proof = JSON.parse(await readFile(path.join(backendEvidenceDir, `stage-${cycle}.json`), 'utf8')) } catch {}
        const backend = proof && { stage: proof.stage, pid: proof.pid ?? proof.childPid ?? proof.childPID,
          generation: proof.generation, hash: proof.hash ?? proof.bundleHash ?? proof.bundleSha256,
          encryptedApiPassed: proof.encryptedApiPassed ?? proof.encryptedStatusGetPassed ?? proof.encryptedAPI }
        const backendReady = backend?.stage === stage && Number.isInteger(backend.pid) && backend.pid > 0 &&
          backend.pid !== previousBackendPid && Number.isInteger(backend.generation) &&
          /^[a-f0-9]{64}$/.test(backend.hash ?? '') && backend.encryptedApiPassed === true
        if (replacement && activeSocket?.closed && backendReady) {
          const catalogError = page.getByText('Could not load workspaces from this host', { exact: true })
          const empty = page.getByText('No worktrees', { exact: true })
          const row = process.env.ORCA_EXPECTED_WORKSPACE_NAME
          if (await catalogError.isVisible()) {
            evidence.failureReason = 'catalog-error-after-reconnect'
            throw new Error('Catalog failed after reconnect')
          }
          if (await empty.isVisible() || (row && await page.getByText(row, { exact: true }).isVisible())) {
            evidence.reconnects.push({ cycle, stage, backend, oldSocketClosed: true, replacementTrafficObserved: true,
              workspaceVisible: true, at: new Date().toISOString() })
            const filename = `reconnected-workspace-${cycle}.png`
            await page.screenshot({ path: path.join(artifacts, filename) })
            evidence.captures.push(filename)
            await writeFile(path.join(artifacts, `reconnect-${cycle}-evidence.json`),
              JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
            previousBackendPid = backend.pid
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
  }
} catch (error) {
  // Errors may contain credential-bearing locators or URLs; keep them out of artifacts.
  evidence.completed = false
  evidence.failureType = error?.name ?? 'Error'
  process.exitCode = 1
} finally {
  clearInterval(uiObserver)
  await observeUiAndPersistence().catch(() => {})
  if (privatePageErrors.length) {
    // Private debugging input only: never publish raw stacks or credential URLs.
    await writeFile(path.join(artifacts, 'private-browser-errors.json'),
      JSON.stringify(privatePageErrors, null, 2) + '\n', { mode: 0o600 })
  }
  await writeFile(path.join(artifacts, `${action}-evidence.json`), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
  // Publication is filename-allowlisted; private exception/offer/log files never enter it.
  const safeEvidence = [`${action}-evidence.json`, 'ui-persistence-status.json', 'pair-progress.json',
    'initial-pair-evidence.json', ...[1, 2, 3].map((cycle) => `reconnect-${cycle}-evidence.json`)]
  await writeFile(path.join(artifacts, 'public-artifact-allowlist.json'),
    JSON.stringify({ candidates: [...evidence.captures, ...safeEvidence],
      requiresCredentialFreeReview: true, excludesPrivateDebugFiles: true }, null, 2) + '\n', { mode: 0o600 })
  await browser.close()
}
