import { dirname, join } from 'node:path'
import type { SshTarget } from '../../shared/ssh-types'
import { getControlSocketPath, type SystemSshResolvedConfig } from './ssh-control-socket'
import { boundSshHostKeyStoreFile } from './ssh-host-key-store'

/** Beside `ssh-host-keys.json`, so on-demand trust lives with the rest of Orca's host-key state. */
const ON_DEMAND_KNOWN_HOSTS_FILE_NAME = 'ssh-known-hosts-on-demand'

export type SystemSshBuildArgsOptions = {
  configFile?: string
  resolvedConfig?: SystemSshResolvedConfig | null
  disableControlMaster?: boolean
  suppressOrcaControlMaster?: boolean
  gssapiOnly?: boolean
  nonInteractive?: boolean
  /**
   * `false` only when the parsed ssh_config proves no `Host`/`Match` block claims `configHost`.
   *
   * Absent or `true` keeps the config alias fully authoritative, which is right whenever a block
   * really does name it — and is the only safe default, since a caller that cannot answer must not
   * be read as having answered "nothing claims it". See `sshConfigMayClaimAlias`.
   */
  aliasClaimedByConfig?: boolean
}

export function buildSshArgs(target: SshTarget, options?: SystemSshBuildArgsOptions): string[] {
  const args: string[] = []

  if (options?.configFile) {
    args.push('-F', options.configFile)
  }
  args.push('-o', options?.gssapiOnly || options?.nonInteractive ? 'BatchMode=yes' : 'BatchMode=no')
  if (options?.gssapiOnly) {
    // Why: the probe must neither authenticate with a key nor open an OpenSSH
    // credential prompt; failure belongs to Orca's existing ssh2 prompt path.
    args.push('-o', 'GSSAPIAuthentication=yes')
    args.push('-o', 'PreferredAuthentications=gssapi-with-mic')
  }
  // Forward stdin/stdout for relay communication
  args.push('-T')

  appendOnDemandRuntimeHostKeyPolicy(args, target)

  // Why: ControlMaster multiplexes all SSH exec commands over a single connection,
  // eliminating the ~9s handshake overhead per command. Without this, each
  // spawnSystemSshCommand call opens a new TCP connection.
  const controlPath = getOrcaControlSocketPath(target, options)
  const forceDisableControlMaster =
    options?.disableControlMaster === true ||
    target.systemSshConnectionReuse === false ||
    (options?.gssapiOnly === true && controlPath === null)
  if (forceDisableControlMaster) {
    // Why: muxed OpenSSH forwards remain registered on the master after the
    // client exits. Also honors the per-target compatibility opt-out even if
    // a broad Host * ssh_config block enables multiplexing.
    args.push('-S', 'none')
  } else if (controlPath) {
    args.push('-o', 'ControlMaster=auto')
    args.push('-o', `ControlPath=${controlPath}`)
    // Why: keep master alive 300s after last command so rapid reconnects
    // (e.g. on tab focus) skip re-handshake without holding a process open.
    args.push('-o', 'ControlPersist=300')
    args.push('-o', 'ServerAliveInterval=15')
    args.push('-o', 'ServerAliveCountMax=3')
  }

  const useConfigHost = shouldUseOpenSshConfigHost(target)

  // Why: a wildcard `Host *` block supplies ProxyCommand/ProxyJump for every alias, so an alias
  // whose own Host block was renamed or deleted still looks config-backed and gets dialled bare —
  // as the wildcard's user, at the wildcard's host, discarding the endpoint Orca stored. Keep the
  // system transport (OpenSSH must still apply that proxy) but state the stored endpoint, and only
  // where the config proves no block claims the alias.
  if (useConfigHost && options?.aliasClaimedByConfig === false) {
    appendUnclaimedAliasEndpoint(args, target)
  }

  if (!useConfigHost && target.port !== 22) {
    args.push('-p', String(target.port))
  }

  if (!useConfigHost && target.identityFile) {
    args.push('-i', target.identityFile)
  }

  if (!useConfigHost && target.identityAgent) {
    args.push('-o', `IdentityAgent=${target.identityAgent}`)
  }

  if (!useConfigHost && target.identitiesOnly) {
    args.push('-o', 'IdentitiesOnly=yes')
  }

  if (!useConfigHost && target.gssapiAuthentication && !options?.gssapiOnly) {
    // Why: manual targets bypass ssh_config, so Kerberos auth must be
    // requested explicitly; config-backed hosts inherit it from their entry.
    args.push('-o', 'GSSAPIAuthentication=yes')
  }

  if (!useConfigHost && target.jumpHost) {
    args.push('-J', target.jumpHost)
  }

  if (!useConfigHost && target.proxyCommand) {
    args.push('-o', `ProxyCommand=${target.proxyCommand}`)
  }

  const host = target.configHost || target.host
  // Why: OpenSSH owns User for config-backed aliases; imported fallback values
  // must not override a fresh wildcard, Include, or Match result.
  const userHost = useConfigHost ? host : target.username ? `${target.username}@${host}` : host
  args.push('--', userHost)

  return args
}

