import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { WorkspaceId } from '../../../shared/durable-runtime/identity.ts'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { runDurableMutation, type JsonValue, type MutationOutcome } from '../db/atomic.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { appendAudit, enqueueOutbox } from '../journal/store.ts'
import { catalogReceiptIdentity, type PreparedCatalogCall, type ResolvedCatalogScope } from './request.ts'
import { captureCatalogJson } from './immutable.ts'
import { captureCatalogAuthority } from './authority.ts'
import { discoverCatalogMembership, inspectCatalogMembership, lockCatalogMembership, type CatalogMembership } from './membership.ts'
import { resolveCatalogWorkspace, withCatalogReadSnapshot, type CatalogWorkspace } from './read.ts'
import { advanceCatalogProjection, lockCatalogMetadata } from './heads.ts'
import { CatalogError } from './errors.ts'

/** Resolver-owned internal scope, independent of selector spelling and lifecycle. */
export function catalogWorkspaceScope(workspace: Pick<CatalogWorkspace, 'workspace_id'>): ResolvedCatalogScope {
  return `workspace:${workspace.workspace_id}` as ResolvedCatalogScope
}

/** Capture again at an exported SQL boundary; callers cannot bypass the immutable facade. */
export function capturePreparedCatalogCall<Method extends PreparedCatalogCall['method']>(call: PreparedCatalogCall<Method>): PreparedCatalogCall<Method> {
  const context = Object.freeze({ authority: captureCatalogAuthority(call.context.authority),
    capabilities: captureCatalogJson(call.context.capabilities) as typeof call.context.capabilities })
  return Object.freeze({ ...call, context, params: captureCatalogJson(call.params) as typeof call.params,
    original: captureCatalogJson(call.original) })
}

export async function resolveCatalogMutation(pool: Pool, call: PreparedCatalogCall, selector: string): Promise<{
  workspace: CatalogWorkspace; membership: CatalogMembership
}> {
  const workspace = await withCatalogReadSnapshot(pool, tx => resolveCatalogWorkspace(tx, selector, call.context.authority))
  const membership = await discoverCatalogMembership(pool, workspace.workspace_id)
  return { workspace, membership }
}

/** P1-03 receipt-first replay occurs before current OPEN/deleted checks. */
export async function mutateCatalogWorkspace(
  pool: Pool, input: PreparedCatalogCall, selector: string,
  body: (tx: DurableTransaction, workspace: CatalogWorkspace, membership: CatalogMembership) => Promise<JsonValue>
): Promise<MutationOutcome> {
  const call = capturePreparedCatalogCall(input)
  const found = await resolveCatalogMutation(pool, call, selector)
  return runDurableMutation(pool, { ...catalogReceiptIdentity(call, catalogWorkspaceScope(found.workspace)), locks: {} }, async tx => {
    await lockCatalogMembership(tx, found.membership)
    const current = await resolveCatalogWorkspace(tx, `id:${found.workspace.public_id}`, call.context.authority)
    if (current.workspace_id !== found.workspace.workspace_id) throw new CatalogError('CATALOG_IDENTITY_CHANGED')
    if (current.deleted_at !== null) throw new CatalogError('CATALOG_WORKSPACE_DELETED')
    return body(tx, current, found.membership)
  })
}

/** Called after owner same-TX entries have finished acquiring lower ranks. */
export async function lockCatalogWorkspaceMetadata(tx: DurableTransaction, membership: CatalogMembership, extra: readonly string[] = []): Promise<void> {
  await lockCatalogMetadata(tx, [`workspace:${membership.workspaceId}`, ...extra])
  if (JSON.stringify(await inspectCatalogMembership(tx, membership.workspaceId)) !== JSON.stringify(membership)) {
    throw new CatalogError('CATALOG_MEMBERSHIP_CHANGED_RETRYABLE')
  }
  const row = await tx.query<{ deleted_at: Date | null }>(
    'SELECT deleted_at FROM durable_runtime.workspaces WHERE id=$1 FOR UPDATE', [membership.workspaceId])
  if (!row.rows[0] || row.rows[0].deleted_at !== null) throw new CatalogError('CATALOG_WORKSPACE_DELETED')
}

/** Must be the last aggregate-lock phase. Audit/outbox share the receipt transaction. */
export async function publishCatalogMutation(
  tx: DurableTransaction, call: Pick<PreparedCatalogCall, 'context'>, workspaceId: WorkspaceId | null,
  kind: string, detail: JsonValue, extraScopes: readonly string[] = []
): Promise<void> {
  const heads = await advanceCatalogProjection(tx, ['catalog', ...(workspaceId ? [`workspace:${workspaceId}`] : []), ...extraScopes])
  const head = heads.find(row => row.scope === 'catalog')!
  const eventId = logicalId('event', randomUUID())
  const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now
  await appendAudit(tx, { actorId: call.context.authority.principalId, kind,
    previousState: null, nextState: detail, occurredAt: now, receivedAt: now,
    producerId: eventId, producerSeq: counter('sequence:producer', head.revision), evidenceRefs: [] })
  await enqueueOutbox(tx, { eventId, aggregateId: workspaceId ?? 'catalog', aggregateKind: 'catalog',
    revision: counter('row:catalog-head', head.revision), event: { kind, detail } })
}
