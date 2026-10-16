import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute, normalize } from 'node:path'
import process from 'node:process'
import type { ControllerWorkerPolicy } from '../durable-runtime/ha/worker.ts'
import { OrcadDurableCatalogConfigurationError } from './orcad-durable-catalog.ts'

const fileLimit = 1024 * 1024
const dataset = 'orca-1012-dev-v1'
export type OrcadControllerConfig = Readonly<{
  datasetName: typeof dataset
  inventory: Readonly<{ apiOrigin: string; namespace: string; dataset: typeof dataset; caFile: string; tokenFile: string
    requestTimeoutMs: number; watchTimeoutSeconds: number; listLimit: number }>
  policy: ControllerWorkerPolicy
  structuredOutput?: Readonly<{ claimDurationMs: number }>
  firstManagedInitial?: Readonly<{ configFile: string }>
}>
export class OrcadControllerConfigurationError extends OrcadDurableCatalogConfigurationError {
  constructor(code = 'CONTROLLER_STARTUP_CONFIG') {
    // Only internal fixed codes may survive this error boundary, never a file/HTTP error message.
    super(/^CONTROLLER_[A-Z0-9_]{1,80}$/.test(code) ? code : 'CONTROLLER_STARTUP_UNAVAILABLE')
    this.name = 'OrcadControllerConfigurationError'
  }
}
export function invalidOrcadControllerConfig(code = 'CONTROLLER_STARTUP_CONFIG'): never {
  throw new OrcadControllerConfigurationError(code)
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))) { invalidOrcadControllerConfig() }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) { invalidOrcadControllerConfig() }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Plain own data fields checked above; every value remains unknown.
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  // oxlint-disable-next-line eslint/no-control-regex -- SAFETY: Explicitly reject control characters in private configuration text.
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalidOrcadControllerConfig()
  }
  return value
}
function absolute(value: unknown): string {
  const path = text(value)
  if (!isAbsolute(path) || normalize(path) !== path) { invalidOrcadControllerConfig() }
  return path
}
function positive(value: unknown, timerBound = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
      (timerBound && value > 2_147_483_647)) { invalidOrcadControllerConfig() }
  return value
}
function apiOrigin(value: unknown): string {
  const input = text(value)
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        (input !== url.origin && input !== `${url.origin}/`)) { invalidOrcadControllerConfig() }
    return url.origin
  } catch { return invalidOrcadControllerConfig() }
}

/** All keys/scalars/policies detach synchronously. No Pool, token, external identity or config default is accepted. */
export function captureOrcadControllerConfig(value: unknown): OrcadControllerConfig {
  const hasStructuredOutput = value !== null && typeof value === 'object' && Object.hasOwn(value, 'structuredOutput')
  const hasFirstManagedInitial = value !== null && typeof value === 'object' && Object.hasOwn(value, 'firstManagedInitial')
  const input = record(value, ['datasetName', 'inventory', 'policy',
    ...(hasStructuredOutput ? ['structuredOutput'] : []), ...(hasFirstManagedInitial ? ['firstManagedInitial'] : [])])
  const structuredOutput = hasStructuredOutput
    ? Object.freeze({ claimDurationMs: positive(record(input.structuredOutput, ['claimDurationMs']).claimDurationMs, true) })
    : undefined
  const firstManagedInitial = hasFirstManagedInitial
    ? Object.freeze({ configFile: absolute(record(input.firstManagedInitial, ['configFile']).configFile) })
    : undefined
  const inventory = record(input.inventory, ['apiOrigin', 'namespace', 'dataset', 'caFile', 'tokenFile',
    'requestTimeoutMs', 'watchTimeoutSeconds', 'listLimit'])
  const policy = record(input.policy, ['lease', 'renewIntervalMs', 'standbyPollIntervalMs', 'passPollIntervalMs', 'maximumWork', 'externalBudgetMs'])
  const lease = record(policy.lease, ['revision', 'durationMs'])
  if (input.datasetName !== dataset || inventory.dataset !== dataset) { invalidOrcadControllerConfig('CONTROLLER_STARTUP_DATASET') }
  const namespace = text(inventory.namespace), revision = text(lease.revision)
  if (namespace.length > 63 || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u.test(namespace) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(revision)) { invalidOrcadControllerConfig() }
  const durationMs = positive(lease.durationMs), renewIntervalMs = positive(policy.renewIntervalMs)
  if (renewIntervalMs >= durationMs) { invalidOrcadControllerConfig() }
  return Object.freeze({ datasetName: dataset,
    ...(structuredOutput ? { structuredOutput } : {}),
    ...(firstManagedInitial ? { firstManagedInitial } : {}),
    inventory: Object.freeze({ apiOrigin: apiOrigin(inventory.apiOrigin), namespace, dataset,
      caFile: absolute(inventory.caFile), tokenFile: absolute(inventory.tokenFile),
      requestTimeoutMs: positive(inventory.requestTimeoutMs, true), watchTimeoutSeconds: positive(inventory.watchTimeoutSeconds, true),
      listLimit: positive(inventory.listLimit, true) }),
    policy: Object.freeze({ lease: Object.freeze({ revision, durationMs }), renewIntervalMs,
      standbyPollIntervalMs: positive(policy.standbyPollIntervalMs), passPollIntervalMs: positive(policy.passPollIntervalMs),
      maximumWork: positive(policy.maximumWork), externalBudgetMs: positive(policy.externalBudgetMs) }) })
}

