import { posix } from 'node:path'
import { captureCatalogJson } from '../catalog/immutable.ts'
import { CatalogError } from '../catalog/errors.ts'
import type { LifecyclePolicy } from '../lifecycle/types.ts'

export type CatalogLaunchRepositoryConfig = {
  readonly repositoryId: string
  readonly worktreeRoot?: string
  readonly storage: { readonly backendId: string; readonly exportId: string; readonly canonicalDirectory: string }
  readonly agentHomeRoot: string
}
export type CatalogLaunchConfig = {
  readonly policy: LifecyclePolicy
  readonly repositories: readonly CatalogLaunchRepositoryConfig[]
}
function invalid(): never { throw new CatalogError('CATALOG_LAUNCH_CONFIGURATION') }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) { invalid() }
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) { invalid() }
  return value
}
/** Logical POSIX containment only. No symlink resolution, filesystem access or grant. */
export function catalogLaunchPath(value: unknown): string {
  const path = text(value)
  if (!path.startsWith('/') || path.includes('\\') || posix.normalize(path) !== path ||
      (path !== '/' && path.endsWith('/')) || path.split('/').some(part => part === '.' || part === '..')) { invalid() }
  return path
}
export function catalogLaunchContains(root: string, target: string): boolean {
  return root === '/' || root === target || target.startsWith(`${root}/`)
}
export function captureCatalogLaunchConfig(value: unknown, repositoryIds: readonly string[]): CatalogLaunchConfig | undefined {
  if (value === undefined) { return undefined }
  // Reject accessors, foreign prototypes and non-JSON data before reading any fields.
  const input = record(captureCatalogJson(value), ['policy', 'repositories'])
  const policy = record(input.policy, ['operationDeadlineMs', 'idleDurationMs'])
  const deadline = policy.operationDeadlineMs, idle = policy.idleDurationMs
  if (typeof deadline !== 'number' || !Number.isSafeInteger(deadline) || deadline <= 0 ||
      !(idle === null || typeof idle === 'number' && Number.isSafeInteger(idle) && idle > 0) || !Array.isArray(input.repositories)) { invalid() }
  const seen = new Set<string>()
  const repositories = input.repositories.map(value => {
    const item = record(value, ['repositoryId', 'worktreeRoot', 'storage', 'agentHomeRoot'])
    const repositoryId = text(item.repositoryId)
    if (!repositoryIds.includes(repositoryId) || seen.has(repositoryId)) { invalid() }
    seen.add(repositoryId)
    const storage = record(item.storage, ['backendId', 'exportId', 'canonicalDirectory'])
    const canonicalDirectory = catalogLaunchPath(storage.canonicalDirectory)
    const agentHomeRoot = catalogLaunchPath(item.agentHomeRoot)
    const worktreeRoot = item.worktreeRoot === undefined ? undefined : catalogLaunchPath(item.worktreeRoot)
    if (!catalogLaunchContains(canonicalDirectory, agentHomeRoot) ||
        worktreeRoot !== undefined && !catalogLaunchContains(canonicalDirectory, worktreeRoot)) { invalid() }
    return Object.freeze({ repositoryId, ...(worktreeRoot === undefined ? {} : { worktreeRoot }), agentHomeRoot,
      storage: Object.freeze({ backendId: text(storage.backendId), exportId: text(storage.exportId), canonicalDirectory }) })
  })
  return Object.freeze({ policy: Object.freeze({ operationDeadlineMs: deadline, idleDurationMs: idle }), repositories: Object.freeze(repositories) })
}
