import { z } from 'zod'
import { canonicalInputJson } from '../input/canonical.ts'
import type { JsonValue } from '../db/atomic.ts'
import { snapshotDraftBinding, snapshotTerminalAttachments } from './ingress'
import { emptyTerminalDraft } from './draft-reducer'
import { terminalCounter, TerminalDraftStoreError } from './durable-contracts'
import type { TerminalDraftAttachment } from './durable-contracts'
import type { TerminalDraft, TerminalDraftBinding } from './types'

const text = z.string().min(1)
const bindingSchema = z.object({
  pairedDeviceId: text, principalId: text, logicalHandle: text, sessionId: text,
  connectionId: text, floorGeneration: text, mode: z.enum(['AGENT_CHAT_COMPAT', 'RAW_TERMINAL'])
}).strict()
const referenceSchema = z.object({ attachmentId: text }).strict()
const attachmentSchema = referenceSchema.extend({
  aliasPath: text, contentHash: z.string().regex(/^[0-9a-f]{64}$/)
}).strict()
const codecSchema = z.object({
  version: z.literal(1), binding: bindingSchema,
  chunks: z.array(z.object({ ingressId: text, text: z.string(),
    attachments: z.array(referenceSchema) }).strict()),
  pasteOpen: z.boolean(), pendingDelimiter: z.string(),
  pendingUtf8: z.array(z.number().int().min(0).max(255)),
  pendingUtf8Stream: z.object({ streamId: z.number().int().min(1), streamGeneration: text }).strict().nullable(),
  lastIngress: z.unknown()
}).strict()

export type StoredTerminalDraft = Readonly<{
  draft: TerminalDraft
  attachments: readonly TerminalDraftAttachment[]
  lastIngress: JsonValue
}>

export function immutableTerminalJson(value: JsonValue): JsonValue {
  const copy = JSON.parse(canonicalInputJson(value)) as JsonValue
  function freeze(item: JsonValue): void {
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) {
        freeze(child)
      }
      Object.freeze(item)
    }
  }
  freeze(copy)
  return copy
}

export function snapshotDraftAttachments(
  values: readonly TerminalDraftAttachment[]
): readonly TerminalDraftAttachment[] {
  return Object.freeze(values.map((value) => Object.freeze(attachmentSchema.parse(value))))
}

export function decodeStoredTerminalDraft(
  body: unknown,
  attachments: unknown,
  revision: string
): StoredTerminalDraft {
  const parsed = codecSchema.safeParse(body)
  const aliases = z.array(attachmentSchema).safeParse(attachments)
  if (!parsed.success || !aliases.success) {
    throw new TerminalDraftStoreError('TERMINAL_HISTORICAL_DRAFT_UNSUPPORTED')
  }
  const binding = snapshotDraftBinding(parsed.data.binding)
  terminalCounter(binding.floorGeneration)
  const draft = Object.freeze({ ...emptyTerminalDraft(binding, terminalCounter(revision)),
    chunks: Object.freeze(parsed.data.chunks.map((chunk) => Object.freeze({
      ingressId: chunk.ingressId, text: chunk.text,
      attachments: snapshotTerminalAttachments(chunk.attachments)
    }))),
    pasteOpen: parsed.data.pasteOpen,
    pendingDelimiter: parsed.data.pendingDelimiter,
    pendingUtf8: Object.freeze([...parsed.data.pendingUtf8]),
    pendingUtf8Stream: parsed.data.pendingUtf8Stream
      ? Object.freeze({ ...parsed.data.pendingUtf8Stream }) : null
  })
  const resolved = snapshotDraftAttachments(aliases.data)
  assertAttachmentPositions(draft, resolved)
  let lastIngress: JsonValue
  try {
    lastIngress = immutableTerminalJson(parsed.data.lastIngress as JsonValue)
  } catch {
    throw new TerminalDraftStoreError('TERMINAL_HISTORICAL_DRAFT_UNSUPPORTED')
  }
  return Object.freeze({ draft, attachments: resolved, lastIngress })
}

export function encodeStoredTerminalDraft(stored: StoredTerminalDraft): JsonValue {
  assertAttachmentPositions(stored.draft, stored.attachments)
  return JSON.parse(canonicalInputJson({ version: 1,
    binding: { ...stored.draft.binding },
    chunks: stored.draft.chunks.map((chunk) => ({ ingressId: chunk.ingressId,
      text: chunk.text, attachments: chunk.attachments.map((ref) => ({ ...ref })) })),
    pasteOpen: stored.draft.pasteOpen, pendingDelimiter: stored.draft.pendingDelimiter,
    pendingUtf8: [...stored.draft.pendingUtf8],
    pendingUtf8Stream: stored.draft.pendingUtf8Stream ? { ...stored.draft.pendingUtf8Stream } : null,
    lastIngress: stored.lastIngress
  })) as JsonValue
}

export function assertAttachmentPositions(
  draft: TerminalDraft,
  aliases: readonly TerminalDraftAttachment[]
): void {
  const refs = draft.chunks.flatMap((chunk) => chunk.attachments)
  if (refs.length !== aliases.length || refs.some((ref, i) => ref.attachmentId !== aliases[i].attachmentId)) {
    throw new TerminalDraftStoreError('TERMINAL_ATTACHMENT_ORDER')
  }
}

export function draftAttachmentsAfterReduction(
  draft: TerminalDraft,
  previous: readonly TerminalDraftAttachment[],
  incoming: readonly TerminalDraftAttachment[]
): readonly TerminalDraftAttachment[] {
  const byId = new Map<string, TerminalDraftAttachment>()
  for (const ref of [...previous, ...incoming]) {
    const old = byId.get(ref.attachmentId)
    if (old && (old.aliasPath !== ref.aliasPath || old.contentHash !== ref.contentHash)) {
      throw new TerminalDraftStoreError('TERMINAL_ATTACHMENT_ID_CONFLICT')
    }
    byId.set(ref.attachmentId, ref)
  }
  return snapshotDraftAttachments(draft.chunks.flatMap((chunk) => chunk.attachments).map((ref) => {
    const resolved = byId.get(ref.attachmentId)
    if (!resolved) {
      throw new TerminalDraftStoreError('TERMINAL_ATTACHMENT_MISSING')
    }
    return resolved
  }))
}

export function rebindStoredTerminalDraft(
  stored: StoredTerminalDraft,
  binding: TerminalDraftBinding,
  revision: string
): StoredTerminalDraft {
  return Object.freeze({ ...stored,
    draft: Object.freeze({ ...stored.draft, binding: snapshotDraftBinding(binding), revision }) })
}
