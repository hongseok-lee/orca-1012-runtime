/** Supplied by the authenticated server boundary, never derived from client.id/type. */
export type TerminalDraftBinding = Readonly<{
  pairedDeviceId: string
  principalId: string
  logicalHandle: string
  sessionId: string
  connectionId: string
  floorGeneration: string
  mode: 'AGENT_CHAT_COMPAT' | 'RAW_TERMINAL'
}>

export type TerminalStreamRegistration = Readonly<{
  connectionId: string
  streamId: number
  streamGeneration: string
  ackMode: 'BYTES' | 'SOURCE_RANGES' | null
}>

export type TerminalIngressScope = Readonly<{
  binding: TerminalDraftBinding
  ingressId: string
  draftRevision: string
  ptyIncarnationId: string | null
  semanticAdapterRequired: boolean
  stream: TerminalStreamRegistration | null
}>

/** Checks this original scope again; a prior true result is not an authority grant. */
export type TerminalScopeValidity = (expected: TerminalIngressScope) => boolean

/** Opaque references only. Blob durability/ownership remains a subsequent SQL gate. */
export type TerminalAttachmentReference = Readonly<{ attachmentId: string }>

export type TerminalWireAction = Readonly<{
  text: string
  enter: boolean
  interrupt: boolean
  inputKind: 'query-reply' | undefined
  expectedIncarnationId: string | undefined
  agentPrompt: boolean
  resolvedLaunchDraft: Readonly<{ text: string; createdAt: number }> | undefined
}>

export type TerminalIngressSnapshot = Readonly<{
  scope: TerminalIngressScope
  source: 'UNARY' | 'BINARY'
  action: TerminalWireAction
  inputBytes: readonly number[] | null
  attachments: readonly TerminalAttachmentReference[]
  isCurrent: () => boolean
}>

export type TerminalDraftChunk = Readonly<{
  ingressId: string
  text: string
  attachments: readonly TerminalAttachmentReference[]
}>

export type TerminalDraft = Readonly<{
  binding: TerminalDraftBinding
  /** Opaque server revision. The SQL owner assigns the next durable revision. */
  revision: string
  chunks: readonly TerminalDraftChunk[]
  pasteOpen: boolean
  pendingDelimiter: string
  pendingUtf8: readonly number[]
  pendingUtf8Stream: Readonly<{ streamId: number; streamGeneration: string }> | null
}>

export type TerminalIngressClassification =
  | Readonly<{ kind: 'STALE_SCOPE' | 'PROTOCOL_REPLY' | 'RAW_CURRENT' | 'CLEAR' | 'STOP_CANDIDATE' }>
  | Readonly<{ kind: 'CHAT_FRAGMENT' | 'CHAT_SUBMIT'; text: string }>
  | Readonly<{ kind: 'UNSUPPORTED'; reason: string }>

export type TerminalSubmitCandidate = Readonly<{
  scope: TerminalIngressScope
  text: string
  chunks: readonly TerminalDraftChunk[]
  attachments: readonly TerminalAttachmentReference[]
}>

export type TerminalDraftReduction = Readonly<{
  kind: 'DRAFT_EDIT' | 'SUBMIT_CANDIDATE' | 'STOP_CANDIDATE' | 'PROTOCOL_REPLY' |
    'RAW_CURRENT' | 'STALE_SCOPE' | 'SCOPE_MISMATCH' | 'UNSUPPORTED'
  draft: TerminalDraft | null
  candidate: TerminalSubmitCandidate | null
  reason?: string
}>
