import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { CatalogWorkspace } from '../catalog/read.ts'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts.ts'
import { createSessionTabsRetirementProofDelta } from '../../runtime/rpc/methods/session-tabs-retirement-proof-delta.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import { CatalogReadError, catalogReadFailure } from './config.ts'
import { SharedCatalogHeadHints } from './head-hints.ts'
import { authoritativeInventory, captureReadInvocation, catalogModules, projectTabs,
  resolveReadWorkspace, validateCatalogSnapshot, type CatalogReadInvocation } from './read.ts'

type RemovedTabs = RuntimeMobileSessionTabsResult & { removed: true }
type Subscription = {
  readonly id: string; readonly connection: string; readonly request: string; readonly principal: string
  readonly all: boolean; readonly selector: string | null; readonly invocation: CatalogReadInvocation
  canonical: CatalogWorkspace | null; initialized: boolean; closed: boolean
  readonly close: () => void; readonly cancel: () => void; readonly fail: (error: unknown) => void
}
export class CatalogReadSubscriptions {
  private readonly records = new Map<string, Subscription>()
  constructor(private readonly config: CapturedCatalogReadConfig) {}
  async subscribe(method: string, params: unknown, context: RpcContext, emit: (frame: unknown) => void): Promise<void> {
    const invocation = captureReadInvocation(this.config, params, context)
    const all = method === 'session.tabs.subscribeAll'
    const selector = all ? null : (invocation.params as { worktree: string }).worktree
    if (!all && (typeof selector !== 'string' || !selector)) { throw new CatalogReadError('CATALOG_SELECTOR') }
    const reportError = context.reportSubscriptionError?.bind(context)
    if (!reportError) { throw new CatalogReadError('CATALOG_STREAM_ERROR_SINK_REQUIRED') }
    const connection = context.connectionId ?? 'local', request = context.requestId ?? randomUUID()
    const id = `session.tabs:${connection}:${selector ?? '*'}:${request}`
    const register = context.runtime.registerSubscriptionCleanup.bind(context.runtime)
    const unregister = context.runtime.cleanupSubscription.bind(context.runtime)
    const ownerEmit = emit, signal = context.signal
    const delta = createSessionTabsRetirementProofDelta(invocation.capabilities)
    const prior = new Map<string, { workspace: CatalogWorkspace; frame: RuntimeMobileSessionTabsResult }>()
    let detach: (() => void) | null = null
    // Close the old record before installing a reused connection/request key.
    this.records.get(id)?.close()
    const cleanup = (end: boolean): void => {
      if (record.closed) { return }
      record.closed = true
      detach?.(); detach = null
      signal?.removeEventListener('abort', record.cancel)
      if (this.records.get(id) === record) { this.records.delete(id) }
      unregister(id)
      if (end && record.initialized) { ownerEmit({ type: 'end' }) }
    }
    const record: Subscription = { id, connection, request, principal: invocation.context.authority.principalId,
      all, selector, invocation, canonical: null, initialized: false, closed: false,
      close: () => cleanup(true), cancel: () => cleanup(false), fail: error => {
        if (record.closed) { return }
        // Error is an existing RPC failure, never an empty snapshot or deletion.
        try { reportError(catalogReadFailure(error)) } finally { cleanup(true) }
      } }
    this.records.set(id, record)
    // The authenticated request's cleanup registration precedes first await.
    register(id, record.cancel, context.connectionId)
    signal?.addEventListener('abort', record.cancel, { once: true })
    if (signal?.aborted) { record.cancel() }
    if (record.closed) { return }
    try {
      const modules = await catalogModules()
      if (record.closed) { return }
      if (selector !== null) {
        record.canonical = await resolveReadWorkspace(this.config, invocation, selector)
        if (record.closed) { return }
        if (record.canonical.deleted_at !== null) { throw new CatalogReadError('CATALOG_WORKSPACE_DELETED') }
      }
      const { subscribeCatalogSnapshots } = await import('../catalog/subscribe.ts')
      if (record.closed) { return }
      const shared = SharedCatalogHeadHints.for(this.config).forSubscriber(record.fail)
      const hints = { listen: (changed: () => void): (() => void) => {
        if (record.closed) { return () => {} }
        const off = shared.listen(changed)
        // The Catalog helper returns its full cleanup only after initial PG I/O.
        // Capture the hint cleanup now so disconnect stops the poll immediately.
        detach = off
        return off
      } }
      const off = await subscribeCatalogSnapshots(this.config.pool, invocation.context.authority, hints, async snapshot => {
        if (record.closed) { return }
        validateCatalogSnapshot(this.config, snapshot)
        const rows = all ? snapshot.workspaces : snapshot.workspaces.filter(row => row.workspace_id === record.canonical?.workspace_id)
        const frames = rows.map(row => ({ workspace: row, frame: projectTabs(invocation, modules.projection.projectCatalogTabs(snapshot, row)) }))
        const removed: RemovedTabs[] = []
        for (const previous of prior.values()) {
          if (!rows.some(row => row.workspace_id === previous.workspace.workspace_id)) {
            removed.push(await this.confirmTombstone(invocation, previous.workspace))
            if (record.closed) { return }
          }
        }
        if (!all && frames.length === 0 && prior.size === 0) { throw new CatalogReadError('CATALOG_WORKSPACE_UNAVAILABLE') }
        if (record.closed) { return }
        this.config.assertCurrentHost()
        if (!record.initialized) {
          ownerEmit(all ? { type: 'snapshots', snapshots: frames.map(item => delta(item.frame)), ...authoritativeInventory(invocation) }
            : { type: 'snapshot', ...delta(frames[0].frame) })
          // emit can synchronously disconnect. Never add state or emit after it.
          if (record.closed) { return }
          record.initialized = true
        } else {
          for (const item of frames) {
            if (record.closed) { return }
            if (!isDeepStrictEqual(prior.get(item.workspace.workspace_id)?.frame, item.frame)) {
              ownerEmit({ type: 'updated', ...delta(item.frame) })
            }
          }
          for (const frame of removed) {
            if (record.closed) { return }
            ownerEmit({ type: 'updated', ...delta(frame) })
          }
        }
        if (record.closed) { return }
        prior.clear()
        for (const item of frames) { prior.set(item.workspace.workspace_id, item) }
        if (!all && removed.length) { record.close() }
      }, record.fail)
      if (record.closed) { off() } else { detach = off }
    } catch (error) {
      if (record.closed) { return }
      cleanup(false)
      throw catalogReadFailure(error)
    }
  }
  private async confirmTombstone(invocation: CatalogReadInvocation, original: CatalogWorkspace): Promise<RemovedTabs> {
    const { read, projection } = await catalogModules()
    const frame = await read.withCatalogReadSnapshot(this.config.pool, async tx => {
      const row = await read.resolveCatalogWorkspace(tx, `id:${original.public_id}`, invocation.context.authority)
      if (row.workspace_id !== original.workspace_id || row.deleted_at === null) { throw new CatalogReadError('CATALOG_TOMBSTONE_UNCONFIRMED') }
      const head = (await tx.query<{ dataset_name: string }>('SELECT dataset_name FROM durable_runtime.catalog_heads WHERE scope=$1',
        [`workspace:${row.workspace_id}`])).rows[0]
      if (!head || head.dataset_name !== this.config.datasetName) { throw new CatalogReadError('CATALOG_DATASET_MISMATCH') }
      const repo = row.repo_id === null ? null : (await tx.query<{ payload: Record<string, unknown> }>(
        'SELECT payload FROM durable_runtime.catalog_repositories WHERE id=$1', [row.repo_id])).rows[0]
      const host = row.payload.hostId ?? row.payload.executionHostId ?? repo?.payload.executionHostId ?? 'local'
      if (host !== this.config.hostId) { throw new CatalogReadError('CATALOG_REGISTRATION_HOST_MISMATCH') }
      return { ...projectTabs(invocation, await projection.readWorkspaceTabsInTransaction(tx, row)), removed: true as const }
    })
    this.config.assertCurrentHost()
    return frame
  }
  async unsubscribe(method: string, params: unknown, context: RpcContext): Promise<{ unsubscribed: true }> {
    const invocation = captureReadInvocation(this.config, params, context)
    const input = invocation.params as { worktree?: string; subscriptionId?: string } | null
    const connection = context.connectionId ?? 'local'
    const selected = [...this.records.values()].filter(record => record.connection === connection &&
      record.principal === invocation.context.authority.principalId &&
      (!input?.subscriptionId || input.subscriptionId === record.request))
    const matchesOriginal = (record: Subscription): boolean => input?.worktree === record.selector ||
      input?.worktree === record.canonical?.public_id || input?.worktree === `id:${record.canonical?.public_id}`
    // A different legacy alias must use the incumbent PG resolver as well.
    const resolved = method === 'session.tabs.unsubscribe' && input?.worktree &&
      selected.some(record => !record.all) && !selected.some(matchesOriginal)
      ? await resolveReadWorkspace(this.config, invocation, input.worktree) : null
    for (const record of selected) {
      if (record.closed) { continue }
      if (method === 'session.tabs.unsubscribeAll' && !record.all) { continue }
      if (method === 'session.tabs.unsubscribe') {
        if (record.all || !input?.worktree || (!matchesOriginal(record) && resolved?.workspace_id !== record.canonical?.workspace_id)) { continue }
      }
      record.close()
    }
    return { unsubscribed: true }
  }
  dispose(): void { for (const record of [...this.records.values()]) { record.close() } }
}
