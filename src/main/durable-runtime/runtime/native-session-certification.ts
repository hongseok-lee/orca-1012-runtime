/** READY can name Claude's launch before the first system/init. Old Claude
 * READY records lack that distinction and remain ambiguous. Codex READY was
 * produced only after its real thread/start or thread/resume response. */
export function certifiedNativeSessionRef(provider: 'codex'|'claude', kind: string, value: unknown): string|null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return null }
  const event = value as Record<string,unknown>, ref = event.providerRef
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) { return null }
  const native = ref as Record<string,unknown>
  if (native.provider !== provider || typeof native.nativeSessionRef !== 'string' || !native.nativeSessionRef) { return null }
  if (kind === 'INITIAL_PROVIDER_NATIVE_OBSERVED' ||
      (kind === 'INITIAL_PROVIDER_READY' && (event.nativeSessionObserved === true || (provider === 'codex' && event.nativeSessionObserved !== false)))) {
    return native.nativeSessionRef
  }
  return null
}
