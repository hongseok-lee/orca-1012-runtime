import type { RuntimeMobileSessionAgentTab } from '../../../shared/runtime-mobile-session-tab-contracts.ts'
import type { TabId, SessionId, OperationId } from '../../../shared/durable-runtime/identity.ts'
import type { CatalogAuthority } from './authority.ts'
import type { CatalogMembership } from './membership.ts'
import type { CatalogWorkspace } from './read.ts'
import type { CatalogRuntimeLaunch } from './runtime-launch.ts'

export type PreparedCatalogAgentSession = {
  readonly authority: CatalogAuthority
  /** Exact routing identity selected by the upper authorized resolver. */
  readonly workspace: Pick<CatalogWorkspace, 'workspace_id' | 'public_id' | 'repo_id' | 'project_group_id'>
  readonly membership: CatalogMembership
  readonly unitPeers: readonly SessionId[]
  readonly publicSessionId: string
  readonly operationKey: string
  readonly runtime: Omit<CatalogRuntimeLaunch, 'agent'> & {
    readonly agent: CatalogRuntimeLaunch['agent'] & { readonly provider: 'claude' | 'codex' }
  }
  readonly tab: { readonly id: TabId; readonly uiOrder: number; readonly payload: RuntimeMobileSessionAgentTab }
  /** Original structured intent, including supplied policy/version metadata. */
  readonly originalRequest: Record<string, unknown>
}

export type CatalogAgentSessionReservation = {
  readonly sessionId: SessionId
  readonly tabId: TabId
  readonly tab: RuntimeMobileSessionAgentTab
  readonly publicationEpoch: string
  readonly snapshotVersion: number
  readonly operationId: OperationId
}
