import type { z } from 'zod'
import {
  WorktreeActivate, WorktreeListParams, WorktreePsParams, WorktreeRemove,
  WorktreeSelector, WorktreeSet
} from '../../../shared/rpc-contract/worktree-params.ts'
import { WorktreeCreate } from '../../../shared/rpc-contract/worktree-create-params.ts'
import {
  ActivateTab, CloseLifecycleTab, CloseTab, CreateTerminalTab, WorktreeTabSelector
} from '../../../shared/rpc-contract/session-tabs-schemas-params.ts'
import { TerminalFocus, TerminalHandle, TerminalRename } from '../../../shared/rpc-contract/terminal-unary-params.ts'
import { UiUpdate } from '../../../shared/rpc-contract/client-ui-params.ts'
import { BrowserTabCreateParams } from '../../../shared/rpc-contract/browser-tab-create-params.ts'
import type { BrowserTabCreateResult } from '../../../shared/runtime-browser-contracts.ts'
import type { Repo } from '../../../shared/repo-types.ts'
import type { ProjectGroup } from '../../../shared/project-group-types.ts'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types.ts'
import type { PairedUiState } from '../../../shared/pairing-local-ui-fields.ts'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types.ts'
import type {
  RuntimeWorktreeListResult, RuntimeWorktreeRecord, RuntimeWorktreePsResult,
  RuntimeWorktreePsConditionalResult, RuntimeWorktreeRemoveResult
} from '../../../shared/runtime-worktree-contracts.ts'
import type {
  RuntimeMobileSessionTabsResult, RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabCloseResult
} from '../../../shared/runtime-session-contracts.ts'
import type {
  RuntimeTerminalFocus, RuntimeTerminalRename, RuntimeTerminalClose
} from '../../../shared/runtime-terminal-contracts.ts'

/** Internal compatibility seam only. This is not registered in the public RPC server. */
export const catalogWireSchemas = {
  'repo.list': null,
  'projectGroup.list': null,
  'folderWorkspace.list': null,
  'worktree.list': WorktreeListParams,
  'worktree.ps': WorktreePsParams,
  'worktree.show': WorktreeSelector,
  'worktree.create': WorktreeCreate,
  'worktree.set': WorktreeSet,
  'worktree.activate': WorktreeActivate,
  'worktree.sleep': WorktreeSelector,
  'worktree.rm': WorktreeRemove,
  'ui.get': null,
  'ui.set': UiUpdate,
  'session.tabs.list': WorktreeTabSelector,
  'session.tabs.listAll': null,
  'session.tabs.createTerminal': CreateTerminalTab,
  'session.tabs.activate': ActivateTab,
  'session.tabs.close': CloseTab,
  'session.tabs.closeLifecycle': CloseLifecycleTab,
  'terminal.focus': TerminalFocus,
  'terminal.rename': TerminalRename,
  'terminal.close': TerminalHandle,
  'browser.tabCreate': BrowserTabCreateParams
} as const

export type CatalogMethod = keyof typeof catalogWireSchemas
export type CatalogParams<Method extends CatalogMethod> =
  (typeof catalogWireSchemas)[Method] extends z.ZodType
    ? z.output<Extract<(typeof catalogWireSchemas)[Method], z.ZodType>> : null

export type CatalogWireResults = {
  'repo.list': { repos: Repo[] }
  'projectGroup.list': { groups: ProjectGroup[] }
  'folderWorkspace.list': { folderWorkspaces: FolderWorkspace[] }
  'worktree.list': RuntimeWorktreeListResult
  'worktree.ps': RuntimeWorktreePsResult | RuntimeWorktreePsConditionalResult
  'worktree.show': { worktree: RuntimeWorktreeRecord }
  'worktree.create': CreateWorktreeResult & { agentTerminalHandle?: string }
  'worktree.set': { worktree: RuntimeWorktreeRecord }
  'worktree.activate': {
    repoId: string; worktreeId: string; activated: boolean
    sleepingAgentWake: 'requested' | 'unsupported-headless' | 'not-applicable'
  }
  'worktree.sleep': { worktreeId: string }
  'worktree.rm': RuntimeWorktreeRemoveResult
  'ui.get': { ui: PairedUiState }
  'ui.set': { ui: PairedUiState }
  'session.tabs.list': RuntimeMobileSessionTabsResult
  'session.tabs.listAll': { snapshots: RuntimeMobileSessionTabsResult[]; authoritative?: true }
  'session.tabs.createTerminal': RuntimeMobileSessionCreateTerminalResult
  'session.tabs.activate': RuntimeMobileSessionTabsResult
  'session.tabs.close': RuntimeMobileSessionTabCloseResult
  'session.tabs.closeLifecycle': RuntimeMobileSessionTabCloseResult
  'terminal.focus': { focus: RuntimeTerminalFocus }
  'terminal.rename': { rename: RuntimeTerminalRename }
  'terminal.close': { close: RuntimeTerminalClose }
  'browser.tabCreate': BrowserTabCreateResult
}
