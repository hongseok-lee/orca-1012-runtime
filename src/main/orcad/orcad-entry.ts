/**
 * `orcad` — the Orca runtime served from plain Node, with no Electron.
 *
 * Installs the Node host adapters, constructs the same `OrcaRuntimeService` the
 * desktop uses, installs a PTY controller via `registerHeadlessPtyRuntime`, and
 * serves runtime RPC. See docs/design/node-only-runtime-backend.html.
 *
 * Desktop UI surfaces stay uninstalled: no native notifications, no renderer window. The
 * renderer window is faked as a destroyed one because `registerPtyHandlers` takes a
 * non-null `BrowserWindow`. Browser automation is different — it is installed through
 * the runtime factory, but only when an Electron serve sidecar or an operator-supplied
 * Chromium proves available at startup.
 */
import process from 'node:process'
import { setAppEnvironment, type AppEnvironment } from '../../shared/app-environment'
import { setSecretStore, type SecretStore } from '../../shared/secret-store'
import type { ServePairingReadiness, ServeReadiness } from '../server/serve-readiness'
import { mintOrcadPairingOffers, resolveOrcadPairingScopes } from './orcad-pairing'
import { setRuntimeBrowserCommandsFactory } from '../runtime/runtime-browser-commands-factory'
import { resolveOrcadBrowserProvider, type OrcadBrowserProvider } from './orcad-browser-provider'
import { createOrcadCatalogBrowserFactory } from './orcad-catalog-browser-host'
import { resolveOrcadInstallRoot, resolveOrcadPath, resolveUserDataPath } from './orcad-app-paths'
import { describeOrcadBindExposure, OrcadBindAddressError, resolveOrcadBindHost } from './orcad-bind-address'
import { acquireOrcadInstanceLock, OrcadInstanceLockError } from './orcad-instance-lock'
import { startOrcadWithLifecycle } from './orcad-lifecycle'
import { stopOrcadRuntimeWithDurableCatalog } from './orcad-durable-catalog-cleanup'
import * as startup from './orcad-ops'
import { installOrcadControllerDiagnostics } from './orcad-controller-diagnostics'
import {createOrcadAccountSelection} from './orcad-account-selection'

let runOrcadQuitHandlers = (): void => {}

function createNodeAppEnvironment(): AppEnvironment {
  const quitHandlers: (() => void)[] = []
  // The main signal handler awaits runtime and browser teardown before process.exit.
  // Keep will-quit callbacks synchronous, but never let them pre-empt that async barrier.
  runOrcadQuitHandlers = (): void => {
    for (const handler of quitHandlers.splice(0)) {
      try {
        handler()
      } catch (error) {
        console.error('[orcad] shutdown handler failed:', error)
      }
    }
  }
  return {
    getPath: resolveOrcadPath,
    getAppPath: () => resolveOrcadInstallRoot(),
    getVersion: () => process.env.ORCA_VERSION ?? '0.0.0-orcad',
    // Why still true: consumers read this as "production build, not a dev checkout" —
    // it gates HTTPS-only skill downloads, the real CLI command name, and shell-PATH
    // hydration. Answering false to satisfy a path resolver would relax a security
    // posture. Layout questions must ask whether the app root is an asar archive
    // instead (see parcel-watcher-entry-path.ts).
    isPackaged: () => true,
    onWillQuit: (handler) => quitHandlers.push(handler),
    exit: (code = 0) => process.exit(code),
    // Why []: there are no Chromium processes on this host to measure.
    getAppMetrics: () => []
  }
}

/**
 * Why not silently plaintext: `isEncryptionAvailable() === false` already makes every
 * caller fall back to unsealed storage, which is a security posture, not a detail.
 * `describeProtectionGap()` gives the reason a client can surface.
 */
function createNodeSecretStore(): SecretStore {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('orcad_secret_sealing_unavailable')
    },
    decryptString: () => {
      throw new Error('orcad_secret_sealing_unavailable')
    },
    describeProtectionGap: () =>
      'This host has no OS keyring, so credentials are stored unencrypted. Pair from a desktop to manage secrets, or install and unlock a keyring.'
  }
}

export function installOrcadHostAdapters(): void {
  setAppEnvironment(createNodeAppEnvironment())
  setSecretStore(createNodeSecretStore())
}