// JSON.parse alone accepts duplicate object keys. Scan its already valid grammar to reject duplicates at every depth.
export function parseUniqueOrcadControllerJson(source: string): unknown {
  const value: unknown = JSON.parse(source)
  let offset = 0
  const whitespace = () => { while (/\s/u.test(source[offset] ?? '') && offset < source.length) { offset++ } }
  function string(): string {
    const start = offset++
    while (offset < source.length) {
      const char = source[offset++]
      if (char === '\\') { offset++ }
      else if (char === '"') { const key: unknown = JSON.parse(source.slice(start, offset)); if (typeof key !== 'string') { invalidOrcadControllerConfig() }; return key }
    }
    return invalidOrcadControllerConfig('CONTROLLER_STARTUP_CONFIG_FILE')
  }
  function visit(): void {
    whitespace()
    if (source[offset] === '{') {
      offset++; whitespace()
      const keys = new Set<string>()
      if (source[offset] === '}') { offset++; return }
      for (;;) {
        whitespace(); const key = string()
        if (keys.has(key)) { invalidOrcadControllerConfig('CONTROLLER_STARTUP_DUPLICATE_KEY') }
        keys.add(key); whitespace(); offset++; visit(); whitespace()
        if (source[offset++] === '}') { return }
      }
    }
    if (source[offset] === '[') {
      offset++; whitespace()
      if (source[offset] === ']') { offset++; return }
      for (;;) { visit(); whitespace(); if (source[offset++] === ']') { return } }
    }
    if (source[offset] === '"') { string(); return }
    while (offset < source.length && !/[\s,\]}]/u.test(source[offset])) { offset++ }
  }
  visit()
  return value
}

/** Private config has a strict no-symlink identity boundary and a bounded read even if the file grows. */
export function readPrivateOrcadControllerConfigBytes(path: string): Buffer {
  const code = 'CONTROLLER_STARTUP_PRIVATE_FILE'
  let fd: number | undefined
  try {
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600) {
      invalidOrcadControllerConfig(code)
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.size < 1 || opened.size > fileLimit || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.uid !== process.getuid?.() || (opened.mode & 0o777) !== 0o600) { invalidOrcadControllerConfig(code) }
    const buffer = Buffer.alloc(fileLimit + 1)
    let used = 0, count: number
    do { count = readSync(fd, buffer, used, buffer.length - used, null); used += count } while (count && used < buffer.length)
    const after = fstatSync(fd)
    if (!used || used > fileLimit || after.dev !== opened.dev || after.ino !== opened.ino ||
        after.uid !== process.getuid?.() || (after.mode & 0o777) !== 0o600) { invalidOrcadControllerConfig(code) }
    return Buffer.from(buffer.subarray(0, used))
  } catch (error) {
    if (error instanceof OrcadControllerConfigurationError) { throw error }
    return invalidOrcadControllerConfig(code)
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { invalidOrcadControllerConfig(code) } }
  }
}

/** Unset is inert. No credential path, raw JSON, HTTP body or underlying cause enters the error. */
export function readOrcadControllerConfig(): OrcadControllerConfig | null {
  const path = process.env.ORCA_DURABLE_CONTROLLER_CONFIG
  if (path === undefined) { return null }
  try {
    const bytes = readPrivateOrcadControllerConfigBytes(absolute(path))
    return captureOrcadControllerConfig(parseUniqueOrcadControllerJson(bytes.toString('utf8')))
  } catch (error) {
    if (error instanceof OrcadControllerConfigurationError) { throw error }
    return invalidOrcadControllerConfig('CONTROLLER_STARTUP_CONFIG_FILE')
  }
}
