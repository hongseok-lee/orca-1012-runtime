import type { AgentSessionAttachResult, AgentSessionHistoryPage, AgentSessionMutationResult } from '../../../shared/agent-session-wire.ts'
import { isAgentSessionId } from '../../../shared/agent-session-record.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection.ts'
import type { JsonValue, MutationOutcome, ReceiptIdentity, ReceiptRecord } from '../db/atomic.ts'
import { captureCatalogJson } from '../catalog/immutable.ts'
import { structuredCounterToNumber } from '../structured/counters.ts'
import { CatalogReadError } from './config.ts'
import type { RpcContext } from '../../runtime/rpc/core.ts'
import { captureCatalogReadContext } from './context.ts'
import { validateCatalogSnapshot } from './read.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import { readCatalogSnapshot, resolveCatalogWorkspace, withCatalogReadSnapshot } from '../catalog/read.ts'
import { catalogSnapshotId } from '../catalog/revision.ts'
import type { CatalogAuthority } from '../catalog/authority.ts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { prepareStructuredWire } from '../structured/wire.ts'
import { checkStructuredCapabilities } from '../structured/capabilities.ts'
import { resolveStructuredAuthority, type VerifiedStructuredAuthentication, type VerifiedStructuredTargetAccess } from '../structured/authority.ts'
import { structuredReceiptIdentity, jsonValue } from '../structured/durable-common.ts'
import { resolveReceipt } from '../db/atomic.ts'
import { captureCatalogParsed } from '../catalog/immutable.ts'
import { isStructuredNativeChatEnabled, supportsStructuredAgentSessions } from '../../runtime/rpc/methods/structured-agent-session-policy.ts'
import { createDurableStructuredSession } from '../structured/durable-create.ts'
import { recordUnitIntent } from '../lifecycle/intent.ts'
import { reserveSleep } from '../lifecycle/sleep.ts'
import { recordInputCancel } from '../input/cancel.ts'
import { preparePublicStructuredReservation } from './structured-create-preparation.ts'
import type { CatalogOwnerEntries } from '../catalog/owners.ts'

function invalidReceipt(): never { throw new CatalogReadError('STRUCTURED_CREATE_RECEIPT_INVALID') }
function object(value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) { invalidReceipt() }
  return value
}
function uuid(kind: string, value: JsonValue): string {
  if (typeof value !== 'string') { invalidReceipt() }
  try { return logicalId(kind, value) } catch { return invalidReceipt() }
}

/** Original committed receipt only. This page describes creation, not current history. */
export function projectInitialStructuredCreateReceipt(
  receipt: ReceiptRecord, identity: ReceiptIdentity, publicSessionId: string, workspaceId: string, replayed: boolean
): AgentSessionMutationResult<AgentSessionAttachResult> {
  if (!isAgentSessionId(publicSessionId) || receipt.payloadHash !== identity.payloadHash ||
      receipt.key.principalId !== identity.key.principalId || receipt.key.sessionScope !== identity.key.sessionScope ||
      receipt.key.method !== 'agentSession.create' || receipt.key.method !== identity.key.method ||
      receipt.key.operationKey !== identity.key.operationKey ||
      receipt.key.sessionScope !== JSON.stringify(['structured-session', publicSessionId])) { invalidReceipt() }
  const response = object(captureCatalogJson(receipt.response))
  const alias = object(response.alias), reservation = object(response.reservation)
  const event = object(response.event), cursor = object(response.cursor), tab = object(reservation.tab)
  if (response.version !== 1 || response.kind !== 'STRUCTURED_SESSION_RESERVED' ||
      response.publicSessionId !== publicSessionId || alias.publicSessionId !== publicSessionId || alias.workspaceId !== workspaceId ||
      response.fence !== 1 || cursor.sequence !== 1 || event.sequence !== '1' ||
      typeof event.epoch !== 'string' || cursor.epoch !== event.epoch ||
      alias.sessionId !== reservation.sessionId || (alias.provider !== 'claude' && alias.provider !== 'codex') ||
      tab.type !== 'agent-session' || tab.id !== structuredAgentSessionTabId(publicSessionId) ||
      tab.sessionId !== publicSessionId || tab.agent !== alias.provider || typeof tab.title !== 'string' ||
      typeof tab.isActive !== 'boolean' || !Number.isSafeInteger(reservation.snapshotVersion) ||
      typeof reservation.snapshotVersion !== 'number' || reservation.snapshotVersion < 0) { invalidReceipt() }
  uuid('session', alias.sessionId); uuid('workspace', alias.workspaceId)
  uuid('tab', reservation.tabId); uuid('operation', reservation.operationId)
  uuid('event', event.eventId); uuid('publication-epoch', reservation.publicationEpoch)
  structuredCounterToNumber(event.epoch, 1)
  for (const key of ['providerHandle', 'nativeSessionId', 'ptyId', 'incarnationId', 'terminal', 'terminalHandle', 'leafId', 'paneKey']) {
    if (Object.hasOwn(tab, key)) { invalidReceipt() }
  }
  const originalCursor = { epoch: event.epoch, sequence: 1 }
  const page: AgentSessionHistoryPage = { sessionId: publicSessionId, epoch: event.epoch, fence: 1, direction: 'tail',
    items: [], removedItemIds: [], submissions: [], window: { oldest: null, newest: null, nextCursor: originalCursor },
    liveCursor: originalCursor, hasOlder: false, hasNewer: false }
  return { ok: true, replayed, fence: 1, cursor: originalCursor,
    value: { sessionId: publicSessionId, fence: 1, page, unconfirmedClientMessageIds: [] } }
}

