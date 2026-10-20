import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import type { RpcClient } from '../transport/rpc-client'
import {
  loadDefaultSessionView,
  readSessionViewOverridesPreference,
  updateSessionViewOverride,
  type MobileSessionView,
  type SessionViewOverridesPreference
} from '../storage/session-view-preferences'

type ViewOverridesState = {
  hostId: string
  worktreeId: string
  overrides: Map<string, MobileSessionView>
  loaded: boolean
}

type ViewOverridesRuntime = {
  hostId: string
  worktreeId: string
  loadPromise: Promise<SessionViewOverridesPreference>
  currentOverrides: Map<string, MobileSessionView>
  mutationRevisions: Map<string, number>
}

function isOverrideScope(state: ViewOverridesState, hostId: string, worktreeId: string): boolean {
  return state.hostId === hostId && state.worktreeId === worktreeId
}

function mergeOverrides(
  persisted: ReadonlyMap<string, MobileSessionView>,
  current: ReadonlyMap<string, MobileSessionView>
): Map<string, MobileSessionView> {
  const merged = new Map(persisted)
  for (const [tabId, view] of current) {
    merged.set(tabId, view)
  }
  return merged
}

export type MobileSessionViewModeController = {
  /** Whether a tab's effective view is chat (per-tab override, else the default). */
  isTabChatView: (tabId: string) => boolean
  toggleTabChatView: (tabId: string) => void
}

/** Resolves each tab's terminal/chat view: a per-device default (reloaded on focus
 *  so a Settings change applies without remounting the route) overlaid by persisted
 *  per-tab overrides that pin a session regardless of what the default later becomes. */
