import type { AgentTerminalSupply } from './agent-control-native-supply.ts'
import type { AgentTerminalFrame } from './agent-terminal-protocol.ts'
import type {ManagedCodexCredential} from '../providers/codex/managed-credential-owner.ts'
import type { ControlJournal } from './agent-control-journal.ts'
import { createHash } from 'node:crypto'
import type { CodexAppServerConnectionHandlers } from '../../codex/codex-app-server-connection-types.ts'
import { immutableSnapshot } from '../providers/shared/recovery-renderer.ts'
import { awaitPodAuthValue } from './kubernetes-pod-auth-transport.ts'
import { bearerValid } from './kubernetes-pod-auth-projection.ts'
import type { createKubernetesPodAuthenticator } from './kubernetes-pod-auth.ts'
import type { KubernetesPodAuthExpected } from './kubernetes-pod-auth-types.ts'
import type { AgentCodexControlPolicy } from './agent-codex-control.ts'
import { transferAgentControlBundle } from './agent-control-artifact-transfer.ts'
import { awaitAgentControlPodRunning } from './agent-control-pod-running.ts'
import { createAgentControlSession } from './agent-control-session.ts'
import type { AdoptedAgentControl, AgentControlIdentity, AgentControlSessionEnvironment, AuthenticatedAgentControl } from './agent-control-session.ts'
export { agentCodexBootstrap, agentControlTransfer } from './agent-control-bootstrap.ts'
export type { AdoptedAgentControl, AgentControlIdentity, AuthenticatedAgentControl } from './agent-control-session.ts'

export type AgentCodexTransportConfiguration = Readonly<{
  readManagedCredential?():ManagedCodexCredential
  journal?: ControlJournal
  apiOrigin: string; ca: Uint8Array; namespace: string; container: string; timeoutMs: number
  bootstrapSha256: string
  bootstrapBytes: Uint8Array
  nativeBwrapFile?: string
  terminalSupply?: AgentTerminalSupply
  nativeCompanionFile?: string
  nativeArtifactFile: string
  expected: KubernetesPodAuthExpected
  policy: AgentCodexControlPolicy
  podAuthenticator: ReturnType<typeof createKubernetesPodAuthenticator>
  readReviewerBearer(signal: AbortSignal): string | Promise<string>
  /** Controller term sent on INITIALIZE/ATTACH. The Pod-local host refuses an
   * older term and evicts the attachment of an older one. Defaults to 0. */
  controllerTerm?(): number
  /** How long a handed-over control may stay detached while this process
   * re-attaches before it is reported lost. Defaults to timeoutMs. */
  onProviderChildExit?(exit:Readonly<{controlId:string;hostSeq:number}>):Promise<void>
  onTerminalFrame?(frame: AgentTerminalFrame): void | Promise<void>
  reconnectBudgetMs?: number
}>
const issued = new WeakSet<AuthenticatedAgentControl>()
export function authenticatedAgentControlValid(value: AuthenticatedAgentControl): boolean {
  return issued.has(value) && value.valid()
}
const fail = (): Error => new Error('AGENT_CODEX_CONTROL_UNCONFIRMED')

/** Trusted backend composition. Opens only a CLOSED control process in the
 * Agent, authenticates its real Pod-bound token with the existing verifier,
 * then hands its lifetime to one owner. It does not activate grants or issue a
 * physical pin. The native opener is private to the actual-COMMIT executor. */
