import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { writeFileAtomically } from './fs-utils.ts'
import { ManagedCodexHomeTemporarilyUnavailableError } from './host-codex-managed-home-ownership.ts'

/** Shared desktop/Node import primitive. Original read/ownership/write ordering
 * and transient-error behavior are preserved. No auth content or digest leaves
 * this function, and the original source home is never changed. */
export function importCodexManagedHomeAuth(sourceHome: string, assertDestination: () => string): void {
  const trimmed = sourceHome.trim()
  if (!trimmed) { throw new Error('A Codex home directory path is required.') }
  const resolvedSourceHome = resolve(trimmed)
  let contents: string
  try { contents = readFileSync(join(resolvedSourceHome, 'auth.json'), 'utf8') }
  catch (error) {
    if (!isDefinitiveAbsence(error)) { throw new ManagedCodexHomeTemporarilyUnavailableError(undefined, { cause: error }) }
    throw new Error(`No Codex credentials found in ${resolvedSourceHome}. Run \`codex login\` into this directory first.`)
  }
  const trustedHome = assertDestination()
  writeFileAtomically(join(trustedHome, 'auth.json'), contents, { mode: 0o600 })
}
