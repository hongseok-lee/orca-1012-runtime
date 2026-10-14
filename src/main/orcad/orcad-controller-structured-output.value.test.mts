import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { captureOrcadControllerConfig, readOrcadControllerConfig, OrcadControllerConfigurationError } from './orcad-controller-config.ts'

if (process.env.ORCA_STRUCTURED_STARTUP_APPROVED !== 'root-ready') {
  throw new Error('Root의 source 리뷰 및 최초 실행 배분이 필요합니다.')
}

await test('structured 출력 선택 설정은 부재 시 원 형태를 유지하고 strict scalar를 동기 복사한다', () => {
  const base = { datasetName: 'orca-1012-dev-v1', inventory: { apiOrigin: 'https://127.0.0.1:1',
    namespace: 'fixture-output', dataset: 'orca-1012-dev-v1', caFile: '/synthetic/ca.pem', tokenFile: '/synthetic/token',
    requestTimeoutMs: 1000, watchTimeoutSeconds: 1, listLimit: 10 }, policy: {
    lease: { revision: 'structured-startup-fixture-v1', durationMs: 5000 }, renewIntervalMs: 1000,
    standbyPollIntervalMs: 50, passPollIntervalMs: 60000, maximumWork: 1, externalBudgetMs: 3000 } }
  const old = process.env.ORCA_DURABLE_CONTROLLER_CONFIG
  const dir = mkdtempSync(path.join(tmpdir(), 'orca-controller-structured-value-')), configPath = `${dir}/controller.json`
  const safe = (error: unknown): boolean => error instanceof OrcadControllerConfigurationError &&
    error.code === error.message && /^CONTROLLER_[A-Z0-9_]+$/u.test(error.message) && !error.message.includes(dir)
  try {
    delete process.env.ORCA_DURABLE_CONTROLLER_CONFIG
    assert.equal(readOrcadControllerConfig(), null)
    const absent = captureOrcadControllerConfig(base)
    assert.equal(Object.hasOwn(absent, 'structuredOutput'), false)
    const input = { ...base, structuredOutput: { claimDurationMs: 1000 } }
    const captured = captureOrcadControllerConfig(input)
    input.structuredOutput.claimDurationMs = 1
    assert.equal(captured.structuredOutput?.claimDurationMs, 1000)
    assert.ok(Object.isFrozen(captured.structuredOutput))
    for (const claimDurationMs of [1, 2147483647]) {
      assert.equal(captureOrcadControllerConfig({ ...base, structuredOutput: { claimDurationMs } }).structuredOutput?.claimDurationMs, claimDurationMs)
    }
    for (const claimDurationMs of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER, 2147483648, '1000', null, undefined]) {
      assert.throws(() => captureOrcadControllerConfig({ ...base, structuredOutput: { claimDurationMs } }), safe)
    }
    for (const structuredOutput of [null, undefined, [], {}, true, { claimDurationMs: 1000, term: '1' },
      { claimDurationMs: 1000, [Symbol('unknown')]: true }]) {
      assert.throws(() => captureOrcadControllerConfig({ ...base, structuredOutput }), safe)
    }
    let getterCalls = 0
    const nestedAccessor = Object.defineProperty({}, 'claimDurationMs', { enumerable: true, get() { getterCalls++; return 1000 } })
    const topAccessor = Object.defineProperty({ ...base }, 'structuredOutput', { enumerable: true, get() { getterCalls++; return { claimDurationMs: 1000 } } })
    assert.throws(() => captureOrcadControllerConfig({ ...base, structuredOutput: nestedAccessor }), safe)
    assert.throws(() => captureOrcadControllerConfig(topAccessor), safe)
    assert.equal(getterCalls, 0)
    assert.throws(() => captureOrcadControllerConfig({ ...input, unknown: true }), safe)
    process.env.ORCA_DURABLE_CONTROLLER_CONFIG = configPath
    writeFileSync(configPath, JSON.stringify({ ...base, structuredOutput: { claimDurationMs: 1000 } }), { mode: 0o600 })
    assert.equal(readOrcadControllerConfig()?.structuredOutput?.claimDurationMs, 1000)
    writeFileSync(configPath, JSON.stringify({ ...base, structuredOutput: { claimDurationMs: 1000 } })
      .replace('"claimDurationMs":1000', '"claimDurationMs":1000,"claimDurationMs":2000'))
    assert.throws(readOrcadControllerConfig, error => safe(error) && error instanceof OrcadControllerConfigurationError &&
      error.code === 'CONTROLLER_STARTUP_DUPLICATE_KEY')
  } finally {
    if (old === undefined) { delete process.env.ORCA_DURABLE_CONTROLLER_CONFIG } else { process.env.ORCA_DURABLE_CONTROLLER_CONFIG = old }
    rmSync(dir, { recursive: true, force: true })
  }
})