export function useMobileSessionViewMode(args: {
  hostId: string
  worktreeId: string
  serverTabs?: readonly { id: string; type: string; viewMode?: MobileSessionView }[]
  client?: Pick<RpcClient, 'sendRequest'> | null
  onModeError?: (message: string) => void
}): MobileSessionViewModeController {
  const { hostId, worktreeId, serverTabs, client, onModeError } = args
  const pendingServerModes = useRef(new Set<string>())
  const [viewOverridesState, setViewOverridesState] = useState<ViewOverridesState>(() => ({
    hostId,
    worktreeId,
    overrides: new Map(),
    loaded: false
  }))
  const viewOverridesStateRef = useRef(viewOverridesState)
  viewOverridesStateRef.current = viewOverridesState
  const viewOverridesRuntimeRef = useRef<ViewOverridesRuntime | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const ensureViewOverridesRuntime = useCallback((scopeHostId: string, scopeWorktreeId: string) => {
    const current = viewOverridesRuntimeRef.current
    if (current?.hostId === scopeHostId && current.worktreeId === scopeWorktreeId) {
      return current
    }
    const next: ViewOverridesRuntime = {
      hostId: scopeHostId,
      worktreeId: scopeWorktreeId,
      loadPromise: readSessionViewOverridesPreference(scopeHostId, scopeWorktreeId),
      currentOverrides: new Map(),
      mutationRevisions: new Map()
    }
    viewOverridesRuntimeRef.current = next
    return next
  }, [])
  const [defaultView, setDefaultView] = useState<MobileSessionView>('terminal')
  // Why: the toggle callback reads the live default without depending on it, so
  // its identity stays stable and it never captures a stale default.
  const defaultViewRef = useRef(defaultView)
  defaultViewRef.current = defaultView

  useEffect(() => {
    let active = true
    const runtime = ensureViewOverridesRuntime(hostId, worktreeId)
    void runtime.loadPromise.then((preference) => {
      if (!active) {
        return
      }
      // Why: toggles made during the read are authoritative, but must not
      // discard unrelated persisted overrides from the same worktree.
      const merged = mergeOverrides(preference.overrides, runtime.currentOverrides)
      runtime.currentOverrides = merged
      // Why: an unreadable override store cannot safely be treated as empty when
      // the default is chat; fail closed to terminal until a user toggles.
      const next = { hostId, worktreeId, overrides: merged, loaded: preference.loaded }
      viewOverridesStateRef.current = next
      setViewOverridesState(next)
    })
    return () => {
      active = false
    }
  }, [ensureViewOverridesRuntime, hostId, worktreeId])

  // Why: reload on focus so returning from Settings picks up a changed default.
  useFocusEffect(
    useCallback(() => {
      let active = true
      void loadDefaultSessionView().then((view) => {
        if (active) {
          setDefaultView(view)
        }
      })
      return () => {
        active = false
      }
    }, [])
  )

  const isTabChatView = useCallback(
    (tabId: string): boolean => {
      const tab = serverTabs?.find((entry) => entry.id === tabId && entry.type === 'terminal')
      // A server-advertised mode is authoritative across devices and reconnects.
      if (tab?.viewMode !== undefined) {
        return tab.viewMode === 'chat'
      }
      if (!isOverrideScope(viewOverridesState, hostId, worktreeId)) {
        return false
      }
      const override = viewOverridesState.overrides.get(tabId)
      // Until this scope loads, only an immediate user toggle is authoritative;
      // defaulting other tabs to terminal avoids activating stale cross-host chat.
      return (override ?? (viewOverridesState.loaded ? defaultView : 'terminal')) === 'chat'
    },
    [defaultView, hostId, serverTabs, viewOverridesState, worktreeId]
  )

  const toggleTabChatView = useCallback(
    (tabId: string) => {
      const tab = serverTabs?.find((entry) => entry.id === tabId && entry.type === 'terminal')
      if (tab?.viewMode !== undefined) {
        const key = JSON.stringify([hostId, worktreeId, tabId])
        if (pendingServerModes.current.has(key)) {
          return
        }
        if (!client) {
          onModeError?.('View change not sent (disconnected)')
          return
        }
        pendingServerModes.current.add(key)
        // Do not optimistically expose a composer whose input the host still
        // treats as raw bytes. The normal tabs stream publishes committed mode.
        void client.sendRequest('session.tabs.setTabProps', {
          worktree: `id:${worktreeId}`,
          tabId,
          viewMode: tab.viewMode === 'chat' ? 'terminal' : 'chat'
        }, { failWhenDisconnected: true }).then((response) => {
          if (!response.ok) {
            onModeError?.('Could not change session view')
          }
        }, () => onModeError?.('View change unconfirmed; reconnect to refresh session state'))
          .finally(() => pendingServerModes.current.delete(key))
        return
      }
      const current = viewOverridesStateRef.current
      const currentScope = isOverrideScope(current, hostId, worktreeId)
        ? current
        : {
            hostId,
            worktreeId,
            overrides: new Map<string, MobileSessionView>(),
            loaded: false
          }
      const overrides = new Map(currentScope.overrides)
      // Flip from the tab's effective view (its override, else the default), so
      // a tab following a chat default can still be pinned back to terminal.
      const fallbackView = currentScope.loaded ? defaultViewRef.current : 'terminal'
      const currentlyChat = (overrides.get(tabId) ?? fallbackView) === 'chat'
      const nextView = currentlyChat ? 'terminal' : 'chat'
      overrides.set(tabId, nextView)
      const next = { ...currentScope, overrides }
      viewOverridesStateRef.current = next
      setViewOverridesState(next)

      const runtime = ensureViewOverridesRuntime(hostId, worktreeId)
      runtime.currentOverrides = overrides
      const revision = (runtime.mutationRevisions.get(tabId) ?? 0) + 1
      runtime.mutationRevisions.set(tabId, revision)
      // Why: enqueue the individual mutation immediately so a remounted route
      // cannot reorder it or replace unrelated overrides with a stale snapshot.
      void updateSessionViewOverride(hostId, worktreeId, tabId, nextView).catch(async () => {
        if (!mountedRef.current || viewOverridesRuntimeRef.current !== runtime) {
          return
        }
        const preference = await readSessionViewOverridesPreference(hostId, worktreeId)
        // Why: a failed older write must not roll back a newer choice for this tab.
        if (
          !mountedRef.current ||
          viewOverridesRuntimeRef.current !== runtime ||
          runtime.mutationRevisions.get(tabId) !== revision
        ) {
          return
        }
        // Why: if recovery is also unreadable, fail closed instead of treating an
        // unknown store as empty or restoring an earlier optimistic mutation.
        const reconciled = preference.loaded
          ? mergeOverrides(preference.overrides, runtime.currentOverrides)
          : new Map(runtime.currentOverrides)
        const recoveredOverride = preference.loaded ? preference.overrides.get(tabId) : 'terminal'
        if (recoveredOverride) {
          reconciled.set(tabId, recoveredOverride)
        } else {
          reconciled.delete(tabId)
        }
        runtime.currentOverrides = reconciled
        const latest = viewOverridesStateRef.current
        if (!isOverrideScope(latest, hostId, worktreeId)) {
          return
        }
        const reconciledState = { ...latest, overrides: reconciled, loaded: preference.loaded }
        viewOverridesStateRef.current = reconciledState
        setViewOverridesState(reconciledState)
      })
    },
    [client, ensureViewOverridesRuntime, hostId, onModeError, serverTabs, worktreeId]
  )

  return { isTabChatView, toggleTabChatView }
}