export type OrcadOptions = {
  port?: number
  json?: boolean
  noPairing?: boolean
  /** Also mint a 'mobile'-scope offer (phone app); the 'runtime' offer (desktop/web) stays. */
  mobilePairing?: boolean
  /** Drop the 'runtime' offer; only valid together with `mobilePairing`. */
  noRuntimePairing?: boolean
  pairingAddress?: string
  /** Literal IP to bind. Defaults to loopback; see orcad-bind-address.ts. */
  bind?: string
}

export type OrcadHandle = {
  readiness: ServeReadiness
  stop(): Promise<void>
}

/**
 * Boot the runtime and serve RPC. Resolves once the transport is listening and the
 * readiness payload has been published, mirroring the desktop `--serve` contract byte
 * for byte so the same harnesses can drive either host.
 */
export async function startOrcad(options: OrcadOptions = {}): Promise<OrcadHandle> {
  const startupConfig = startup.readOrcadStartupConfig()
  installOrcadHostAdapters()
  const userDataPath = resolveUserDataPath()
  // Why before anything else touches the root: the profile index, the store and the daemon
  // runtime dir all live under it, and two orcads sharing them corrupt state silently. This
  // is also the last point at which refusing costs nothing.
  const instanceLock = acquireOrcadInstanceLock(userDataPath)
  const browserProvider = await resolveOrcadBrowserProvider({ userDataPath })
  return startOrcadWithLifecycle(
    (registerCleanup) => startOrcadRuntime(options, registerCleanup, startupConfig, browserProvider),
    async () => {
      try {
        await browserProvider?.stop()
      } finally {
        setRuntimeBrowserCommandsFactory(null)
        runOrcadQuitHandlers()
        instanceLock.release()
      }
    }
  )
}

