import type { Store } from '../persistence'
import type { InitialCodexNativeSettings } from '../durable-runtime/runtime/initial-codex-native-policy.ts'
import { createManagedCodexCredentialOwner } from '../durable-runtime/providers/codex/managed-credential-owner.ts'
import { getPersistedCodexPaneAccount, recordCodexPaneAccount } from '../codex/codex-pane-account-registry'
/** Compose the existing product settings and persisted account owner once.
 * All initial/resume/adopted control paths receive this same source authority. */
export function createOrcadManagedProviderSettings(store: Store, userDataPath: string) {
  const owner = createManagedCodexCredentialOwner({ userDataPath, getSettings: () => store.getSettings(),
    readOwner: getPersistedCodexPaneAccount, recordOwner: recordCodexPaneAccount })
  const readSettings = (): InitialCodexNativeSettings => {
    const settings = store.getSettings()
    return { agentDefaultArgs: settings.agentDefaultArgs, agentDefaultEnv: settings.agentDefaultEnv,
      nativeChatSessionOptions: settings.nativeChatSessionOptions }
  }
  return Object.freeze({ readSettings, readCredential: owner.read })
}
