import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

// Existing remote browser package only; no login, install, or product UI.
const [packageJson, inputPath, outputDirectory] = process.argv.slice(2)
const require = createRequire(packageJson)
const { chromium } = require('playwright')
const input = await readFile(inputPath)
const result = JSON.parse(input)
if (result.checks.protocol.pass !== 9 || result.checks.sharedDriver.pass !== 11 ||
    result.checks.wireFocused.pass !== 1 || result.checks.nativeWrapper.pass !== 1 ||
    result.checks.typecheck.state !== 'PASS') throw new Error('보고서의 실제 결과가 기대한 검증 단계와 다릅니다.')
const html = `<!doctype html><meta charset="utf-8"><style>
body{font:18px system-ui;margin:32px;color:#19304a;background:#f5f8fc}h1{font-size:30px}section{background:white;padding:18px;border:1px solid #d5dfe8;border-radius:8px;margin:16px 0}h2{font-size:22px;color:#165d39}p{line-height:1.6}code{font-size:13px}small{color:#42576b}
</style><h1>P1-11 Codex shared 연결 검증 결과</h1>
<p>원격 browser가 저장된 실제 fixture 결과를 렌더링한 보고서입니다.<br>제품 UI나 실제 계정 provider 실행을 보여 주는 캡처가 아닙니다.</p>
<section><h2>기존 9개와 추가 11개 결과를 구분했습니다.</h2>
<p>기존 protocol 9개를 재사용했습니다.<br>shared 연결 driver 11개와 native wrapper 1개가 통과했습니다.<br>wire params 전체 hash 교정은 새 fixture 1개만 확인했습니다.</p>
<p>전용 TypeScript 검사는 통과했습니다.<br>최종 revision에서 전체 22개를 재실행했다고 주장하지 않습니다.</p>
<small>Node ${result.node} · TypeScript ${result.typescript} · esbuild ${result.esbuild}</small></section>
<section><h2>수락·UNKNOWN·취소의 증거를 분리했습니다.</h2>
<p>write ACK나 응답 유실만으로 수락/context proof를 만들지 않습니다.<br>동일 request의 자동 재호출은 0회입니다.<br>정확한 native receipt에 원 binding/delivery/context hash를 연결했습니다.<br>interrupt ACK는 미확정이며 새 turn에 옛 baseline을 사용하지 않습니다.</p></section>
<section><h2>실제 provider와 영속 합류는 미확인입니다.</h2>
<p>실제 inference/auth/native resume·writer fencing을 수행하지 않았습니다.<br>상위 COMMIT/소유권 permit과 PG append/producer ACK는 미연결입니다.<br>data URL 이미지 수락과 native descendants 종료는 미확인입니다.</p>
<small>구현 <code>${result.implementationRevision}</code><br>shared <code>${result.sharedRevision}</code><br>DB 선행 <code>${result.dbPredecessor}</code></small></section>`
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 1220 }, deviceScaleFactor: 1 })
  await page.setContent(html)
  const headings = await page.locator('h2').allTextContents()
  const png = join(outputDirectory, 'results.png')
  await page.screenshot({ path: png, fullPage: true })
  const sha = bytes => createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(outputDirectory, 'provenance.json'), JSON.stringify({
    kind: '원격 browser가 저장된 실제 fixture 결과를 렌더링한 최초 보고 캡처입니다.',
    actualUrl: 'about:blank (setContent)', capturedAt: new Date().toISOString(),
    browser: await browser.version(), playwright: require('playwright/package.json').version,
    viewport: { width: 1120, height: 1220 }, deviceScaleFactor: 1, headings,
    inputSha256: sha(input), pngSha256: sha(await readFile(png)),
    implementationRevision: result.implementationRevision,
    boundary: '제품 UI·실제 계정 provider·native iPhone 증거가 아닙니다. 시험을 재실행하지 않았습니다.'
  }, null, 2) + '\n', { mode: 0o600 })
} finally { await browser.close() }
