import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import process from 'node:process'
import type { Pool, PoolConfig } from 'pg'
import { LOCAL_EXECUTION_HOST_ID, getRepoExecutionHostId } from '../../shared/execution-host.ts'
import type { CatalogAuthority } from '../durable-runtime/catalog/authority.ts'
import type { CatalogSnapshot } from '../durable-runtime/catalog/read.ts'
import type { DurableCatalogReadConfig } from '../durable-runtime/rpc/config.ts'
import { captureOrcadCatalogLaunchConfig } from './orcad-durable-catalog-launch.ts'
import type { CatalogLaunchConfig } from '../durable-runtime/rpc/launch-config.ts'

export class OrcadDurableCatalogConfigurationError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'OrcadDurableCatalogConfigurationError'
  }
}

export type OrcadDurableCatalogConfig = {
  readonly datasetName: 'orca-1012-dev-v1'
  readonly hostId: typeof LOCAL_EXECUTION_HOST_ID
  readonly repositoryIds: readonly string[]
  readonly projectGroupIds: readonly string[]
  readonly workspacePublicIds: readonly string[]
  readonly pg: Readonly<Required<Pick<PoolConfig, 'host' | 'port' | 'database' | 'user' | 'max'>>>
  readonly pgpassFile: string
  readonly launch?: CatalogLaunchConfig
}

function invalid(code = 'CATALOG_STARTUP_CONFIG'): never {
  throw new OrcadDurableCatalogConfigurationError(code)
}

function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some(key => !keys.includes(key) && !optional.includes(key))) {
    invalid()
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) { invalid() }
  }
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value ||
      value.includes('\0') || value.includes('\r') || value.includes('\n')) { invalid() }
  return value
}

function ids(value: unknown): readonly string[] {
  if (!Array.isArray(value)) { invalid() }
  return Object.freeze([...new Set(Array.from(value, text))])
}

function privateFile(path: string): Stats {
  try {
    const metadata = lstatSync(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || process.getuid === undefined ||
        metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0) { invalid('CATALOG_STARTUP_PRIVATE_FILE') }
    return metadata
  } catch {
    return invalid('CATALOG_STARTUP_PRIVATE_FILE')
  }
}

/** Captures server-owned values synchronously; no await, environment writes or credential reads. */
export function captureOrcadDurableCatalogConfig(value: unknown, pgpassFile: string): OrcadDurableCatalogConfig {
  const input = record(value, ['datasetName', 'hostId', 'repositoryIds', 'projectGroupIds', 'workspacePublicIds', 'pg'], ['launch'])
  if (input.datasetName !== 'orca-1012-dev-v1') { invalid('CATALOG_STARTUP_DATASET_UNSUPPORTED') }
  if (input.hostId !== LOCAL_EXECUTION_HOST_ID) { invalid('CATALOG_STARTUP_HOST_UNSUPPORTED') }
  const pg = record(input.pg, ['host', 'port', 'database', 'user', 'max'])
  const port = pg.port
  const max = pg.max
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 4) { invalid() }
  const repositoryIds = ids(input.repositoryIds)
  const projectGroupIds = ids(input.projectGroupIds)
  const workspacePublicIds = ids(input.workspacePublicIds)
  if (repositoryIds.length + projectGroupIds.length + workspacePublicIds.length === 0) {
    invalid('CATALOG_STARTUP_REGISTRATION_REQUIRED')
  }
  const launch = captureOrcadCatalogLaunchConfig(Object.getOwnPropertyDescriptor(input, 'launch'), repositoryIds)
  return Object.freeze({ ...(launch === undefined ? {} : { launch }), datasetName: 'orca-1012-dev-v1', hostId: LOCAL_EXECUTION_HOST_ID,
    repositoryIds, projectGroupIds, workspacePublicIds, pgpassFile: text(pgpassFile),
    pg: Object.freeze({ host: text(pg.host), port, database: text(pg.database), user: text(pg.user), max }) })
}

/** Unset opt-in preserves the original startup. Failures never expose JSON, paths or env values. */
export function readOrcadDurableCatalogConfig(): OrcadDurableCatalogConfig | null {
  const path = process.env.ORCA_DURABLE_CATALOG_CONFIG
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
      invalid('CATALOG_STARTUP_PRIVATE_FILE')
    }
    value = JSON.parse(readFileSync(fd, 'utf8')) as unknown
  } catch (error) {
    if (error instanceof OrcadDurableCatalogConfigurationError) { throw error }
    invalid('CATALOG_STARTUP_CONFIG_FILE')
  } finally {
    if (fd !== undefined) { closeSync(fd) }
  }
  const pgpassFile = process.env.PGPASSFILE
  if (pgpassFile === undefined || process.env.PGPASSWORD !== undefined) { invalid('CATALOG_STARTUP_PGPASSFILE_REQUIRED') }
  privateFile(text(pgpassFile)) // Metadata only; libpq's existing pgpass reader owns credential access.
  return captureOrcadDurableCatalogConfig(value, pgpassFile)
}

