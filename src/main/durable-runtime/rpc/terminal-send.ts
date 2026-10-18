import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { TerminalSend } from '../../../shared/rpc-contract/terminal-unary-params.ts'
import type { RpcContext } from '../../runtime/rpc/core.ts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { withDurableTransaction, runDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { resolveCatalogWorkspace, type CatalogTab } from '../catalog/read.ts'
import { parseCatalogTab, parseCatalogWorkspace, parseCatalogRepo } from '../catalog/payload.ts'
import { getRepoExecutionHostId, getWorktreeExecutionHostId } from '../../../shared/execution-host.ts'
import { projectCatalogWorktree } from '../catalog/projection.ts'
import type { CatalogRepositoryRow } from '../db/rows.ts'
import { captureCatalogReadContext } from './context.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import { capturedJson } from '../structured/durable-common.ts'
import { applyManagedTerminalIngress, resolveManagedTerminalIngressReceipt, managedTerminalIngressWireResult } from '../terminal/managed-ingress.ts'
import { snapshotUnaryTerminalIngress, classifyTerminalIngress } from '../terminal/ingress.ts'
import { readTerminalFloorInTransaction, claimTerminalFloorInTransaction, assertTerminalFloorPin } from '../terminal/floor-repository.ts'
import { reattachTerminalFloorInTransaction } from '../terminal/floor-reattach.ts'
import { readTerminalDraftInTransaction } from '../terminal/draft-repository.ts'
import type { TerminalDraftBinding } from '../terminal/types.ts'
import { TerminalDraftStoreError, type ManagedTerminalIngressRequest, type TerminalFloorPin } from '../terminal/durable-contracts.ts'
import { assertManagedCatalogTarget } from '../terminal/catalog-target.ts'
import type { TerminalInputCommittedSink } from '../input/runtime-input-types.ts'

/** Existing unary schema only. The optional internal sink observes confirmed
 * new intake; provider work never delays or changes this original ACK. */
