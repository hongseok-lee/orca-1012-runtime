import type { Pool } from 'pg'
import type { PreparedCatalogAgentSession } from '../catalog/agent-session.ts'
import type { CatalogOwnerEntries } from '../catalog/owners.ts'
import type { InputAttachment } from '../input/types.ts'
import type { MutationOutcome } from '../db/atomic.ts'
import type { SessionId, WorkspaceId } from '../../../shared/durable-runtime/identity.ts'
import type { AgentSessionMutationResult, AgentSessionSendResult } from '../../../shared/agent-session-wire'
import type { AttachmentPrincipal } from '../attachments/types.ts'
import type { VerifiedStructuredAuthentication, VerifiedStructuredTargetAccess } from './authority.ts'
import type { JsonSnapshot } from './snapshot.ts'

export type DurableStructuredCall = Readonly<{
  pool: Pool
  params: unknown
  capabilities: readonly string[]
  authentication: VerifiedStructuredAuthentication | null
  targetAccess: VerifiedStructuredTargetAccess | null
}>
/** Exact configuration selected by the actual upper resolver; not an authentication issuer. */
export type StructuredWorkspaceExpectation = Readonly<{
  workspaceId: WorkspaceId
  workspacePublicId: string
  provider: 'claude' | 'codex'
  executionHostId: string
}>
export type StructuredCreateConfiguration = Readonly<{
  reservation: PreparedCatalogAgentSession
  location: Readonly<{
    workspaceId: string
    executionHostId: string
    wslDistro: string | null
    workspaceKind: 'git-worktree' | 'folder'
  }>
}>
export type DurableStructuredCreateCall = DurableStructuredCall & Readonly<{
  configuration: StructuredCreateConfiguration
  entries: CatalogOwnerEntries
}>

declare const attachmentResolutionBrand: unique symbol
/** Issued by the upper durable attachment resolver. No URL/FS reader or issuer here. */
export type VerifiedStructuredAttachmentResolution = Readonly<{
  [attachmentResolutionBrand]: true
  principal: AttachmentPrincipal
  entries: readonly (InputAttachment & Readonly<{
    blockIndex: number
    referenceKind: 'path' | 'url'
    originalReference: string
  }>)[]
}>
export type DurableStructuredSendCall = DurableStructuredCall & Readonly<{
  workspace: StructuredWorkspaceExpectation
  attachments: VerifiedStructuredAttachmentResolution
}>
export type DurableStructuredSendOutcome =
  | Extract<MutationOutcome, { status: 'UNCERTAIN' }>
  | (Exclude<MutationOutcome, { status: 'UNCERTAIN' }> & Readonly<{
      wireResult: AgentSessionMutationResult<AgentSessionSendResult>
    }>)
export type StructuredAliasIdentity = Readonly<{
  publicSessionId: string
  sessionId: SessionId
  workspace: StructuredWorkspaceExpectation
  location: JsonSnapshot
}>
