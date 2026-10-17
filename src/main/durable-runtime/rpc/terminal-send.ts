import type { Pool } from 'pg'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { TerminalSend } from '../../../shared/rpc-contract/terminal-unary-params.ts'
import type { RpcContext } from '../../runtime/rpc/core.ts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { withDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { resolveCatalogWorkspace, type CatalogTab } from '../catalog/read.ts'
import { parseCatalogTab, parseCatalogWorkspace, parseCatalogRepo } from '../catalog/payload.ts'
import { getRepoExecutionHostId, getWorktreeExecutionHostId } from '../../../shared/execution-host.ts'
import { projectCatalogWorktree } from '../catalog/projection.ts'
import type { CatalogRepositoryRow } from '../db/rows.ts'
import { captureCatalogReadContext } from './context.ts'
import { CatalogReadError, type CapturedCatalogReadConfig } from './config.ts'
import { capturedJson } from '../structured/durable-common.ts'
import { applyManagedTerminalIngress, resolveManagedTerminalIngressReceipt, managedTerminalIngressWireResult } from '../terminal/managed-ingress.ts'
import { snapshotUnaryTerminalIngress, classifyTerminalIngress } from '../terminal/ingress.ts'
import { readTerminalFloorInTransaction, claimTerminalFloorInTransaction, assertTerminalFloorPin } from '../terminal/floor-repository.ts'
import { reattachTerminalFloorInTransaction } from '../terminal/floor-reattach.ts'
import { readTerminalDraftInTransaction } from '../terminal/draft-repository.ts'
import type { TerminalDraftBinding } from '../terminal/types.ts'
import type { ManagedTerminalIngressRequest, TerminalFloorPin } from '../terminal/durable-contracts.ts'

