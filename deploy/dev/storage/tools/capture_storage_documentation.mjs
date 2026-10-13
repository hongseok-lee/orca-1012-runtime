import { mkdir, writeFile, chmod } from 'node:fs/promises'
import path from 'node:path'

const [url, revision, output] = process.argv.slice(2)
const parsed = new URL(url)
if (!/^[a-f0-9]{40}$/.test(revision) || parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' || parsed.username || parsed.password || parsed.search ||
    parsed.pathname !== `/hongseok-lee/orca-1012-runtime/blob/${revision}/deploy/dev/storage/RECOVERY.md`) {
  throw new Error('Expected the exact pinned public recovery documentation URL.')
}
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
await mkdir(output, { recursive: true, mode: 0o700 })
const browser = await chromium.launch({ headless: true })
try {
  const viewport = { width: 1440, height: 1400 }
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
  if (!response?.ok()) throw new Error('Public documentation request did not succeed.')
  const heading = page.locator('.markdown-body h2').filter({ hasText: 'Actual observations' }).first()
  await heading.waitFor({ state: 'visible', timeout: 15000 })
  await heading.evaluate((element) => element.scrollIntoView({ block: 'start' }))
  await page.evaluate(() => window.scrollBy(0, -240))
  await page.waitForTimeout(600)
  const rect = await heading.boundingBox()
  if (!rect || rect.y < 0 || rect.y > viewport.height - 400) {
    throw new Error('Actual observation heading is not in the capture viewport.')
  }
  const artifact = path.join(output, 'p1-01-recovery-documentation.png')
  await page.screenshot({ path: artifact, fullPage: false })
  await chmod(artifact, 0o600)
  const provenance = {
    kind: 'Actual remote-browser infrastructure recovery documentation; not product/HA qualification',
    url, capturedTargetSourceSHA: revision, capturedAtUTC: new Date().toISOString(),
    browser: browser.version(), viewport: { ...viewport, deviceScaleFactor: 1 },
    heading: 'Actual observations', headingY: rect.y, freshUnauthenticatedContext: true,
    artifact: path.basename(artifact), remoteExecution: true
  }
  const metadata = path.join(output, 'p1-01-recovery-documentation-provenance.json')
  await writeFile(metadata, JSON.stringify(provenance, null, 2) + '\n', { mode: 0o600 })
  console.log('Captured public recovery documentation with an unauthenticated remote browser.')
} finally {
  await browser.close()
}
