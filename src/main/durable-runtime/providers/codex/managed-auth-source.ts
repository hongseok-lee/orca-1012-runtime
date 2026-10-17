import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { importCodexManagedHomeAuth } from '../../../codex-accounts/codex-managed-home-auth-import.ts'
import { assertOwnedHostCodexManagedHomePath } from '../../../codex-accounts/host-codex-managed-home-ownership.ts'
import { CodexAccountIdentity } from '../../../codex-accounts/codex-account-identity.ts'

/** Explicit operator-authorized Node product import. Reuses the original
 * codex-accounts import + ownership + identity implementations, without loading
 * Electron/interactive login or pretending desktop account services exist.
 * Selection is this server's private configured account, not a public RPC. */
export function importNodeCodexManagedAuth(userDataPath: string, sourceHome: string) {
  const managedAccountsRoot = join(resolve(userDataPath), 'codex-accounts'), accountId = randomUUID()
  mkdirSync(managedAccountsRoot, { recursive: true, mode: 0o700 })
  const root = lstatSync(managedAccountsRoot)
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid?.()) { throw new Error('CODEX_MANAGED_IMPORT_ROOT') }
  const parent = join(managedAccountsRoot, accountId), home = join(parent, 'home')
  mkdirSync(parent, { mode: 0o700 }); mkdirSync(home, { mode: 0o700 })
  writeFileSync(join(home, '.orca-managed-home'), `${accountId}\n`, { flag: 'wx', mode: 0o600 })
  const assertHome = (candidate: string, expectedAccountId = accountId) => assertOwnedHostCodexManagedHomePath({
    candidatePath: candidate, managedAccountsRoot, systemCodexHomePath: join(homedir(), '.codex'), expectedAccountId,
  })
  // Never automatically delete a partial/uncertain imported account.
  importCodexManagedHomeAuth(sourceHome, () => assertHome(home))
  const identity = new CodexAccountIdentity(assertHome).readFromHome(home, accountId)
  if (!identity.email) { throw new Error('CODEX_MANAGED_IMPORT_IDENTITY') }
  const metadata = lstatSync(join(home, 'auth.json'))
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error('CODEX_MANAGED_IMPORT_AUTH_METADATA')
  }
  return Object.freeze({ accountId, managedHomePath: home })
}

/** Private in-memory supply only. The actual executor must install these bytes
 * in its owned protected CODEX_HOME after grant COMMIT; never hash/log this text
 * or make the Backend managed home an Agent shared RW directory. */
export function readNodeCodexManagedAuth(userDataPath: string, configured: Readonly<{ accountId: string; managedHomePath: string }>): string {
  const home = assertOwnedHostCodexManagedHomePath({ candidatePath: configured.managedHomePath,
    managedAccountsRoot: join(resolve(userDataPath), 'codex-accounts'), systemCodexHomePath: join(homedir(), '.codex'),
    expectedAccountId: configured.accountId })
  const file = join(home, 'auth.json'), metadata = lstatSync(file)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error('CODEX_MANAGED_AUTH_METADATA')
  }
  return readFileSync(file, 'utf8')
}