async function startOrcadRuntime(
  options: OrcadOptions,
  registerCleanup: (cleanup: () => Promise<void>) => void,
  startupConfig: startup.OrcadStartupConfig,
  browserProvider: OrcadBrowserProvider | null
): Promise<Pick<OrcadHandle, 'readiness'>> {
  const { OrcaRuntimeService } = await import('../runtime/orca-runtime')
  const { OrcaRuntimeRpcServer } = await import('../runtime/runtime-rpc')
  const { registerHeadlessPtyRuntime, getLocalPtyProvider, getSshPtyProvider } = await import('../ipc/pty')
  const { getAppEnvironment } = await import('../../shared/app-environment')
  const { resolveAdvertisedPairingEndpoint } = await import('../runtime/pairing-endpoint')
  const { ServeReadinessPublisher } = await import('../server/serve-readiness')
  const { Store } = await import('../persistence/loading-store/store')
  const { ensureActiveOrcaProfile, initOrcaProfilePaths } = await import('../orca-profiles/profile-index-store')
  const { initSshHostKeyStoreFile } = await import('../ssh/ssh-host-key-store')
  const { startOrcadDaemon, stopOrcadDaemon } = await import('./orcad-daemon-supervision')
  const { daemonOwnsFreshPersistentPtys } = await import('../daemon/daemon-init')
  const { collectOrcadHealth } = await import('./orcad-health')
  // Why importable here: the singleton's module tree never reaches Electron, and orcad supplies
  // its persistence and endpoint paths explicitly below.
  const { agentHookServer } = await import('../agent-hooks/server')
  const { isAgentStatusHooksEnabled } = await import('../agent-hooks/managed-agent-hook-controls')
  const { installHookStatusSessionTabsRepublish } =
    await import('../agent-hooks/hook-status-session-tabs-republish')
  const { AgentStatusObservedPaneIdentities, AgentStatusObservedPaneIdentityCapture } =
    await import('../runtime/agent-status-observed-pane-identity')

  const { maybeStartAgentControlAdapter, stopAgentControlAdapter } =
    await import('../runtime/agent-control-adapter')

  let rpc: InstanceType<typeof OrcaRuntimeRpcServer> | null = null
  let durableCatalog: startup.OrcadDurableCatalog | null = null, removeControllerDiagnostics = (): void => {}
  let uninstallHookStatusRepublish = (): void => {}
  let uninstallObservedStatusIdentity = (): void => {}
  registerCleanup(() => { removeControllerDiagnostics(); return stopOrcadRuntimeWithDurableCatalog({
    stopRpc: () => rpc?.stop(), stopAgentControlAdapter, stopDaemon: stopOrcadDaemon,
    uninstallObservedStatusIdentity: () => uninstallObservedStatusIdentity(),
    uninstallHookStatusRepublish: () => uninstallHookStatusRepublish(),
    stopAgentHookServer: () => agentHookServer.stop(), stopDurableCatalog: () => durableCatalog?.stop()
  }) })
  // The real Store must exist before startup can schedule a cold callback.
  // No default settings or consumed-owner retry stands in for this ordering.
  const runtimeUserDataPath = getAppEnvironment().getPath('userData')
  initOrcaProfilePaths()
  const profile = ensureActiveOrcaProfile(runtimeUserDataPath), store = new Store({ dataFile: profile.dataFile, storageAuthority: 'runtime' })
  const provider = (await import('./orcad-managed-provider-settings.ts')).createOrcadManagedProviderSettings(store, runtimeUserDataPath)
  const durableServices = await startup.prepareOrcadStartup(startupConfig, catalog => { durableCatalog = catalog; removeControllerDiagnostics = installOrcadControllerDiagnostics(catalog) }, provider.readSettings, provider.readCredential)
  setRuntimeBrowserCommandsFactory(
    createOrcadCatalogBrowserFactory(browserProvider, durableServices.durableCatalogRead), {
      headless: browserProvider !== null, screencast: browserProvider?.kind === 'chromium',
      ...(browserProvider ? { isAvailable: () => browserProvider.isAvailable() } : {})
    }
  )
  const { DesktopPushService } = await import('../runtime/push/desktop-push-service')
  const { resolvePushGatewayOrigin } = await import('../runtime/push/push-gateway-origin')

  const observedPaneIdentities = new AgentStatusObservedPaneIdentities()
  const observedStatusCapture = new AgentStatusObservedPaneIdentityCapture(observedPaneIdentities)
  // Why: every SSH connect consults this sidecar. Left unbound it reports nothing trusted,
  // which is safe but silently discards accept records on every launch.
  initSshHostKeyStoreFile(profile.dataFile)

  uninstallObservedStatusIdentity = agentHookServer.subscribeEnrichedStatus((enriched) =>
    observedStatusCapture.observe(enriched)
  )
  if (isAgentStatusHooksEnabled(store.getSettings())) {
    await agentHookServer.start({ env: 'production', userDataPath: runtimeUserDataPath })
  }

  // Why before the runtime and the PTY handlers: `setLocalPtyProvider` installs the daemon
  // adapter as THE local provider, and the registry's contract is that it lands before
  // registerPtyHandlers so the IPC layer routes through the daemon from the first call.
  await startOrcadDaemon()

  const runtime = new OrcaRuntimeService(store, undefined, {
    // Why lazy: a daemon swap replaces the provider after construction, so an eager
    // reference would freeze the pre-daemon one.
    getLocalProvider: () => getLocalPtyProvider(),
    // Why: destructive worktree removal refuses to run without a provider to stop
    // processes through — correctly, since it cannot otherwise verify the tree is idle.
    getSshProvider: (connectionId) => getSshPtyProvider(connectionId),
    // Why the daemon predicate and not a constant: orcad now spawns the terminal daemon, so
    // its PTYs DO survive an orcad restart — but only while a daemon that owns fresh
    // sessions is installed. A failed or degraded launch has to answer false, and this reads
    // that live rather than snapshotting it at construction.
    canRecoverPersistentLocalPtys: () => daemonOwnsFreshPersistentPtys(),
    // Why 'blocked': `'openable'` means a desktop window can be opened here, which is
    // what powers serve→desktop promotion. A Node host can never do that, and the
    // constructor's default would advertise it.
    getDesktopWindowStatus: () => 'blocked',
    // Why here too and not only on the desktop: main's OSC parse is the only producer for a
    // PTY agent on this host, and the store is the only place `worktree.ps` and the mobile
    // projection read from — unwired, orcad lists no PTY agents at all.
    onTerminalAgentStatus: (event) => agentHookServer.ingestTerminalStatus(event),
    // Why here too and not only on the desktop: orcad serves `worktree.ps` and `agentSession.*`,
    // so without these a headless host publishes its structured chats nowhere and lists no agents.
    getAgentStatusSnapshot: () =>
      agentHookServer.getStatusSnapshot().filter((entry) => entry.providerSessionOnly !== true),
    getAgentProviderSessionSnapshot: () => agentHookServer.getStatusSnapshot(),
    getAgentProviderSessionRowsForPane: (paneKey) =>
      agentHookServer.getStatusSnapshotForPane(paneKey),
    // Why captured rather than resolved at read: the fleet snapshot remints cached rows on every
    // read, so a row observed under one process otherwise acquires whatever process owns the pane now.
    readObservedAgentStatusPaneIdentity: (paneKey) => observedPaneIdentities.read(paneKey),
    structuredAgentStatusSink: {
      publish: (summary) => agentHookServer.ingestStructuredStatus(summary),
      forget: (sessionId) => agentHookServer.dropStructuredStatus(sessionId)
    },
    reconcileAgentStatusForEndedProcess: (paneKeys) =>
      agentHookServer.reconcileEndedProcessForPaneKeys(paneKeys),
    buildAgentHookPtyEnv: () =>
      isAgentStatusHooksEnabled(store.getSettings()) ? agentHookServer.buildPtyEnv() : {}
  })

  runtime.setAccountSelectionServices(createOrcadAccountSelection(store,runtimeUserDataPath))

  // Why here too and not only on the desktop: nothing else republishes `session.tabs` when a
  // pane's status row changes, and orcad's whole job is serving paired clients.
  uninstallHookStatusRepublish = installHookStatusSessionTabsRepublish(
    agentHookServer,
    () => runtime
  )

  // Why the headless entry point rather than registerPtyHandlers directly: this is the
  // same call `--serve` makes, and it threads the store through. Without the store the
  // handlers install fine and every terminal.create then fails at persistence time.
  //
  // Codex-home and Claude-auth preparation are left unset: both are desktop account
  // flows. A launch that needs one fails with its own message rather than silently
  // spawning an unauthenticated agent.
  await registerHeadlessPtyRuntime(runtime, undefined, () => store.getSettings(), undefined, store)

  // Why: same post-registration reconciliation `--serve` performs. Skipping it leaves
  // restored orchestration rows claiming an authority this host never took over.
  // Why before the RPC server binds: a client host attaching first would find no pages to recover.
  runtime.rehydrateClientHostedBrowserPages()

  await runtime.refreshRestoredOrchestrationAuthority()
  await runtime.reconcileLegacyWorkerTerminals()

  // Recovery binds terminal and dispatch identities; only now can startup observations be fenced.
  observedStatusCapture.attach(runtime)

  const bindHost = resolveOrcadBindHost(options.bind)
  rpc = new OrcaRuntimeRpcServer({
    runtime,
    ...durableServices,
    userDataPath: runtimeUserDataPath,
    enableWebSocket: true,
    // Why pinned and not `exposeNetworkByDefault`: an unattended host's exposure must be
    // exactly what the operator asked for, on every launch. The default path widens itself
    // once a device has connected, so a loopback deployment would silently go wide one
    // restart after its first client paired.
    pinnedBindHost: bindHost,
    ...(options.port !== undefined ? { wsPort: options.port, preferPinnedWsPort: true } : {})
  })
  await rpc.start()
  // Why: opt-in (ORCA_AGENT_ADAPTER_LISTEN) control-plane seam, the same call the Electron serve
  // launch makes; a no-op when unset. After rpc.start so a bind failure never leaves it listening.
  maybeStartAgentControlAdapter(runtime)
  const pushService = DesktopPushService.create({
    runtime,
    runtimeRpc: rpc,
    gatewayUrl: resolvePushGatewayOrigin(process.env, getAppEnvironment().isPackaged())
  })
  pushService?.start()
  getAppEnvironment().onWillQuit(() => pushService?.stop())
  console.error(`[orcad] ${describeOrcadBindExposure(bindHost)}`)

  const boundEndpoint = rpc.getWebSocketEndpoint()
  const advertised = boundEndpoint
    ? resolveAdvertisedPairingEndpoint(boundEndpoint, options.pairingAddress)
    : null
  // Why one offer per client kind instead of one switchable offer: the phone (scope 'mobile',
  // held to the mobile RPC allowlist) and the desktop/web client (scope 'runtime') connect to the
  // same host at once, and each is authenticated per connection by its own credential.
  const pairingScopes = resolveOrcadPairingScopes(options)
  const offers = mintOrcadPairingOffers(rpc, pairingScopes, options.pairingAddress)
  const [primaryOffer, ...otherOffers] = offers
  const pairing: ServePairingReadiness = primaryOffer ?? {
    available: false,
    reason: 'disabled_by_operator',
    guidance: 'Restart without --no-pairing to create a client pairing offer.'
  }

  const readiness: ServeReadiness = {
    runtimeId: runtime.getRuntimeId(),
    boundEndpoint,
    advertisedEndpoint: advertised?.ok ? advertised.endpoint : null,
    // Why 'settled': the WSL CLI reconciliation barrier is a desktop-launch concern.
    // orcad never runs it, so there is no pending repair a client could race.
    managedWslCliReconciliation: 'settled',
    pairing,
    ...(otherOffers.length > 0 ? { additionalPairings: otherOffers } : {}),
    // Why in the readiness payload: this is the one message a supervisor and a deploy
    // transaction both read, and a green orcad with a dead daemon is exactly the
    // looks-healthy-but-useless state they must not activate.
    health: await collectOrcadHealth(getAppEnvironment().getVersion())
  }

  await new ServeReadinessPublisher().publish(readiness, {
    mode: options.json ? 'json' : 'human'
  })

  return { readiness }
}