/**
 * Give the system transport the host-key policy the ssh2 path already applies to these targets.
 *
 * An on-demand runtime target carries a recipe-supplied ProxyCommand, and `shouldUseSystemSshTransport`
 * routes every such target here — so it never reaches `ssh-host-key-decision`, where an unknown key on
 * an `on-demand-runtime` owner is accepted. Left to OpenSSH's default, the first connection to a freshly
 * provisioned host meets an unknown key under `BatchMode=yes`, cannot ask, and dies with "Host key
 * verification failed" before authentication.
 *
 * `accept-new` is that same policy, not a weaker one: a first, unknown key is accepted, a *changed* key
 * is still refused — matching the mismatch checks that run ahead of the ephemeral bypass. The record
 * goes beside Orca's own store rather than the user's `known_hosts`, which we read but never write (D1).
 *
 * With no bound store there is nowhere to write that is ours, so the policy is left alone and the
 * connection fails the same way it does today; silently falling back to `~/.ssh/known_hosts` would
 * break D1 to hide the problem.
 */
function appendOnDemandRuntimeHostKeyPolicy(args: string[], target: SshTarget): void {
  if (target.owner?.type !== 'on-demand-runtime') {
    return
  }
  const storeFile = boundSshHostKeyStoreFile()
  if (!storeFile) {
    return
  }
  args.push('-o', 'StrictHostKeyChecking=accept-new')
  args.push('-o', `UserKnownHostsFile=${join(dirname(storeFile), ON_DEMAND_KNOWN_HOSTS_FILE_NAME)}`)
}

export function getOrcaControlSocketPath(
  target: SshTarget,
  options?: SystemSshBuildArgsOptions
): string | null {
  if (shouldDisableOrcaControlMaster(target, options)) {
    return null
  }
  return getControlSocketPath(target, options?.resolvedConfig, options?.gssapiOnly === true)
}

export function getSystemSshBuildArgsFromOperationOptions(
  options: SystemSshBuildArgsOptions | undefined
): SystemSshBuildArgsOptions | undefined {
  const buildArgsOptions: SystemSshBuildArgsOptions = {}
  if (options?.configFile !== undefined) {
    buildArgsOptions.configFile = options.configFile
  }
  if (options?.resolvedConfig !== undefined) {
    buildArgsOptions.resolvedConfig = options.resolvedConfig
  }
  if (options?.disableControlMaster === true) {
    buildArgsOptions.disableControlMaster = true
  }
  if (options?.suppressOrcaControlMaster === true) {
    buildArgsOptions.suppressOrcaControlMaster = true
  }
  if (options?.gssapiOnly === true) {
    buildArgsOptions.gssapiOnly = true
  }
  if (options?.nonInteractive === true) {
    buildArgsOptions.nonInteractive = true
  }
  if (options?.aliasClaimedByConfig === false) {
    buildArgsOptions.aliasClaimedByConfig = false
  }
  return Object.keys(buildArgsOptions).length === 0 ? undefined : buildArgsOptions
}

function shouldDisableOrcaControlMaster(
  target: SshTarget,
  options?: SystemSshBuildArgsOptions
): boolean {
  // Why: unresolved ssh_config aliases could otherwise share one Orca socket
  // while OpenSSH routes them through mutable HostName/ProxyJump settings.
  const unresolvedConfigBackedTarget =
    isOpenSshConfigBackedTarget(target) && options?.resolvedConfig == null
  return (
    options?.disableControlMaster === true ||
    options?.suppressOrcaControlMaster === true ||
    target.systemSshConnectionReuse === false ||
    unresolvedConfigBackedTarget ||
    (hasUserConfiguredControlMaster(options?.resolvedConfig) && options?.gssapiOnly !== true)
  )
}

function hasUserConfiguredControlMaster(
  resolvedConfig: SystemSshResolvedConfig | null | undefined
): boolean {
  if (!resolvedConfig) {
    return false
  }
  // Why: ControlPersist/ControlPath alone can reuse a master someone else
  // created, but they do not create the setup-burst master Orca needs.
  return (
    hasEnabledControlMaster(resolvedConfig.controlMaster) &&
    hasEnabledControlPath(resolvedConfig.controlPath)
  )
}

function hasEnabledControlMaster(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return (
    normalized != null &&
    normalized !== '' &&
    normalized !== '0' &&
    normalized !== 'no' &&
    normalized !== 'false'
  )
}

function hasEnabledControlPath(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized != null && normalized !== '' && normalized !== 'none'
}

/**
 * Restore only Hostname/Port/User, and only where they diverge from the alias.
 *
 * Not `-i`/`-J`/ProxyCommand: the wildcard block is still the route to this network, and `-o
 * Hostname=` does not change which blocks OpenSSH selects (matching uses the original destination),
 * so the proxy keeps applying and `%h` now expands to the host we actually mean.
 */
function appendUnclaimedAliasEndpoint(args: string[], target: SshTarget): void {
  const alias = target.configHost
  const storedHost = target.host.trim()
  if (storedHost && alias && storedHost !== alias) {
    args.push('-o', `Hostname=${storedHost}`)
  }
  if (target.port && target.port !== 22) {
    args.push('-p', String(target.port))
  }
  if (target.username) {
    args.push('-l', target.username)
  }
}

function shouldUseOpenSshConfigHost(target: SshTarget): boolean {
  if (!target.configHost) {
    return false
  }
  return isOpenSshConfigBackedTarget(target)
}

export function isOpenSshConfigBackedTarget(
  target: Pick<SshTarget, 'source' | 'configHost' | 'host'>
): boolean {
  if (target.source === 'ssh-config') {
    return true
  }
  if (target.source === 'manual') {
    return false
  }
  // Why: legacy imported aliases have a distinct configHost; manual targets
  // historically stored configHost=host and still need explicit -p/-i args.
  return Boolean(target.configHost && target.configHost !== target.host)
}
