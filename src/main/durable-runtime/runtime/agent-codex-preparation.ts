import { supplyProtectedManagedCodexCredential } from './managed-codex-credential-supply.ts'
import type { ManagedCodexCredential } from '../providers/codex/managed-credential-owner.ts'
import { createNativeArtifactFile, type NativeFileIdentity } from './native-artifact-file.ts'
import { mkdirSync, lstatSync, fstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from '../../codex-accounts/fs-utils.ts'
import type { InitialProviderPaths } from './initial-provider-paths.ts'

export type CodexNativeArtifact = Readonly<NativeFileIdentity & { codeModeHost?: NativeFileIdentity; sandboxBwrap?:NativeFileIdentity;
  terminal?: Readonly<{ platform: 'linux'; arch: string; nodeAbi: string; runtime: NativeFileIdentity; addon: NativeFileIdentity }> }>

/** Private Agent-side COLD preparation. Construction is inert. begin/append/
 * finish are reachable only from the original backend permit callback AFTER
 * grant COMMIT; they write only this owned protected HOME, never /shared.
 * A 289 MB native executable is streamed, not retained in the 64 MiB /tmp. */
export function createAgentCodexPreparation(rootFd: number, artifact: CodexNativeArtifact, codexAuth: string,
  paths: InitialProviderPaths, provider: 'codex' | 'claude' = 'codex', credential?: ManagedCodexCredential, externalAuth=false) {
  if (!/^[0-9a-f]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 1 ||
      typeof codexAuth !== 'string' || Buffer.byteLength(codexAuth) > 1024 * 1024 ||
      provider === 'claude' && codexAuth !== '') { throw new Error('AGENT_COLD_PREPARATION_POLICY') }
  if (artifact.terminal && (artifact.terminal.platform !== process.platform || artifact.terminal.arch !== process.arch ||
      artifact.terminal.nodeAbi !== process.versions.modules)) { throw new Error('AGENT_TERMINAL_NATIVE_ABI') }
  // Claude's OAuth token reaches the native process only through its launch env.
  const native = provider, stateDirectory = provider === 'codex' ? '.codex' : '.claude'
  let phase: 'UNUSED' | 'WRITING' | 'READY' | 'FAILED' = 'UNUSED'
  let files: Map<string,ReturnType<typeof createNativeArtifactFile>> | null = null
  const initial = fstatSync(rootFd)
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
      child(home, stateDirectory); const directory = child(home, '.orca-native')
      // A first empty Folder workspace is materialized only AFTER COMMIT.
      // Git requires its real checkout and is never replaced by an empty one.
      const existing = paths.checkoutPreparation === 'EXISTING'
      if (!existing && paths.checkoutPreparation !== 'FRESH_EMPTY_FOLDER') { throw new Error('AGENT_COLD_CHECKOUT_UNPREPARED') }
      // Create-only for a first wake: an existing directory is not evidence of an
      // empty original workspace. A later wake keeps the Session's own checkout.
      if (!existing) { mkdirSync(paths.checkout, { mode: 0o700 }) }
      else {try {lstatSync(paths.checkout)} catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT') {throw e}; mkdirSync(paths.checkout,{mode:0o700})}}
      const checkout = lstatSync(paths.checkout)
      if (!checkout.isDirectory() || checkout.isSymbolicLink() || checkout.uid !== process.getuid?.() ||
          (checkout.mode & 0o777) !== 0o700 || realpathSync(paths.checkout) !== paths.checkout) {
        throw new Error('AGENT_COLD_CHECKOUT_REQUIRED')
      }
      files=new Map([[native,createNativeArtifactFile(directory,native,artifact,rootCurrent,existing)]])
      if(artifact.codeModeHost) {
        if(provider!=='codex') {throw new Error('AGENT_COLD_COMPANION_PROVIDER')}
        files.set('codex-code-mode-host',createNativeArtifactFile(directory,'codex-code-mode-host',artifact.codeModeHost,rootCurrent,existing))
      }
      if(artifact.sandboxBwrap) {
        if(provider!=='codex') {throw new Error('AGENT_COLD_COMPANION_PROVIDER')}
        files.set('codex-resources/bwrap',createNativeArtifactFile(directory,'codex-resources/bwrap',artifact.sandboxBwrap,rootCurrent,existing))
      }
      if (artifact.terminal) {
        files.set('terminal-runtime.cjs', createNativeArtifactFile(directory, 'terminal-runtime.cjs', artifact.terminal.runtime, rootCurrent, existing))
        files.set('terminal-pty.node', createNativeArtifactFile(directory, 'terminal-pty.node', artifact.terminal.addon, rootCurrent, existing))
      }
      for(const file of files.values()) {file.begin()}
      phase = 'WRITING'
    },
    append(offset: unknown, encoded: unknown, name: unknown = native): void {
      rootCurrent()
      if(phase!=='WRITING' || !files || typeof name!=='string' || !files.has(name) || typeof encoded!=='string' || encoded.length>349528 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {phase='FAILED';throw new Error('AGENT_COLD_ARTIFACT_CHUNK')}
      const chunk=Buffer.from(encoded,'base64')
      if(chunk.toString('base64')!==encoded) {phase='FAILED';throw new Error('AGENT_COLD_ARTIFACT_CHUNK')}
      files.get(name)!.append(offset,chunk)
    },
    finish(): void {
      rootCurrent()
      if(phase!=='WRITING' || !files) {phase='FAILED';throw new Error('AGENT_COLD_ARTIFACT_INCOMPLETE')}
      phase='FAILED'
      // All files must authenticate before COLD; companion publishes first.
      for(const name of ['codex-code-mode-host','codex-resources/bwrap','terminal-pty.node','terminal-runtime.cjs',native]) {files.get(name)?.finish()}
      if (provider === 'claude' || externalAuth) { rootCurrent(); phase = 'READY'; return }
      // Authentication text is private data. It is never hashed or printed.
      try { const parsed: unknown = JSON.parse(codexAuth); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { throw new Error('AGENT_COLD_AUTH_SHAPE') } }
      catch { throw new Error('AGENT_COLD_AUTH_INVALID') }
      if(credential) {supplyProtectedManagedCodexCredential(paths.home,credential,rootCurrent)}
      else {writeFileAtomically(join(paths.home, '.codex', 'auth.json'), codexAuth, { mode: 0o600 })}
      rootCurrent(); phase = 'READY'
    },
    ready(): boolean { return phase === 'READY' },
    close(): void {
      for(const file of files?.values()??[]) {file.close()}
      // Preserve partial evidence/files; no automatic rollback/deletion/retry.
      if (phase !== 'READY') { phase = 'FAILED' }
    },
  })
}
