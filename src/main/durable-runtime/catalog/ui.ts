import type { PairedUiState } from '../../../shared/pairing-local-ui-fields.ts'
import { omitPairingLocalUiFields } from '../../../shared/pairing-local-ui-fields.ts'
import { UiUpdateFields } from '../../../shared/rpc-contract/client-ui-params.ts'
import { captureCatalogJson } from './immutable.ts'
import { CatalogError } from './errors.ts'

/** This authenticated host Catalog does not store browser private-session credentials. */
export function catalogSharedUi(value: object): Record<string, unknown> {
  const { browserKagiSessionLink: _credential, ...shared } = omitPairingLocalUiFields(value) as Record<string, unknown>
  return captureCatalogJson(shared) as Record<string, unknown>
}

const required = ['lastActiveRepoId', 'lastActiveWorktreeId', 'activeView', 'sidebarWidth',
  'rightSidebarOpen', 'rightSidebarTab', 'rightSidebarExplorerView', 'rightSidebarWidth',
  'groupBy', 'sortBy', 'projectOrderBy', 'showActiveOnly', 'hideDefaultBranchWorkspace',
  'filterRepoIds', 'collapsedGroups', 'uiZoomLevel', 'editorFontZoomLevel', 'worktreeCardProperties',
  'statusBarItems', 'statusBarVisible', 'dismissedUpdateVersion', 'lastUpdateCheckAt'] as const

/** Initialized from explicit upper runtime UI defaults, never fabricated by a read. */
export function parseCatalogUi(input: object): PairedUiState {
  const shared = catalogSharedUi(input)
  for (const key of required) {
    if (!(key in shared)) {throw new CatalogError('CATALOG_UI_NOT_INITIALIZED')}
  }
  // Validate known fields while retaining incumbent persisted-only fields.
  const known = Object.fromEntries(Object.entries(shared).filter(([key]) => Object.hasOwn(UiUpdateFields.shape, key)))
  if (!UiUpdateFields.safeParse(known).success) {throw new CatalogError('CATALOG_UI_PAYLOAD')}
  return shared as unknown as PairedUiState
}