export function parseArgs(argv: string[]): OrcadOptions {
  const options: OrcadOptions = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--port') {
      const raw = argv[i + 1]
      const port = Number(raw)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`--port expects an integer 0-65535, got ${raw ?? "''"}`)
      }
      options.port = port
      i += 1
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--no-pairing') {
      options.noPairing = true
    } else if (arg === '--mobile-pairing') {
      options.mobilePairing = true
    } else if (arg === '--no-runtime-pairing') {
      options.noRuntimePairing = true
    } else if (arg === '--bind') {
      const value = argv[i + 1]
      if (value === undefined) {
        throw new Error('--bind expects a value')
      }
      options.bind = value
      i += 1
    } else if (arg === '--pairing-address') {
      const value = argv[i + 1]
      if (!value) {
        throw new Error('--pairing-address expects a value')
      }
      options.pairingAddress = value
      i += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  // Why here: a contradictory pairing request must fail before the daemon, store and listener exist.
  resolveOrcadPairingScopes(options)
  return options
}

/**
 * Exit codes a supervisor can act on. Closed set — see docs/reference/orcad-operations.md.
 *
 * `ORCAD_EXIT_CONFIGURATION` is the load-bearing one: a data root owned by someone else, or
 * held by another orcad, is not fixed by restarting. Restarting on it is the crash-loop the
 * supervision contract has to prevent, so systemd's `RestartPreventExitStatus` needs a code
 * that means "do not retry" and nothing else does.
 */