export function projectInitialStructuredCreateOutcome(
  outcome: MutationOutcome, identity: ReceiptIdentity, publicSessionId: string, workspaceId: string
): AgentSessionMutationResult<AgentSessionAttachResult> {
  if (outcome.status === 'UNCERTAIN') {
    throw new CatalogReadError('STRUCTURED_CREATE_COMMIT_UNCERTAIN_RESOLVE_SAME_KEY')
  }
  return projectInitialStructuredCreateReceipt(outcome.receipt, identity, publicSessionId, workspaceId, outcome.status === 'REPLAYED')
}


export const CATALOG_STRUCTURED_CREATE_METHODS = Object.freeze(['agentSession.createSupport', 'agentSession.create'] as const)
export type CatalogStructuredCreateMethod = typeof CATALOG_STRUCTURED_CREATE_METHODS[number]

/** All transport/config/request data is captured before the first Pool await. */
export async function authorizePublicStructuredCreate(
  config: CapturedCatalogReadConfig, method: CatalogStructuredCreateMethod, input: unknown, context: RpcContext
) {
  const pool = config.pool, fingerprint = context.authenticatedCallerFingerprint
  const clientKind = context.clientKind, capabilities = Object.freeze([...(context.clientCapabilities ?? [])])
  const scopedContext = captureCatalogReadContext(config, { runtime: context.runtime, clientKind,
    authenticatedCallerFingerprint: fingerprint, clientCapabilities: capabilities })
  if (typeof fingerprint !== 'string') { throw new CatalogReadError('CATALOG_AUTHENTICATED_CALLER_REQUIRED') }
  const principal = fingerprintAttachmentPrincipal(fingerprint)
  const original = captureCatalogParsed(input === undefined ? null : input)
  const parsed = prepareStructuredWire(method, original, capabilities)
  if (!supportsStructuredAgentSessions({ clientKind, clientCapabilities: capabilities,
    structuredNativeChatEnabled: isStructuredNativeChatEnabled(context.runtime) })) {
    throw new CatalogReadError('structured_agent_session_unsupported')
  }
  if (!parsed.ok) { return { refusal: parsed.refusal } as const }
  const wire = parsed.value, provider = wire.params.agent
  if (provider !== 'claude' && provider !== 'codex') { throw new CatalogReadError('STRUCTURED_CREATE_PROVIDER_NOT_CONNECTED') }
  const eligibility = checkStructuredCapabilities(wire, { provider, methods: { [method]: { implemented: true, ready: true } } })
  if (!eligibility.eligible) { throw new CatalogReadError(eligibility.reason) }
  if (wire.target.kind !== 'WORKTREE') { throw new CatalogReadError('STRUCTURED_ATTACH_NOT_CONNECTED') }
  const snapshot = await readCatalogSnapshot(pool, scopedContext.authority)
  validateCatalogSnapshot(config, snapshot)
  for (const head of snapshot.heads) {
    catalogSnapshotId({ publicationEpoch: head.publication_epoch, revision: head.revision, queryProjection: null })
  }
  const workspace = await withCatalogReadSnapshot(pool, tx => resolveCatalogWorkspace(tx, wire.target.kind === 'WORKTREE'
    ? wire.target.worktree : '', scopedContext.authority))
  config.assertCurrentHost()
  // Only this upper boundary connects these private brands, after authenticated
  // transport and the exact method/public target were authorized by the PG resolver.
  const authentication = Object.freeze({ kind: 'UNARY_CREDENTIAL_FINGERPRINT' as const,
    authenticatedCallerFingerprint: fingerprint }) as VerifiedStructuredAuthentication
  const accessFields: Omit<VerifiedStructuredTargetAccess, symbol> = { principal, method, target: wire.target }
  const targetAccess = Object.freeze(accessFields) as VerifiedStructuredTargetAccess
  const resolved = resolveStructuredAuthority(wire, authentication, targetAccess)
  const catalogFields: Omit<CatalogAuthority, symbol> = { principalId: principal,
    repositoryIds: scopedContext.authority.repositoryIds, projectGroupIds: scopedContext.authority.projectGroupIds,
    workspacePublicIds: scopedContext.authority.workspacePublicIds }
  const catalogAuthority = Object.freeze(catalogFields) as CatalogAuthority
  return Object.freeze({ pool, wire, workspace, authentication, targetAccess, resolved, catalogAuthority })
}

