import type { Pool } from 'pg'
import type { RpcContext, RpcStreamingMethodDeclaration } from '../../runtime/rpc/core.ts'
import { Screencast } from '../../../shared/rpc-contract/browser-params.ts'
import { createBrowserOpsAuthAttempt } from '../../runtime/browser-ops-auth-capability.ts'
import { captureCatalogBrowserOpsAuth } from './browser-ops-auth-config.ts'
import { catalogBrowserMaterialization, readCatalogBrowserState } from './browser-create-state.ts'
import { captureCatalogAuthenticatedContext } from './context.ts'
import { CatalogReadError, catalogReadFailure, type CapturedCatalogReadConfig } from './config.ts'
import { CatalogError } from '../catalog/errors.ts'

type OriginalStream = RpcStreamingMethodDeclaration['handler']

/** Capture only the original screencast handler's context; never freeze its borrowed runtime. */
function captureStreamContext(context: RpcContext): { context: RpcContext; runtime: RpcContext['runtime'] } {
  const runtime = context.runtime
  const screencast = runtime.browserScreencast.bind(runtime)
  const carrier: typeof runtime = Object.create(runtime)
  const capturedRuntime = new Proxy(carrier, { get(_target, property) {
    return property === 'browserScreencast' ? screencast : Reflect.get(runtime, property, runtime)
  } })
  const capabilities = context.clientCapabilities
  const captured = Object.freeze({ runtime: capturedRuntime, signal: context.signal,
    connectionId: context.connectionId, requestId: context.requestId, clientId: context.clientId,
    pairedDeviceId: context.pairedDeviceId, clientKind: context.clientKind,
    sendBinary: context.sendBinary, authenticatedCallerFingerprint: context.authenticatedCallerFingerprint,
    clientCapabilities: capabilities === undefined ? undefined : Object.freeze([...capabilities]) })
  return { context: captured, runtime }
}

/** Authenticated on-demand materialization only; no reservation, retry, startup scan or PG write. */
export function createCatalogBrowserStreamRecovery(input: CapturedCatalogReadConfig, requireOpen: () => void) {
  const ownerPool = input.pool, connect = ownerPool.connect.bind(ownerPool)
  const assertCurrentHost = input.assertCurrentHost.bind(input)
  const carrier: Pool = Object.create(ownerPool)
  const pool = new Proxy(carrier, { get(_target, property) {
    if (property === 'connect') { return connect }
    const value = Reflect.get(ownerPool, property, ownerPool)
    return typeof value === 'function' ? value.bind(ownerPool) : value
  } })
  const browserOpsAuth = captureCatalogBrowserOpsAuth(Object.getOwnPropertyDescriptor(input, 'browserOpsAuth'))
  const config = Object.freeze({ ...input, pool, assertCurrentHost, browserOpsAuth })
  const pending = new Set<() => void>()
  let disposed = false
  return Object.freeze({
    async subscribe(params: unknown, context: RpcContext, emit: (frame: unknown) => void, original: OriginalStream): Promise<void> {
      const capturedParams = Object.freeze(Screencast.parse(params))
      const captured = captureStreamContext(context), capturedContext = captured.context
      const capturedEmit = emit, stream = original
      const signal = capturedContext.signal
      let cancelled = false
      const assertActive = () => {
        requireOpen()
        if (disposed) { throw new CatalogReadError('CATALOG_ADAPTER_DISPOSED') }
        if (cancelled || signal?.aborted) { throw new CatalogReadError('CATALOG_BROWSER_STREAM_ABORTED') }
      }
      assertActive()
      // Empty/omitted selectors retain the old screencast meaning, including worktree ''.
      if (capturedParams.worktree && capturedParams.page) {
        const authenticated = captureCatalogAuthenticatedContext(config, capturedContext)
        const call = Object.freeze({ context: authenticated.context })
        const page = capturedParams.page, selector = capturedParams.worktree
        // Capture the native method and receiver before the first PG await as well.
        const runtime = captured.runtime
        const show = runtime.browserTabShow.bind(runtime)
        const create = runtime.browserTabCreate.bind(runtime)
        const caller = Object.freeze({ pairedDeviceId: capturedContext.pairedDeviceId, clientKind: capturedContext.clientKind })
        let auth: ReturnType<typeof createBrowserOpsAuthAttempt> | undefined
        let cleanup: Promise<void> | undefined
        const cancel = () => { cancelled = true; cleanup ??= auth?.disposeCreated() }
        pending.add(cancel)
        signal?.addEventListener('abort', cancel, { once: true })
        try {
          assertActive()
          const state = await readCatalogBrowserState(config, call, selector, page)
          assertActive()
          const tab = state.tab!
          if (tab.lifecycle !== 'OPEN' || state.workspace.deleted_at !== null) {
            throw new CatalogError('CATALOG_BROWSER_CLOSED_BEFORE_STREAM')
          }
          const materialize = catalogBrowserMaterialization(state.workspace, tab)
          let absent = false
          try {
            const shown = await show({ worktree: materialize.worktree, page })
            if (shown.tab.browserPageId !== page || shown.tab.worktreeId !== state.workspace.public_id) {
              throw new CatalogError('CATALOG_BROWSER_NATIVE_PAGE_MISMATCH')
            }
          } catch (error) {
            const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
            if (code !== 'browser_no_tab' && code !== 'browser_tab_closed') { throw error }
            absent = true
          }
          assertActive()
          if (absent) {
            auth = browserOpsAuth && createBrowserOpsAuthAttempt(browserOpsAuth, {
              authenticatedCallerFingerprint: authenticated.authenticatedCallerFingerprint,
              browserPageId: page, worktreePublicId: state.workspace.public_id
            })
            // 'none' is not a navigation value. activate:false makes selects/focusesHost false.
            const result = await create({ ...materialize, activate: false, navigation: 'caller', waitForRegistration: false },
              Object.freeze({ ...caller, ...(auth ? { opsAuth: auth.capability } : {}) }))
            assertActive()
            if (result.browserPageId !== page) { throw new CatalogError('CATALOG_BROWSER_NATIVE_PAGE_MISMATCH') }
          }
          assertActive()
          assertCurrentHost()
          const current = await readCatalogBrowserState(config, call, `id:${state.workspace.public_id}`, page)
          assertActive()
          if (current.workspace.workspace_id !== state.workspace.workspace_id ||
              current.workspace.public_id !== state.workspace.public_id || current.tab!.tab_id !== tab.tab_id) {
            throw new CatalogError('CATALOG_BROWSER_IDENTITY_CHANGED')
          }
          if (current.tab!.lifecycle !== 'OPEN' || current.workspace.deleted_at !== null) {
            throw new CatalogError('CATALOG_BROWSER_CLOSED_DURING_STREAM_PREPARATION_CLEANUP_UNVERIFIED')
          }
        } catch (error) {
          // Reused owners register no new cleanup; no generation-blind native close.
          await (cleanup ?? auth?.disposeCreated())
          throw catalogReadFailure(error)
        } finally {
          pending.delete(cancel)
          signal?.removeEventListener('abort', cancel)
        }
      }
      // Preparation ownership ends here. Normal completion/error/cancel belongs to
      // the original stream and must not revoke an otherwise OPEN page's Ops owner.
      await stream(capturedParams as never, capturedContext, capturedEmit)
    },
    dispose(): void {
      if (disposed) { return }
      disposed = true
      for (const cancel of pending) { cancel() }
    }
  })
}
