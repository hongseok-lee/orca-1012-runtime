import type { Pool } from 'pg'
import { captureCatalogClipboardConfig, type CatalogClipboardConfig } from './clipboard-config.ts'
import { captureCatalogLaunchConfig, type CatalogLaunchConfig } from './launch-config.ts'
import type { ExecutionHostId } from '../../../shared/execution-host.ts'
import { normalizeExecutionHostId } from '../../../shared/execution-host.ts'

/** Server composition only. No credentials, request fields or pool ownership. */
export type DurableCatalogReadConfig = {
  readonly pool: Pool
  readonly datasetName: string
  readonly hostId: ExecutionHostId
  readonly readHostIdentity: () => ExecutionHostId
  readonly repositoryIds: readonly string[]
  readonly projectGroupIds: readonly string[]
  readonly workspacePublicIds: readonly string[]
  readonly attachments?: CatalogClipboardConfig
  readonly launch?: CatalogLaunchConfig
  readonly pollIntervalMs?: number
}
export type CapturedCatalogReadConfig = Omit<DurableCatalogReadConfig, 'readHostIdentity' | 'pollIntervalMs'> & {
  readonly pollIntervalMs: number
  readonly assertCurrentHost: () => void
}
export class CatalogReadError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.name = 'CatalogReadError'; this.code = code }
}
export function catalogReadFailure(error: unknown): CatalogReadError {
  if (error instanceof CatalogReadError) { return error }
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return new CatalogReadError(typeof code === 'string' && /^[A-Za-z0-9_:-]+$/.test(code) ? code : 'CATALOG_PG_READ_FAILED')
}
function ids(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id)) { throw new CatalogReadError('CATALOG_SERVER_CONFIG') }
  return Object.freeze([...new Set(value)].sort())
}
export function captureDurableCatalogReadConfig(input: DurableCatalogReadConfig): CapturedCatalogReadConfig {
  const { pool, datasetName, hostId } = input
  const pollIntervalMs = input.pollIntervalMs ?? 1000
  if (!pool || typeof pool.connect !== 'function' || typeof datasetName !== 'string' || !datasetName ||
      normalizeExecutionHostId(hostId) !== hostId || typeof input.readHostIdentity !== 'function' ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) { throw new CatalogReadError('CATALOG_SERVER_CONFIG') }
  // The server-owned method/receiver is captured before any I/O. Deep freeze
  // data arrays only: the borrowed Pool and host owner must retain their state.
  const readHostIdentity = input.readHostIdentity.bind(input)
  const assertCurrentHost = (): void => {
    let current: ExecutionHostId | null = null
    try { current = readHostIdentity() } catch { /* Owner failure is unknown. */ }
    if (current !== hostId) { throw new CatalogReadError('CATALOG_HOST_MISMATCH') }
  }
  const repositoryIds = ids(input.repositoryIds)
  const attachments = captureCatalogClipboardConfig(Object.getOwnPropertyDescriptor(input, 'attachments'))
  const launchDescriptor = Object.getOwnPropertyDescriptor(input, 'launch')
  if (launchDescriptor !== undefined && !('value' in launchDescriptor)) { throw new CatalogReadError('CATALOG_SERVER_CONFIG') }
  const launch = captureCatalogLaunchConfig(launchDescriptor?.value, repositoryIds)
  const config = Object.freeze({ pool, datasetName, hostId, pollIntervalMs, assertCurrentHost,
    ...(launch === undefined ? {} : { launch }),
    ...(attachments === undefined ? {} : { attachments }),
    repositoryIds, projectGroupIds: ids(input.projectGroupIds), workspacePublicIds: ids(input.workspacePublicIds) })
  assertCurrentHost()
  return config
}