/** Receipt discovery precedes every new reservation/launch/current-state condition. */
export async function findPublicStructuredCreateReceipt(
  config: CapturedCatalogReadConfig, authorized: Exclude<Awaited<ReturnType<typeof authorizePublicStructuredCreate>>, { refusal: unknown }>
) {
  const mutation = authorized.wire.mutation
  if (!mutation) { throw new CatalogReadError('STRUCTURED_MUTATION_REQUIRED') }
  const identity = structuredReceiptIdentity(authorized.wire, authorized.resolved, jsonValue(mutation.semanticBody))
  const found = await resolveReceipt(authorized.pool, identity)
  config.assertCurrentHost()
  if (found.status === 'UNAVAILABLE') { throw new CatalogReadError('STRUCTURED_CREATE_RECEIPT_UNAVAILABLE') }
  return Object.freeze({ identity, found, publicSessionId: mutation.publicSessionId })
}



/** Same captured Pool and actual owners as the installed Catalog adapter. */
export function createCatalogStructuredRpc(config: CapturedCatalogReadConfig) {
  const receiver: CatalogOwnerEntries = { recordUnitIntent, reserveSleep, recordInputCancel }
  const entries: CatalogOwnerEntries = Object.freeze({ recordUnitIntent: receiver.recordUnitIntent.bind(receiver),
    reserveSleep: receiver.reserveSleep.bind(receiver), recordInputCancel: receiver.recordInputCancel.bind(receiver) })
  return async (method: CatalogStructuredCreateMethod, params: unknown, context: RpcContext): Promise<unknown> => {
    const authorized = await authorizePublicStructuredCreate(config, method, params, context)
    if ('refusal' in authorized) { return { ok: false, refusal: authorized.refusal } }
    if (method === 'agentSession.createSupport') {
      config.assertCurrentHost()
      return { supported: false, reason: 'agent' }
    }
    const original = await findPublicStructuredCreateReceipt(config, authorized)
    if (original.found.status === 'FOUND') {
      return projectInitialStructuredCreateReceipt(original.found.receipt, original.identity,
        original.publicSessionId, authorized.workspace.workspace_id, true)
    }
    if (Object.hasOwn(authorized.wire.params, 'resumeFrom')) { throw new CatalogReadError('STRUCTURED_RESUME_NOT_CONNECTED') }
    const configuration = await preparePublicStructuredReservation(config, authorized.wire, authorized.catalogAuthority, authorized.workspace)
    const outcome = await createDurableStructuredSession({ pool: authorized.pool, params: authorized.wire.params,
      capabilities: authorized.wire.capabilities, authentication: authorized.authentication,
      targetAccess: authorized.targetAccess, configuration, entries })
    config.assertCurrentHost()
    return projectInitialStructuredCreateOutcome(outcome, original.identity, original.publicSessionId, authorized.workspace.workspace_id)
  }
}