export function createCatalogTerminalSendRpc(config: CapturedCatalogReadConfig, onCommitted?: TerminalInputCommittedSink) {
  const owner = config.pool, connect = owner.connect.bind(owner), query = owner.query.bind(owner)
  const pool = new Proxy(owner, {get(target, key) {
    if (key === 'connect') { return connect }
    if (key === 'query') { return query }
    return Reflect.get(target, key, target)
  }})
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
    const capturedDevice = connection?.pairedDeviceId, capturedFingerprint = connection?.authenticatedCallerFingerprint
    const reserveLogicalFloor = connection?.reserveLogicalFloor.bind(connection)
    const runOrderedInput = connection?.runOrderedInput.bind(connection)
    const capturedContext = { ...context, clientCapabilities: transport.clientCapabilities }
    const assertCurrent = (): void => {
      currentHost()
      if (!checkConnection || signal?.aborted || capturedDevice !== device ||
          capturedFingerprint !== fingerprint) { throw new TerminalDraftStoreError('TERMINAL_AUTHENTICATED_CONNECTION_REQUIRED') }
      checkConnection()
    }
    const execute = async (resolveOnly: boolean): Promise<unknown> => {
      currentHost()
      const resolved = await withDurableTransaction(pool, async tx => {
        const owned = await tx.query('SELECT id FROM durable_runtime.tabs WHERE terminal_handle=$1', [params.terminal])
        if (owned.rows.length === 0) { return null }
        const found = await tx.query<CatalogTab & {public_id: string; provider: string | null; session_fence: string; dataset_name: string; agent_dataset: string | null}>(
          `SELECT m.*,t.workspace_id,t.session_id,t.kind,t.terminal_handle,t.lifecycle,t.revision AS tab_revision,
           w.public_id,w.dataset_name,s.session_fence,g.provider,g.dataset_name AS agent_dataset FROM durable_runtime.tabs t
           JOIN durable_runtime.catalog_tab_metadata m ON m.tab_id=t.id
           LEFT JOIN durable_runtime.sessions s ON s.id=t.session_id LEFT JOIN durable_runtime.agents g ON g.id=s.agent_id
           JOIN durable_runtime.workspaces w ON w.id=t.workspace_id WHERE t.terminal_handle=$1`, [params.terminal])
        if (found.rows.length !== 1) { throw new TerminalDraftStoreError('TERMINAL_MANAGED_TARGET_INCOMPLETE') }
        assertCurrent()
        const row = found.rows[0], call = captureCatalogReadContext(config, transport)
        const dataset = await tx.query<{dataset_name: string}>('SELECT dataset_name FROM durable_runtime.dataset_metadata')
        if (dataset.rows.length !== 1 || dataset.rows[0].dataset_name !== config.datasetName || row.dataset_name !== config.datasetName || row.agent_dataset !== config.datasetName || !row.session_id) {
          throw new TerminalDraftStoreError('CATALOG_DATASET_MISMATCH')
        }
        const workspace = await resolveCatalogWorkspace(tx, `id:${row.public_id}`, call.authority)
        if (workspace.workspace_id !== row.workspace_id) { throw new TerminalDraftStoreError('TERMINAL_WORKSPACE_SCOPE') }
        parseCatalogWorkspace(workspace)
        let repository: ReturnType<typeof parseCatalogRepo> | undefined
        if (workspace.repo_id !== null) {
          const stored = (await tx.query<CatalogRepositoryRow>('SELECT * FROM durable_runtime.catalog_repositories WHERE id=$1', [workspace.repo_id])).rows[0]
          if (!stored) { throw new TerminalDraftStoreError('CATALOG_REPOSITORY_UNAVAILABLE') }
          repository = parseCatalogRepo(stored)
          if (getRepoExecutionHostId(repository) !== config.hostId) { throw new TerminalDraftStoreError('CATALOG_REGISTRATION_HOST_MISMATCH') }
        }
        if (getWorktreeExecutionHostId(projectCatalogWorktree(workspace), repository) !== config.hostId) { throw new TerminalDraftStoreError('CATALOG_REGISTRATION_HOST_MISMATCH') }
        const tab = parseCatalogTab(row)
        const chat = tab.type === 'terminal' && (row.provider === 'claude' || row.provider === 'codex') && tab.viewMode === 'chat'
        return Object.freeze({sessionId: logicalId('session', row.session_id), sessionFence: counter('session-fence', row.session_fence), chat,
          targetPin: Object.freeze({tabId: row.tab_id, tabRevision: row.tab_revision, bindingRevision: row.binding_revision,
            provider: row.provider, payload: capturedJson(row.payload)})})
      })
      currentHost()
      if (!resolved) {
        if (resolveOnly) { throw new TerminalDraftStoreError('TERMINAL_COMMIT_UNCERTAIN_RESOLVE_SAME_KEY') }
        return legacy(params as never, capturedContext)
      }
      assertCurrent()
      if (!fingerprint || !device || !incarnation || !requestId || !checkPrevious || !reserveLogicalFloor) { throw new TerminalDraftStoreError('TERMINAL_AUTHENTICATED_CONNECTION_REQUIRED') }
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
          ...(resolved.chat ? {catalogTargetPin: resolved.targetPin} : {}),
          authorization: Object.freeze({assertAuthenticatedOrigin: () => { assertCurrent() }})})
      }
      // Receipt lookup precedes mutable floor/reattach/claim/lifecycle decisions.
      const probe = request(null, '0')
      const existing = await resolveManagedTerminalIngressReceipt(pool, probe)
      assertCurrent()
      if (existing.status === 'UNAVAILABLE') { throw new TerminalDraftStoreError('TERMINAL_RECEIPT_UNAVAILABLE') }
      if (existing.status === 'FOUND') { return committedWire(await applyManagedTerminalIngress(pool, probe)) }
      if (resolveOnly) { throw new TerminalDraftStoreError('TERMINAL_COMMIT_UNCERTAIN_RESOLVE_SAME_KEY') }
      if (!resolved.chat) { throw new TerminalDraftStoreError('TERMINAL_MANAGED_RAW_NOT_CONNECTED') }
      const classification = classifyTerminalIngress(probe.snapshot)
      if (!['CLEAR', 'CHAT_FRAGMENT', 'CHAT_SUBMIT'].includes(classification.kind)) {
        throw new TerminalDraftStoreError('TERMINAL_SEMANTIC_NOT_CONNECTED')
      }
      const baseline = await withDurableTransaction(pool, async tx => {
        await lockAggregates(tx, {sessionIds: [resolved.sessionId]})
        assertCurrent()
        const floor = await readTerminalFloorInTransaction(tx, binding('0'))
        if (floor && floor.binding.mode !== 'AGENT_CHAT_COMPAT') { throw new TerminalDraftStoreError('TERMINAL_FLOOR_OWNED_BY_ANOTHER_CALLER') }
        // Another device/caller holds the floor: this sender takes it over at
        // the next generation (last sender wins). Its unsent draft stays its own.
        const foreign = !!floor && (floor.binding.principalId !== principal || floor.binding.pairedDeviceId !== device)
        const draft = floor && !foreign ? await readTerminalDraftInTransaction(tx, floor.binding) : null
        assertCurrent()
        return {floor, foreign, draftRevision: draft?.draft.revision ?? '0'}
      })
      const logicalGrant = reserveLogicalFloor({handle: params.terminal, sessionId: resolved.sessionId, mode: 'AGENT_CHAT_COMPAT'},
        baseline.floor?.binding.connectionId ?? null, baseline.foreign)
      const acquired = await runDurableTransaction(pool, async tx => {
        await lockAggregates(tx, {sessionIds: [resolved.sessionId]})
        assertCurrent(); logicalGrant.assertCurrent()
        await assertManagedCatalogTarget(tx, resolved.targetPin, binding('0'))
        const actual = await readTerminalFloorInTransaction(tx, binding('0'))
        if (baseline.floor) { assertTerminalFloorPin(actual, baseline.floor) }
        else if (actual) { throw new TerminalDraftStoreError('TERMINAL_STALE_FLOOR') }
        if (!baseline.floor) {
          // The concrete logical input owner reserved this exact target first;
          // Session-locked CAS now persists it. This is not a native PTY grant.
          const floor = await claimTerminalFloorInTransaction(tx, binding('0'), null, {
            assertClaimAllowed: (_next, previous) => { assertCurrent(); logicalGrant.assertCurrent(); if (previous) { throw new TerminalDraftStoreError('TERMINAL_FLOOR_TAKEOVER_NOT_ALLOWED') } },
            assertReattachAllowed: () => { throw new TerminalDraftStoreError('TERMINAL_REATTACH_REQUIRED') }
          })
          return {floor, draftRevision: '0'}
        }
        if (baseline.foreign) {
          const next = binding((BigInt(baseline.floor.binding.floorGeneration) + 1n).toString())
          const floor = await claimTerminalFloorInTransaction(tx, next, baseline.floor, {
            assertClaimAllowed: (_next, previous) => { assertCurrent(); logicalGrant.assertCurrent(); if (!previous) { throw new TerminalDraftStoreError('TERMINAL_STALE_FLOOR') } },
            assertReattachAllowed: () => { throw new TerminalDraftStoreError('TERMINAL_REATTACH_REQUIRED') }
          })
          return {floor, draftRevision: '0'}
        }
        if (baseline.floor.binding.connectionId === incarnation) { return baseline }
        checkPrevious(baseline.floor.binding.connectionId, device, fingerprint)
        const reattached = await reattachTerminalFloorInTransaction(tx, {previous: baseline.floor,
          nextConnectionId: incarnation, expectedDraftRevision: baseline.draftRevision}, {
          assertClaimAllowed: () => { throw new TerminalDraftStoreError('TERMINAL_FLOOR_TAKEOVER_NOT_ALLOWED') },
          assertReattachAllowed: previous => { assertCurrent(); logicalGrant.assertCurrent(); checkPrevious(previous.binding.connectionId, device, fingerprint) }
        })
        return {floor: reattached.floor, draftRevision: reattached.draft?.draft.revision ?? '0'}
      })
      if (!acquired.ok) {
        if (acquired.commitOutcome === 'UNKNOWN') { throw new TerminalDraftStoreError('TERMINAL_FLOOR_COMMIT_UNCERTAIN') }
        if (acquired.settlement === 'ROLLED_BACK' || acquired.settlement === 'NOT_STARTED') { logicalGrant.rollbackConfirmed() }
        throw acquired.error
      }
      logicalGrant.commit()
      const pinned = acquired.value
      assertCurrent()
      if (!pinned.floor) { throw new TerminalDraftStoreError('TERMINAL_FLOOR_UNAVAILABLE') }
      const submitted = request(pinned.floor, pinned.draftRevision)
      const outcome = await applyManagedTerminalIngress(pool, submitted)
      const result = committedWire(outcome)
      if (onCommitted && outcome.status === 'COMMITTED' && outcome.receipt.response &&
          typeof outcome.receipt.response === 'object' && !Array.isArray(outcome.receipt.response) &&
          outcome.receipt.response.kind === 'SUBMITTED') {
        try {
          onCommitted(Object.freeze({authority: submitted.authority, binding: submitted.snapshot.scope.binding,
            targetPin: resolved.targetPin, receipt: outcome.receipt,
            sessionFence: submitted.sessionFence}))
        } catch {
          // Intake has committed. Keep its receipt/input/outbox and original ACK;
          // notification failure is never permission to re-intake or delete it.
        }
      }
      return result
    }
    return runOrderedInput && incarnation && requestId
      ? runOrderedInput(params.terminal, JSON.stringify(['UNARY', incarnation, requestId]), execute)
      : execute(false)
  }
}

function committedWire(outcome: Awaited<ReturnType<typeof applyManagedTerminalIngress>>) {
  const result = managedTerminalIngressWireResult(outcome)
  if (!result) { throw new TerminalDraftStoreError('TERMINAL_COMMIT_UNCERTAIN_RESOLVE_SAME_KEY') }
  return result
}
