type OrcadDurableCatalogCleanup = {
  stopRpc: () => Promise<void> | undefined
  stopAgentControlAdapter: () => void
  stopDaemon: () => Promise<void>
  uninstallObservedStatusIdentity: () => void
  uninstallHookStatusRepublish: () => void
  stopAgentHookServer: () => void
  stopDurableCatalog: () => Promise<void> | undefined
}

/** Preserve the original teardown barriers, including every finally/error path. */
export async function stopOrcadRuntimeWithDurableCatalog(cleanup: OrcadDurableCatalogCleanup): Promise<void> {
  try {
    try {
      await cleanup.stopRpc()
    } finally {
      try {
        cleanup.stopAgentControlAdapter()
        // Disconnect only: the persistent terminal daemon must outlive orcad.
        await cleanup.stopDaemon()
      } finally {
        cleanup.uninstallObservedStatusIdentity()
        cleanup.uninstallHookStatusRepublish()
        cleanup.stopAgentHookServer()
      }
    }
  } finally {
    // RPC shutdown disposes subscriptions before the startup-owned Pool closes.
    await cleanup.stopDurableCatalog()
  }
}
