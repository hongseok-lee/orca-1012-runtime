import { TERMINAL_PASTE_END, TERMINAL_PASTE_START } from './ingress'

type PasteCursor = Readonly<{ pasteOpen: boolean; pendingDelimiter: string }>

export type TerminalDraftParse =
  | Readonly<{ kind: 'PARSED'; text: string; pasteOpen: boolean; pendingDelimiter: string }>
  | Readonly<{ kind: 'UNSUPPORTED'; reason: string }>

/** No delimiter guessing, control stripping, prompt splitting or wall-clock decisions. */
export function parseTerminalDraftFragment(
  cursor: PasteCursor,
  text: string,
  allowBodyCarriageReturn: boolean
): TerminalDraftParse {
  const source = cursor.pendingDelimiter + text
  let pasteOpen = cursor.pasteOpen
  let body = ''
  for (let offset = 0; offset < source.length;) {
    const suffix = source.slice(offset)
    if (source[offset] === '\x1b') {
      const expected = pasteOpen ? TERMINAL_PASTE_END : TERMINAL_PASTE_START
      const unexpected = pasteOpen ? TERMINAL_PASTE_START : TERMINAL_PASTE_END
      if (suffix.startsWith(unexpected)) {
        return { kind: 'UNSUPPORTED', reason: 'Nested or unmatched paste delimiter' }
      }
      if (suffix.startsWith(expected)) {
        pasteOpen = !pasteOpen
        offset += expected.length
        continue
      }
      if (expected.startsWith(suffix) || unexpected.startsWith(suffix)) {
        return { kind: 'PARSED', text: body, pasteOpen, pendingDelimiter: suffix }
      }
      return { kind: 'UNSUPPORTED', reason: 'Unknown escape or malformed paste delimiter' }
    }
    const code = source.charCodeAt(offset)
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a &&
      !(code === 0x0d && (pasteOpen || allowBodyCarriageReturn))) ||
      (code >= 0x7f && code <= 0x9f)) {
      return { kind: 'UNSUPPORTED', reason: 'Mixed control or paced key input' }
    }
    body += source[offset]
    offset += 1
  }
  return { kind: 'PARSED', text: body, pasteOpen, pendingDelimiter: '' }
}

/** Pure incremental UTF-8 decoding. Incomplete bytes remain bound to their original stream. */
export function decodeTerminalUtf8Fragment(
  previous: readonly number[],
  incoming: readonly number[]
): Readonly<{ text: string; pending: readonly number[] }> {
  const bytes = Uint8Array.from([...previous, ...incoming])
  // fatal avoids silently replacing malformed bytes; ignoreBOM preserves an actual U+FEFF body.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: true })
  const consumed = new TextEncoder().encode(text).byteLength
  return Object.freeze({ text, pending: Object.freeze(Array.from(bytes.slice(consumed))) })
}
