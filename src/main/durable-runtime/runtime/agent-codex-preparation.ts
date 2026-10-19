import { createHash } from 'node:crypto'
import { constants, mkdirSync, lstatSync, openSync, writeSync, fstatSync, fchmodSync,
  fsyncSync, closeSync, linkSync, unlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from '../../codex-accounts/fs-utils.ts'
import type { InitialProviderPaths } from './initial-provider-paths.ts'

export type CodexNativeArtifact = Readonly<{ sha256: string; byteLength: number }>

/** Private Agent-side COLD preparation. Construction is inert. begin/append/
 * finish are reachable only from the original backend permit callback AFTER
 * grant COMMIT; they write only this owned protected HOME, never /shared.
 * A 289 MB native executable is streamed, not retained in the 64 MiB /tmp. */
export function createAgentCodexPreparation(rootFd: number, artifact: CodexNativeArtifact, codexAuth: string,
  paths: InitialProviderPaths, provider: 'codex' | 'claude' = 'codex') {
  if (!/^[0-9a-f]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 1 ||
      typeof codexAuth !== 'string' || Buffer.byteLength(codexAuth) > 1024 * 1024 ||
      provider === 'claude' && codexAuth !== '') { throw new Error('AGENT_COLD_PREPARATION_POLICY') }
  // Claude's OAuth token reaches the native process only through its launch env.
  const native = provider, stateDirectory = provider === 'codex' ? '.codex' : '.claude'
  let phase: 'UNUSED' | 'WRITING' | 'READY' | 'FAILED' = 'UNUSED'
  let fd: number | null = null, bytes = 0, directory = '', partial = ''
  const initial = fstatSync(rootFd), digest = createHash('sha256')
  function rootCurrent(): void {
    const held = fstatSync(rootFd), named = lstatSync('/agent')
    if (!held.isDirectory() || !named.isDirectory() || named.isSymbolicLink() ||
        held.dev !== initial.dev || held.ino !== initial.ino || named.dev !== held.dev || named.ino !== held.ino) {
      phase = 'FAILED'; throw new Error('AGENT_COLD_PROTECTED_ROOT_CHANGED')
    }
  }
  function child(parent: string, name: string): string {
    rootCurrent()
    const path = join(parent, name)
    try { mkdirSync(path, { mode: 0o700 }) }
    catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') { throw error } }
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || realpathSync(path) !== path ||
        (stat.mode & 0o777) !== 0o700) { throw new Error('AGENT_COLD_PRIVATE_DIRECTORY') }
    return path
  }
  return Object.freeze({
    begin(): void {
      if (phase !== 'UNUSED') { throw new Error('AGENT_COLD_PREPARATION_USED') }
      phase = 'FAILED'
      const homeRoot = child('/agent', 'home'), home = child(homeRoot, paths.agentId)
      if (home !== paths.home) { throw new Error('AGENT_COLD_HOME_MAPPING') }
      child(home, stateDirectory); directory = child(home, '.orca-native')
      // A first empty Folder workspace is materialized only AFTER COMMIT.
      // Git requires its real checkout and is never replaced by an empty one.
      if (paths.checkoutPreparation !== 'FRESH_EMPTY_FOLDER') { throw new Error('AGENT_COLD_CHECKOUT_UNPREPARED') }
      // Create-only: an existing directory is not evidence of an empty original
      // workspace, and partial preparation is never silently restarted.
      mkdirSync(paths.checkout, { mode: 0o700 })
      const checkout = lstatSync(paths.checkout)
      if (!checkout.isDirectory() || checkout.isSymbolicLink() || checkout.uid !== process.getuid?.() ||
          (checkout.mode & 0o777) !== 0o700 || realpathSync(paths.checkout) !== paths.checkout) {
        throw new Error('AGENT_COLD_CHECKOUT_REQUIRED')
      }
      partial = join(directory, `${native}.partial`)
      fd = openSync(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      phase = 'WRITING'
    },
    append(offset: unknown, encoded: unknown): void {
      rootCurrent()
      if (phase !== 'WRITING' || fd === null || offset !== bytes || typeof encoded !== 'string' || encoded.length > 349528 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) { phase = 'FAILED'; throw new Error('AGENT_COLD_ARTIFACT_CHUNK') }
      const chunk = Buffer.from(encoded, 'base64')
      if (!chunk.length || chunk.length > 256 * 1024 || chunk.toString('base64') !== encoded || bytes + chunk.length > artifact.byteLength) {
        phase = 'FAILED'; throw new Error('AGENT_COLD_ARTIFACT_BOUNDS')
      }
      let written = 0
      while (written < chunk.length) {
        const count = writeSync(fd, chunk, written, chunk.length - written)
        if (count <= 0) { phase = 'FAILED'; throw new Error('AGENT_COLD_ARTIFACT_WRITE') }
        written += count
      }
      digest.update(chunk); bytes += chunk.length
    },
    finish(): void {
      rootCurrent()
      if (phase !== 'WRITING' || fd === null || bytes !== artifact.byteLength) { phase = 'FAILED'; throw new Error('AGENT_COLD_ARTIFACT_INCOMPLETE') }
      phase = 'FAILED'
      if (digest.digest('hex') !== artifact.sha256) { throw new Error('AGENT_COLD_ARTIFACT_IDENTITY') }
      const original = fstatSync(fd)
      fchmodSync(fd, 0o700); fsyncSync(fd)
      const final = join(directory, native)
      linkSync(partial, final)
      const published = lstatSync(final), staged = lstatSync(partial)
      if (published.dev !== original.dev || published.ino !== original.ino || staged.dev !== original.dev || staged.ino !== original.ino) {
        throw new Error('AGENT_COLD_ARTIFACT_PUBLICATION')
      }
      closeSync(fd); fd = null; unlinkSync(partial)
      if (provider === 'claude') { rootCurrent(); phase = 'READY'; return }
      // Authentication text is private data. It is never hashed or printed.
      try { const parsed: unknown = JSON.parse(codexAuth); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { throw new Error('AGENT_COLD_AUTH_SHAPE') } }
      catch { throw new Error('AGENT_COLD_AUTH_INVALID') }
      writeFileAtomically(join(paths.home, '.codex', 'auth.json'), codexAuth, { mode: 0o600 })
      rootCurrent(); phase = 'READY'
    },
    ready(): boolean { return phase === 'READY' },
    close(): void {
      if (fd !== null) { closeSync(fd); fd = null }
      // Preserve partial evidence/files; no automatic rollback/deletion/retry.
      if (phase !== 'READY') { phase = 'FAILED' }
    },
  })
}
