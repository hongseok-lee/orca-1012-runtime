import type { Pool } from 'pg'
import type { SessionId, RuntimeUnitId } from '../../../shared/durable-runtime/identity.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { DurableTransaction } from '../db/connection.ts'
import type { MutationOutcome } from '../db/atomic.ts'
import type { InputAuthority } from '../input/types.ts'
import type { CatalogOwnerEntries } from './owners.ts'
import type { CatalogMembership } from './membership.ts'
import type { CatalogTab } from './read.ts'
import { captureCatalogJson, captureCatalogParsed } from './immutable.ts'
import { capturePreparedCatalogCall, lockCatalogWorkspaceMetadata, mutateCatalogWorkspace, publishCatalogMutation } from './mutation.ts'
import type { PreparedCatalogCall } from './request.ts'
import { loadCatalogTabs, resolveCatalogTab } from './metadata.ts'
import { parseCatalogTab } from './payload.ts'
import { CatalogError } from './errors.ts'

export type PreparedCatalogClose = {
  /** Existing authenticated Input authorities; no string-to-principal conversion. */
  readonly inputAuthorities: readonly InputAuthority[]
}

export function captureCatalogClose(input: PreparedCatalogClose): PreparedCatalogClose {
  return captureCatalogParsed(input) as PreparedCatalogClose
}

/** Fixed durable Messages; all cancel logic remains owned by P1-07. */
export async function cancelCatalogSessionMessages(
  tx: DurableTransaction, call: PreparedCatalogCall, tab: CatalogTab, membership: CatalogMembership,
  prepared: PreparedCatalogClose, owners: CatalogOwnerEntries
): Promise<void> {
  if (tab.session_id === null) return
  const sessionId = logicalId('session', tab.session_id)
  if (!tx.isLockHeld(1, sessionId) || !membership.workspaceSessions.includes(sessionId)) throw new CatalogError('CATALOG_SESSION_LOCK_REQUIRED')
  const unitId: RuntimeUnitId | null = membership.pairs.find(pair => pair.sessionId === sessionId)?.unitId ?? null
  const messages = (await tx.query<{ id: string }>(`SELECT id FROM durable_runtime.messages
    WHERE session_id=$1 AND cancel_requested_at IS NULL
    AND intake_status IN ('DURABLE','DISPATCH_INTENT','STAGED','EFFECT_POSSIBLE','ADMITTED','UNKNOWN','INTERRUPTED')
    ORDER BY seq,id`, [sessionId])).rows
  if (!messages.length) return
  const authority = prepared.inputAuthorities.find(item => item.sessionId === sessionId &&
    (item.scope.kind === 'SESSION' || item.scope.terminalHandle === tab.terminal_handle))
  if (!authority || authority.principal !== call.context.authority.principalId) throw new CatalogError('CATALOG_CANCEL_AUTHORITY_REQUIRED')
  for (const message of messages) {
    await owners.recordInputCancel(tx, { authority, method: call.method, operationKey: call.operationKey,
      targetMessageId: logicalId('message', message.id), originalPayload: call.original }, unitId)
  }
}

export async function closeCatalogTab(
  pool: Pool, input: PreparedCatalogCall<'session.tabs.close'> | PreparedCatalogCall<'terminal.close'>,
  workspaceSelector: string, prepared: PreparedCatalogClose, entries: CatalogOwnerEntries
): Promise<MutationOutcome> {
  const call = capturePreparedCatalogCall(input), close = captureCatalogClose(prepared)
  const owners = Object.freeze({ ...entries }), selector = workspaceSelector
  return mutateCatalogWorkspace(pool, call, selector, async (tx, workspace, membership) => {
    const target = resolveCatalogTab(await loadCatalogTabs(tx, workspace.workspace_id), call.params)
    if ('expectedIncarnationId' in call.params && call.params.expectedIncarnationId !== undefined &&
      target.payload.incarnationId !== call.params.expectedIncarnationId) throw new CatalogError('CATALOG_STALE_TERMINAL')
    if (target.lifecycle === 'OPEN') {
      // Cancel's authorization still sees OPEN. Tombstone and new-input block follow
      // in the same outer transaction; no caller can observe an intermediate commit.
      await cancelCatalogSessionMessages(tx, call, target, membership, close, owners)
    }
    await lockCatalogWorkspaceMetadata(tx, membership)
    const current = resolveCatalogTab(await loadCatalogTabs(tx, workspace.workspace_id), { tabId: target.public_tab_id })
    if (current.lifecycle === 'OPEN') {
      if (current.session_id) await tx.query(`UPDATE durable_runtime.sessions SET lifecycle='CLOSING',
        session_fence=session_fence+1,revision=revision+1 WHERE id=$1 AND lifecycle='OPEN'`, [current.session_id])
      await tx.query("UPDATE durable_runtime.tabs SET lifecycle='CLOSED',closed_at=clock_timestamp(),revision=revision+1 WHERE id=$1 AND lifecycle='OPEN'", [current.tab_id])
      await tx.query('UPDATE durable_runtime.catalog_tab_metadata SET payload=$2,updated_at=clock_timestamp() WHERE tab_id=$1',
        [current.tab_id, JSON.stringify({ ...current.payload, isActive: false })])
      await publishCatalogMutation(tx, call, workspace.workspace_id, 'CATALOG_TAB_CLOSED', { tabId: current.public_tab_id })
    }
    if (call.method === 'terminal.close') {
      const tab = parseCatalogTab(current)
      if (tab.type !== 'terminal') throw new CatalogError('CATALOG_TERMINAL_REQUIRED')
      return { close: { handle: current.terminal_handle!, tabId: tab.parentTabId, closeMode: 'tab', ptyKilled: false,
        ptyStopVerdict: 'unverifiable', ptyStopReason: 'physical-stop-not-observed' } }
    }
    return { closed: true }
  })
}