/** No authority is minted for a client. This scope only validates the operator's registered snapshot. */
export async function validateOrcadDurableCatalogRegistration(config: OrcadDurableCatalogConfig, pool: Pool): Promise<void> {
  const [{ withCatalogReadSnapshot, readCatalogSnapshot }, { parseCatalogUi }, { projectCatalogTabs },
    { captureDurableCatalogReadConfig }, { validateCatalogSnapshot }] = await Promise.all([
    import('../durable-runtime/catalog/read.ts'), import('../durable-runtime/catalog/ui.ts'),
    import('../durable-runtime/catalog/projection.ts'), import('../durable-runtime/rpc/config.ts'),
    import('../durable-runtime/rpc/read.ts')
  ])
  const datasets = await withCatalogReadSnapshot(pool, async tx => {
    const datasets = await tx.query<{ dataset_name: string }>('SELECT dataset_name FROM durable_runtime.dataset_metadata')
    return datasets.rows
  })
  if (datasets.length !== 1 || datasets[0].dataset_name !== config.datasetName) {
    invalid('CATALOG_STARTUP_DATASET_MISMATCH')
  }
  const authority = Object.freeze({ principalId: 'orcad-startup-registration',
    repositoryIds: config.repositoryIds, projectGroupIds: config.projectGroupIds,
    workspacePublicIds: config.workspacePublicIds }) as CatalogAuthority
  const snapshot: CatalogSnapshot = await readCatalogSnapshot(pool, authority)
  validateCatalogSnapshot(captureDurableCatalogReadConfig({ ...config, pool,
    readHostIdentity: () => config.hostId }), snapshot)
  const contains = (required: readonly string[], actual: readonly string[]): boolean => required.every(id => actual.includes(id))
  if (!contains(config.repositoryIds, snapshot.repositories.map(row => row.id)) ||
      !contains(config.projectGroupIds, snapshot.projectGroups.map(row => row.id)) ||
      !contains(config.workspacePublicIds, snapshot.workspaces.map(row => row.public_id)) ||
      snapshot.repositories.length + snapshot.projectGroups.length + snapshot.workspaces.length === 0) {
    invalid('CATALOG_STARTUP_REGISTRATION_MISSING')
  }
  if (snapshot.repositories.some(repo => getRepoExecutionHostId(repo) !== config.hostId)) {
    invalid('CATALOG_STARTUP_REGISTRATION_HOST_MISMATCH')
  }
  if (!snapshot.heads.some(head => head.scope === 'ui:host')) { invalid('CATALOG_STARTUP_HEAD_MISSING') }
  if (!snapshot.ui) { invalid('CATALOG_STARTUP_UI_NOT_INITIALIZED') }
  parseCatalogUi(snapshot.ui.payload)
  for (const workspace of snapshot.workspaces) { projectCatalogTabs(snapshot, workspace) }
}

export type OrcadDurableCatalog = {
  readonly readConfig: DurableCatalogReadConfig
  stop(): Promise<void>
}

/** Startup owns exactly one Pool; caller stops RPC subscriptions before invoking stop(). */
export async function prepareOrcadDurableCatalog(
  input: OrcadDurableCatalogConfig | null,
  poolFactory?: (config: PoolConfig) => Pool
): Promise<OrcadDurableCatalog | null> {
  if (input === null) { return null }
  const config = captureOrcadDurableCatalogConfig({ datasetName: input.datasetName, hostId: input.hostId,
    repositoryIds: input.repositoryIds, projectGroupIds: input.projectGroupIds,
    workspacePublicIds: input.workspacePublicIds, pg: input.pg, ...(input.launch === undefined ? {} : { launch: input.launch }) }, input.pgpassFile)
  const { createDurablePool, safeDatabaseError } = await import('../durable-runtime/db/connection.ts')
  if (process.env.PGPASSFILE !== config.pgpassFile || process.env.PGPASSWORD !== undefined) {
    invalid('CATALOG_STARTUP_PGPASSFILE_CHANGED')
  }
  privateFile(config.pgpassFile)
  let pool: Pool
  try { pool = (poolFactory ?? createDurablePool)({ ...config.pg, connectionTimeoutMillis: 5000 }) }
  catch (error) { throw safeDatabaseError(error) }
  let completion: Promise<void> | null = null
  const stop = (): Promise<void> => {
    completion ??= Promise.resolve().then(() => pool.end()).catch(error => { throw safeDatabaseError(error) })
    return completion
  }
  try {
    await validateOrcadDurableCatalogRegistration(config, pool)
    if (process.env.PGPASSFILE !== config.pgpassFile || process.env.PGPASSWORD !== undefined) {
      invalid('CATALOG_STARTUP_PGPASSFILE_CHANGED')
    }
    return Object.freeze({ readConfig: Object.freeze({ pool, datasetName: config.datasetName,
      hostId: config.hostId, readHostIdentity: () => config.hostId, repositoryIds: config.repositoryIds,
      projectGroupIds: config.projectGroupIds, workspacePublicIds: config.workspacePublicIds,
      ...(config.launch === undefined ? {} : { launch: config.launch }) }), stop })
  } catch (error) {
    try { await stop() } catch { /* Preserve the sanitized original startup verdict. */ }
    if (error instanceof OrcadDurableCatalogConfigurationError) { throw error }
    throw safeDatabaseError(error)
  }
}
