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
if (result.newBoundaries.pass !== 3 || result.changedOldTarget.pass !== 1 ||
    result.newBoundaries.fail !== 0 || result.changedOldTarget.fail !== 0 ||
    result.newBoundaries.skipped !== 0 || result.changedOldTarget.skipped !== 0 ||
    result.typecheck !== 'PASS' || result.lint !== 'PASS') throw new Error('보고서의 실제 결과가 기대한 focused 단계와 다릅니다.')
const html = `<!doctype html><meta charset="utf-8"><style>
body{font:18px system-ui;margin:32px;color:#19304a;background:#f5f8fc}h1{font-size:30px}section{background:white;padding:18px;border:1px solid #d5dfe8;border-radius:8px;margin:16px 0}h2{font-size:22px;color:#165d39}p{line-height:1.6}code{font-size:13px}small{color:#42576b}
</style><h1>P1-11 Codex ownership 교정의 첫 focused 검증 결과</h1>
<p>원격 browser가 저장된 실제 fixture 결과를 렌더링한 보고서입니다.<br>제품 UI나 실제 계정 provider 실행을 보여 주는 캡처가 아닙니다.</p>
<section><h2>새 3개와 수정 1개가 첫 실행에서 통과했습니다.</h2>
<p>동시 open 2회에서 transport 1개를 확인했습니다.<br>미종료·UNKNOWN turn의 원 ownership과 terminal 경계를 확인했습니다.<br>먼저 확인한 descendants 종료와 늦은 terminal의 재조회를 확인했습니다.<br>첫 turn 완료 뒤 새 turn에서 옛 target의 효과가 0회였습니다.</p>
<p>실패 0개, skip 0개입니다.<br>기존 전체 22개는 반복하지 않았습니다.</p>
<small>Node ${result.node} · TypeScript ${result.typescript} · esbuild ${result.esbuild}</small></section>
<section><h2>타입과 lint는 통과했고 원 실패를 보존했습니다.</h2>
<p>최초 lint는 curly 58건과 unsafe optional chaining 1건으로 실패했습니다.<br>중괄호와 fixture wire guard만 교정했습니다.<br>통과한 focused 4개는 재실행하지 않았습니다.</p>
<small>configured oxlint ${result.oxlint} · 최종 오류 0개, 경고 0개입니다.</small></section>
<section><h2>수락·UNKNOWN·취소의 증거를 분리했습니다.</h2>
<p>write ACK나 응답 유실만으로 수락/context proof를 만들지 않습니다.<br>동일 request의 자동 재호출은 0회입니다.<br>정확한 native receipt에 원 binding/delivery/context hash를 연결했습니다.<br>interrupt ACK는 미확정이며 새 turn에 옛 baseline을 사용하지 않습니다.</p></section>
<section><h2>실제 provider와 영속 합류는 미확인입니다.</h2>
<p>실제 inference/auth/native resume·writer fencing을 수행하지 않았습니다.<br>상위 COMMIT/소유권 permit과 PG append/producer ACK는 미연결입니다.<br>data URL 이미지 수락과 native descendants 종료는 미확인입니다.</p>
<small>최초 시험 <code>${result.testedCodeRevision}</code><br>최종 스타일 <code>${result.finalStyleRevision}</code><br>검증 main <code>${result.verificationMain}</code></small></section>`
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1120, height: 1420 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  await page.setContent(html)
  const headings = await page.locator('h2').allTextContents()
  const heading = await page.locator('h1').textContent()
  if (heading !== result.captureHeading) throw new Error('보고서의 실제 heading이 예상한 문장과 다릅니다.')
  const png = join(outputDirectory, 'results.png')
  await page.screenshot({ path: png, fullPage: true })
  const sha = bytes => createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(outputDirectory, 'provenance.json'), JSON.stringify({
    kind: '원격 browser가 저장된 실제 fixture 결과를 렌더링한 최초 보고 캡처입니다.',
    actualUrl: 'about:blank (setContent)', capturedAt: new Date().toISOString(),
    browser: await browser.version(), playwright: require('playwright/package.json').version,
    viewport: { width: 1120, height: 1420 }, deviceScaleFactor: 1, heading, headings,
    freshUnauthenticatedContext: true,
    inputSha256: sha(input), pngSha256: sha(await readFile(png)),
    testedCodeRevision: result.testedCodeRevision, finalStyleRevision: result.finalStyleRevision,
    boundary: '제품 UI·실제 계정 provider·native iPhone 증거가 아닙니다. 시험을 재실행하지 않았습니다.'
  }, null, 2) + '\n', { mode: 0o600 })
} finally { await browser.close() }