export function createAgentCodexTransport(original: AgentCodexTransportConfiguration) {
  if (!(original.ca instanceof Uint8Array) || !original.ca.byteLength) { throw fail() }
  const ca = Buffer.from(original.ca)
  if (!(original.bootstrapBytes instanceof Uint8Array) || !original.bootstrapBytes.byteLength || original.bootstrapBytes.byteLength > 4 * 1024 * 1024) { throw fail() }
  const artifact = Buffer.from(original.bootstrapBytes)
  const config = immutableSnapshot({ apiOrigin: original.apiOrigin,
    namespace: original.namespace, container: original.container, timeoutMs: original.timeoutMs,
    bootstrapSha256: original.bootstrapSha256, nativeArtifactFile: original.nativeArtifactFile, nativeCompanionFile:original.nativeCompanionFile, nativeBwrapFile:original.nativeBwrapFile, terminalSupply: original.terminalSupply,
    expected: original.expected, policy: original.policy })
  const reviewer = original.readReviewerBearer.bind(original)
  const terminal = config.policy.nativeArtifact.terminal
  if (!!terminal !== !!config.terminalSupply || terminal && config.terminalSupply &&
      (terminal.runtime.byteLength !== config.terminalSupply.runtime.byteLength ||
       terminal.addon.byteLength !== config.terminalSupply.addon.byteLength)) { throw fail() }
  const reconnectBudgetMs = original.reconnectBudgetMs ?? original.timeoutMs
  if (!Number.isSafeInteger(reconnectBudgetMs) || reconnectBudgetMs < 0 || reconnectBudgetMs > 2_147_483_647) { throw fail() }
  let origin: URL
  try { origin = new URL(config.apiOrigin) } catch { throw fail() }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      !/^[0-9a-f]{64}$/.test(config.bootstrapSha256) || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 ||
      config.timeoutMs > 2_147_483_647 || !/^[a-z0-9-]+$/.test(config.namespace) || !/^[a-z0-9-]+$/.test(config.container)) { throw fail() }
  if (createHash('sha256').update(artifact).digest('hex') !== config.bootstrapSha256) { throw fail() }
  const environment: AgentControlSessionEnvironment = Object.freeze({readManagedCredential:original.readManagedCredential, config, origin, ca, reconnectBudgetMs, reviewer,
    journal: original.journal,
    termOnInitialize: !!original.controllerTerm,
    onProviderChildExit:original.onProviderChildExit?.bind(original),
    onTerminalFrame:original.onTerminalFrame?.bind(original),
    controllerTerm: original.controllerTerm ? original.controllerTerm.bind(original) : () => 0,
    authenticate: original.podAuthenticator.authenticatePod.bind(original.podAuthenticator) })
  let preparedOnce = false, adoptedOnce = false
  return Object.freeze({
    /** Waits for the exact Pod to run without creating anything, so a caller
     * can take long-held resources (the protected leaf pin) only afterwards. */
    async awaitPodRunning(signal: AbortSignal): Promise<void> {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)])
      const bearer = await awaitPodAuthValue(Promise.resolve(reviewer(bounded)), bounded)
      if (!bearerValid(bearer) || bounded.aborted) { throw fail() }
      await awaitAgentControlPodRunning(config, ca, bearer, bounded)
    },
    async prepare(signal: AbortSignal): Promise<AuthenticatedAgentControl> {
      // A failed/unknown original control is reconciled through its own handle;
      // this factory cannot open a second control process for the same attempt.
      if (preparedOnce || adoptedOnce) { throw fail() }
      preparedOnce = true
      const acquisition = new AbortController(), abortAcquisition = () => acquisition.abort()
      const budget = setTimeout(abortAcquisition, config.timeoutMs)
      signal.addEventListener('abort', abortAcquisition, { once: true })
      if (signal.aborted) { acquisition.abort() }
      let bearer = ''
      try {
        bearer = await awaitPodAuthValue(Promise.resolve(reviewer(acquisition.signal)), acquisition.signal)
        if (!bearerValid(bearer) || acquisition.signal.aborted) { throw fail() }
        await awaitAgentControlPodRunning(config, ca, bearer, acquisition.signal)
        await transferAgentControlBundle(config, ca, artifact, bearer, acquisition.signal)
        const control = await createAgentControlSession(environment).initialize(bearer, acquisition.signal)
        issued.add(control)
        return control
      } catch { throw fail() }
      finally { bearer = ''; clearTimeout(budget); signal.removeEventListener('abort', abortAcquisition); acquisition.abort() }
    },
    /** Re-attaches to the control an earlier backend process created for this
     * exact Pod. Never transfers a bundle, initializes, or sends COLD. */
    adopt(recorded: AgentControlIdentity, journaledSeq: number,
      handlers: CodexAppServerConnectionHandlers): Readonly<{ frameSequence(): number; ready: Promise<AdoptedAgentControl> }> {
      if (preparedOnce || adoptedOnce) { return Object.freeze({ frameSequence: () => 0, ready: Promise.reject(fail()) }) }
      adoptedOnce = true
      return createAgentControlSession(environment).adopt(recorded, journaledSeq, handlers)
    },
  })
}
