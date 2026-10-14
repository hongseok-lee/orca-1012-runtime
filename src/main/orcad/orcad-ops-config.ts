import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import process from 'node:process'
import type { LifecyclePolicy } from '../durable-runtime/lifecycle/types.ts'
import { OrcadDurableCatalogConfigurationError } from './orcad-durable-catalog.ts'

export class OrcadOpsConfigurationError extends OrcadDurableCatalogConfigurationError {
  constructor(code = 'OPS_STARTUP_CONFIG') {
    super(code)
    this.name = 'OrcadOpsConfigurationError'
  }
}

export type OrcadOpsConfig = Readonly<{
  origin: string
  namespaceId: string
  workspaceIds: readonly string[]
  lifecyclePolicy: LifecyclePolicy
  pollIntervalMs: number
}>

export function invalidOrcadOpsConfig(code = 'OPS_STARTUP_CONFIG'): never {
  throw new OrcadOpsConfigurationError(code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== keys.length ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))) {
    invalidOrcadOpsConfig()
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) { invalidOrcadOpsConfig() }
  }
  return value
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value ||
      value.includes('\0') || value.includes('\r') || value.includes('\n')) { invalidOrcadOpsConfig() }
  return value
}

function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) { invalidOrcadOpsConfig() }
  return value
}

function origin(value: unknown): string {
  const input = text(value)
  try {
    const parsed = new URL(input)
    if (!/^https?:\/\/[^\s/?#\\]+\/?$/i.test(input) || input.includes('@') ||
        parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      invalidOrcadOpsConfig()
    }
    return parsed.origin
  } catch { return invalidOrcadOpsConfig() }
}

/** All owned scalars, arrays and policy values are detached before any I/O await. */
export function captureOrcadOpsConfig(value: unknown): OrcadOpsConfig {
  const input = record(value, ['origin', 'namespaceId', 'workspaceIds', 'lifecyclePolicy', 'pollIntervalMs'])
  const policy = record(input.lifecyclePolicy, ['operationDeadlineMs', 'idleDurationMs'])
  if (!Array.isArray(input.workspaceIds)) { invalidOrcadOpsConfig() }
  const workspaceIds: string[] = Array.from(input.workspaceIds, text)
  if (workspaceIds.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) ||
      new Set(workspaceIds).size !== workspaceIds.length) { invalidOrcadOpsConfig() }
  return Object.freeze({ origin: origin(input.origin), namespaceId: text(input.namespaceId),
    workspaceIds: Object.freeze(workspaceIds), pollIntervalMs: positive(input.pollIntervalMs),
    lifecyclePolicy: Object.freeze({ operationDeadlineMs: positive(policy.operationDeadlineMs),
      idleDurationMs: policy.idleDurationMs === null ? null : positive(policy.idleDurationMs) }) })
}

function privateFile(path: string): Stats {
  try {
    const metadata = lstatSync(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || process.getuid === undefined ||
        metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0) {
      invalidOrcadOpsConfig('OPS_STARTUP_PRIVATE_FILE')
    }
    return metadata
  } catch { return invalidOrcadOpsConfig('OPS_STARTUP_PRIVATE_FILE') }
}

/** Unset does not read a file or load PG/UI modules. No configuration values enter errors. */
export function readOrcadOpsConfig(): OrcadOpsConfig | null {
  const path = process.env.ORCA_OPS_CONFIG
  if (path === undefined) { return null }
  text(path)
  const before = privateFile(path)
  let fd: number | undefined
  let value: unknown
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.uid !== process.getuid?.() || (opened.mode & 0o077) !== 0 || opened.size > 1024 * 1024) {
      invalidOrcadOpsConfig('OPS_STARTUP_PRIVATE_FILE')
    }
    value = JSON.parse(readFileSync(fd, 'utf8'))
  } catch (error) {
    if (error instanceof OrcadOpsConfigurationError) { throw error }
    invalidOrcadOpsConfig('OPS_STARTUP_CONFIG_FILE')
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { invalidOrcadOpsConfig('OPS_STARTUP_CONFIG_FILE') }
    }
  }
  return captureOrcadOpsConfig(value)
}