/** Existing unary schema only. This never calls a provider or creates a PTY. */
export function createCatalogTerminalSendRpc(config: CapturedCatalogReadConfig) {
  const owner = config.pool, connect = owner.connect.bind(owner), query = owner.query.bind(owner)
  const pool = new Proxy(owner, {get(target, key) {
    if (key === 'connect') { return connect }
    if (key === 'query') { return query }
    return Reflect.get(target, key, target)
  }}) as Pool
  const currentHost = config.assertCurrentHost.bind(config)
  return async (original: unknown, context: RpcContext, legacy: (params: never, context: RpcContext) => unknown): Promise<unknown> => {
    const params = TerminalSend.parse(capturedJson(original))
    const fingerprint = context.authenticatedCallerFingerprint, device = context.pairedDeviceId
    const connection = context.terminalInputConnection, requestId = context.requestId, signal = context.signal
    const transport = {runtime: context.runtime, authenticatedCallerFingerprint: fingerprint,
      clientKind: context.clientKind, clientCapabilities: Object.freeze([...(context.clientCapabilities ?? [])])}
    const checkConnection = connection?.assertCurrent.bind(connection)
    const checkPrevious = connection?.assertPreviousInvalidated.bind(connection)
    const incarnation = connection?.connectionIncarnation
    const assertCurrent = (): void => {
      currentHost()
      if (!checkConnection || signal?.aborted || connection?.pairedDeviceId !== device ||
          connection?.authenticatedCallerFingerprint !== fingerprint) { throw new CatalogReadError('TERMINAL_AUTHENTICATED_CONNECTION_REQUIRED') }
      checkConnection()
    }
    currentHost()
    const resolved = await withDurableTransaction(pool, async tx => {
      const found = await tx.query<CatalogTab & {public_id: string; provider: string; session_fence: string; dataset_name: string}>(
        `SELECT m.*,t.workspace_id,t.session_id,t.kind,t.terminal_handle,t.lifecycle,t.revision AS tab_revision,
         w.public_id,w.dataset_name,s.session_fence,g.provider FROM durable_runtime.tabs t
         JOIN durable_runtime.catalog_tab_metadata m ON m.tab_id=t.id
         JOIN durable_runtime.sessions s ON s.id=t.session_id JOIN durable_runtime.agents g ON g.id=s.agent_id
         JOIN durable_runtime.workspaces w ON w.id=t.workspace_id WHERE t.terminal_handle=$1`, [params.terminal])
      if (found.rows.length === 0) { return null }
      if (found.rows.length !== 1) { throw new CatalogReadError('TERMINAL_TARGET_AMBIGUOUS') }
      assertCurrent()
      const row = found.rows[0], call = captureCatalogReadContext(config, transport)
      const dataset = await tx.query<{dataset_name: string}>('SELECT dataset_name FROM durable_runtime.dataset_metadata')
      if (dataset.rows.length !== 1 || dataset.rows[0].dataset_name !== config.datasetName || row.dataset_name !== config.datasetName || !row.session_id) {
        throw new CatalogReadError('CATALOG_DATASET_MISMATCH')
      }
      const workspace = await resolveCatalogWorkspace(tx, `id:${row.public_id}`, call.authority)
      if (workspace.workspace_id !== row.workspace_id) { throw new CatalogReadError('TERMINAL_WORKSPACE_SCOPE') }
      parseCatalogWorkspace(workspace)
      let repository: ReturnType<typeof parseCatalogRepo> | undefined
      if (workspace.repo_id !== null) {
        const stored = (await tx.query<CatalogRepositoryRow>('SELECT * FROM durable_runtime.catalog_repositories WHERE id=$1', [workspace.repo_id])).rows[0]
        if (!stored) { throw new CatalogReadError('CATALOG_REPOSITORY_UNAVAILABLE') }
        repository = parseCatalogRepo(stored)
        if (getRepoExecutionHostId(repository) !== config.hostId) { throw new CatalogReadError('CATALOG_REGISTRATION_HOST_MISMATCH') }
      }
      if (getWorktreeExecutionHostId(projectCatalogWorktree(workspace), repository) !== config.hostId) { throw new CatalogReadError('CATALOG_REGISTRATION_HOST_MISMATCH') }
      const tab = parseCatalogTab(row)
      const chat = tab.type === 'terminal' && ['claude', 'codex'].includes(row.provider) && tab.viewMode !== 'terminal'
      return Object.freeze({sessionId: logicalId('session', row.session_id), sessionFence: counter('session-fence', row.session_fence), chat})
    })
    currentHost()
    if (!resolved) { return legacy(params as never, context) }
    assertCurrent()
    if (!fingerprint || !device || !incarnation || !requestId || !checkPrevious) { throw new CatalogReadError('TERMINAL_AUTHENTICATED_CONNECTION_REQUIRED') }
    const principal = fingerprintAttachmentPrincipal(fingerprint)
    const binding = (generation: string): TerminalDraftBinding => Object.freeze({logicalHandle: params.terminal,
      sessionId: resolved.sessionId, pairedDeviceId: device, principalId: principal,
      connectionId: incarnation, floorGeneration: generation, mode: 'AGENT_CHAT_COMPAT'})
    const request = (pin: TerminalFloorPin | null, draftRevision: string): ManagedTerminalIngressRequest => {
      const scope = {binding: binding(pin?.binding.floorGeneration ?? '0'), ingressId: JSON.stringify([incarnation, requestId]),
        draftRevision, ptyIncarnationId: null, semanticAdapterRequired: false, stream: null}
      return Object.freeze({snapshot: snapshotUnaryTerminalIngress(params, scope, [], () => { assertCurrent(); return true }),
        origin: Object.freeze({kind: 'UNARY', authenticatedConnectionIncarnation: incarnation, rpcRequestId: requestId}),
        authority: Object.freeze({principal, sessionId: resolved.sessionId, scope: Object.freeze({kind: 'TERMINAL', terminalHandle: params.terminal})}),
        sessionFence: resolved.sessionFence, expectedFloorRevision: pin?.revision ?? '0', attachments: Object.freeze([]),
        authorization: Object.freeze({assertAuthenticatedOrigin: () => { assertCurrent() }})})
    }
    // Receipt lookup precedes mutable floor/reattach/claim/lifecycle decisions.
    const probe = request(null, '0')
    const existing = await resolveManagedTerminalIngressReceipt(pool, probe)
    assertCurrent()
    if (existing.status === 'UNAVAILABLE') { throw new CatalogReadError('TERMINAL_RECEIPT_UNAVAILABLE') }
    if (existing.status === 'FOUND') { return committedWire(await applyManagedTerminalIngress(pool, probe)) }
    if (!resolved.chat) { throw new CatalogReadError('TERMINAL_MANAGED_RAW_NOT_CONNECTED') }
    const classification = classifyTerminalIngress(probe.snapshot)
    if (!['CLEAR', 'CHAT_FRAGMENT', 'CHAT_SUBMIT'].includes(classification.kind)) {
      throw new CatalogReadError('TERMINAL_SEMANTIC_NOT_CONNECTED')
    }
    const baseline = await withDurableTransaction(pool, async tx => {
      await lockAggregates(tx, {sessionIds: [resolved.sessionId]})
      assertCurrent()
      const floor = await readTerminalFloorInTransaction(tx, binding('0'))
      if (floor && (floor.binding.principalId !== principal || floor.binding.pairedDeviceId !== device || floor.binding.mode !== 'AGENT_CHAT_COMPAT')) {
        throw new CatalogReadError('TERMINAL_FLOOR_OWNED_BY_ANOTHER_CALLER')
      }
      const draft = floor ? await readTerminalDraftInTransaction(tx, floor.binding) : null
      assertCurrent()
      return {floor, draftRevision: draft?.draft.revision ?? '0'}
    })
    const pinned = await withDurableTransaction(pool, async tx => {
      await lockAggregates(tx, {sessionIds: [resolved.sessionId]})
      assertCurrent()
      const actual = await readTerminalFloorInTransaction(tx, binding('0'))
      if (baseline.floor) { assertTerminalFloorPin(actual, baseline.floor) }
      else if (actual) { throw new CatalogReadError('TERMINAL_STALE_FLOOR') }
      if (!baseline.floor) {
        // Actual authenticated socket + Session lock + absent PG floor only;
        // neither payload client identity nor an existing active owner is used.
        const floor = await claimTerminalFloorInTransaction(tx, binding('0'), null, {
          assertClaimAllowed: (_next, previous) => { assertCurrent(); if (previous) { throw new CatalogReadError('TERMINAL_FLOOR_TAKEOVER_NOT_ALLOWED') } },
          assertReattachAllowed: () => { throw new CatalogReadError('TERMINAL_REATTACH_REQUIRED') }
        })
        return {floor, draftRevision: '0'}
      }
      if (baseline.floor.binding.connectionId === incarnation) { return baseline }
      checkPrevious(baseline.floor.binding.connectionId, device, fingerprint)
      const reattached = await reattachTerminalFloorInTransaction(tx, {previous: baseline.floor,
        nextConnectionId: incarnation, expectedDraftRevision: baseline.draftRevision}, {
        assertClaimAllowed: () => { throw new CatalogReadError('TERMINAL_FLOOR_TAKEOVER_NOT_ALLOWED') },
        assertReattachAllowed: previous => { assertCurrent(); checkPrevious(previous.binding.connectionId, device, fingerprint) }
      })
      return {floor: reattached.floor, draftRevision: reattached.draft?.draft.revision ?? '0'}
    })
    assertCurrent()
    if (!pinned.floor) { throw new CatalogReadError('TERMINAL_FLOOR_UNAVAILABLE') }
    return committedWire(await applyManagedTerminalIngress(pool, request(pinned.floor, pinned.draftRevision)))
  }
}

function committedWire(outcome: Awaited<ReturnType<typeof applyManagedTerminalIngress>>) {
  const result = managedTerminalIngressWireResult(outcome)
  if (!result) { throw new CatalogReadError('TERMINAL_COMMIT_UNCERTAIN_RESOLVE_SAME_KEY') }
  return result
}
