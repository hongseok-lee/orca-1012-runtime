import { constants, openSync, closeSync, fstatSync, lstatSync, mkdirSync, realpathSync, readdirSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import type { Pool } from 'pg'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host.ts'
import type { CatalogAuthority } from '../durable-runtime/catalog/authority.ts'
import { captureCatalogAuthority } from '../durable-runtime/catalog/authority.ts'
import { captureCatalogParsed } from '../durable-runtime/catalog/immutable.ts'
import { registerCatalogProject } from '../durable-runtime/catalog/register.ts'
import type { CatalogRegistration } from '../durable-runtime/catalog/register.ts'

/** Existing trusted bootstrap authority only. This helper creates no authority
 * from a request/PG principal, and installs no public registration RPC. */
export async function registerOrcadFirstEmptyFolder(pool: Pool, originalAuthority: CatalogAuthority,
  original: Readonly<{ sourceRoot: string; registration: CatalogRegistration }>) {
  const authority = captureCatalogAuthority(originalAuthority), input = captureCatalogParsed(original)
  const root = input.sourceRoot, repo = input.registration.repo
  const deny = (): never => { throw new Error('FIRST_COLD_FOLDER_REGISTRATION') }
  if (!authority.repositoryIds.includes(repo.id) || repo.kind !== 'folder' || repo.projectGroupId != null ||
      input.registration.group !== null || repo.connectionId != null || (repo.executionHostId ?? LOCAL_EXECUTION_HOST_ID) !== LOCAL_EXECUTION_HOST_ID ||
      repo.path !== join(root, 'checkout') || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(basename(root)) ||
      realpathSync(dirname(root)) !== dirname(root)) { return deny() }
  const parent = lstatSync(dirname(root))
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700) { return deny() }
  // The operator selected this new source. Existing Folder registrations and
  // contents are never read as an empty template or changed to fit this target.
  // Atomic mkdir consumes it once; a partial failure is retained, not retried.
  mkdirSync(root, { mode: 0o700 })
  mkdirSync(repo.path, { mode: 0o700 })
  mkdirSync(join(root, 'home'), { mode: 0o700 })
  const fd = openSync(repo.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const originalStat = fstatSync(fd)
    function stillEmpty(): void {
      const held = fstatSync(fd), named = lstatSync(repo.path)
      if (!held.isDirectory() || !named.isDirectory() || named.isSymbolicLink() || held.uid !== process.getuid?.() ||
          (held.mode & 0o777) !== 0o700 || held.dev !== originalStat.dev || held.ino !== originalStat.ino ||
          named.dev !== held.dev || named.ino !== held.ino || realpathSync(repo.path) !== repo.path || readdirSync(repo.path).length) { deny() }
    }
    stillEmpty()
    const mutation = await registerCatalogProject(pool, authority, input.registration)
    stillEmpty()
    return Object.freeze({ mutation, preparation: Object.freeze({ kind: 'FRESH_EMPTY_FOLDER_SOURCE' as const,
      repositoryId: repo.id, sourceRoot: root, sourceCheckout: repo.path, ownerUid: originalStat.uid,
      mode: '0700', device: String(originalStat.dev), inode: String(originalStat.ino), empty: true,
      physicalPinIssued: false, providerReady: false }) })
  } finally { closeSync(fd) }
}