export const ORCAD_EXIT_OK = 0
export const ORCAD_EXIT_FAILED = 1
export const ORCAD_EXIT_CONFIGURATION = 78

/** Bounded so a wedged transport cannot hold a supervisor's stop past its own deadline. */
export const ORCAD_SHUTDOWN_DEADLINE_MS = 15_000

export function resolveOrcadExitCode(error: unknown): number {
  return error instanceof OrcadInstanceLockError || error instanceof OrcadBindAddressError ||
    error instanceof startup.OrcadDurableCatalogConfigurationError
    ? ORCAD_EXIT_CONFIGURATION
    : ORCAD_EXIT_FAILED
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const handle = await startOrcad(parseArgs(argv))
  let stopping = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) {
      // Why escalate rather than ignore: a supervisor's second signal means the first
      // deadline elapsed. Continuing to wait silently is what makes a stop hang until
      // SIGKILL, which is the one teardown that skips the daemon handoff entirely.
      console.error(`orcad: second ${signal} during shutdown — exiting immediately`)
      process.exit(ORCAD_EXIT_FAILED)
    }
    stopping = true
    // Why a self-imposed deadline as well: the supervisor's SIGKILL leaves no exit code and
    // no log line. Exiting ourselves keeps the failure attributable.
    const deadline = setTimeout(() => {
      console.error(
        `orcad: shutdown after ${signal} exceeded ${ORCAD_SHUTDOWN_DEADLINE_MS}ms — exiting`
      )
      process.exit(ORCAD_EXIT_FAILED)
    }, ORCAD_SHUTDOWN_DEADLINE_MS)
    deadline.unref()
    handle
      .stop()
      .then(() => process.exit(ORCAD_EXIT_OK))
      // Why not rethrow: we are already tearing down on a signal, and an exit code is
      // the only thing a supervisor can act on.
      .catch((error) => {
        console.error(`orcad: shutdown after ${signal} failed:`, error)
        process.exit(ORCAD_EXIT_FAILED)
      })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}
