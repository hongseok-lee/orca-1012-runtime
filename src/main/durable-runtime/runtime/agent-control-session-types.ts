import type {ManagedCodexAccessReader} from './agent-external-auth.ts'
import type {ManagedCodexCredential} from '../providers/codex/managed-credential-owner.ts'
import type { ManagedCodexAuthControl } from './managed-codex-auth-refresh.ts'
import type { CodexProtocolDependencies } from '../providers/codex/protocol.ts'
import type { CodexAppServerConnection } from '../../codex/codex-app-server-connection-types.ts'
import type { NativeSessionCheckpoint } from './native-session-checkpoint.ts'
import type { KubernetesPodAuthExpected, AuthenticatedPodObservation } from './kubernetes-pod-auth-types.ts'
import type { AgentCodexControlPolicy } from './agent-codex-control.ts'
import type { ControlJournal } from './agent-control-journal.ts'
import type { AgentTerminalSupply } from './agent-control-native-supply.ts'
import type { AgentTerminalControl, AgentTerminalFrame } from './agent-terminal-protocol.ts'
export type AgentControlIdentity = Readonly<{ controlId: string; pid: number; startTicks: string; device: string; inode: string }>
export type AgentControlSessionEnvironment = Readonly<{
  readManagedCredential?():ManagedCodexCredential
  readManagedAccess?:ManagedCodexAccessReader
  config: Readonly<{ timeoutMs: number; namespace: string; container: string; bootstrapSha256: string
    nativeArtifactFile: string; nativeCompanionFile?:string; nativeBwrapFile?:string; terminalSupply?: AgentTerminalSupply; expected: KubernetesPodAuthExpected; policy: AgentCodexControlPolicy }>
  origin: URL; ca: Buffer; reconnectBudgetMs: number; termOnInitialize: boolean
  reviewer(signal: AbortSignal): string | Promise<string>
  authenticate(input: Readonly<{ podBearer: string; expected: KubernetesPodAuthExpected }>, signal: AbortSignal): Promise<AuthenticatedPodObservation>
  onProviderChildExit?(exit:Readonly<{controlId:string;hostSeq:number}>):Promise<void>
  onTerminalFrame?(frame: AgentTerminalFrame): void | Promise<void>
  journal?: ControlJournal
  controllerTerm(): number
}>
export type AuthenticatedAgentControl = Readonly<{
  controlId: string; controlPid: number; startTicks: string
  bindChallenge: string
  root: Readonly<{ path: string; device: string; inode: string }>
  pod: AuthenticatedPodObservation
  valid(): boolean
  transport: Pick<CodexProtocolDependencies, 'open'>
  /** hostSeq of the control frame being delivered; stable across re-attach and backend processes. */
  frameSequence(): number
  readNativeSession(): Promise<NativeSessionCheckpoint>
  readNativeHistory(): Promise<NativeSessionCheckpoint>
  readMountProbe(): Promise<string>
  close(): Promise<boolean>
  /** Fixed diagnostic code of why the control stopped being valid, if it did. */
  lossReason(): string | null
  physicalPinIssued: false
  turnProcesses?: Pick<CodexProtocolDependencies, 'capture' | 'terminate'>
}> & ManagedCodexAuthControl & AgentTerminalControl
/** A control handed over by an earlier owner and re-attached by this one. It
 * never initializes, transfers native code or sends COLD. */
export type AdoptedAgentControl = Readonly<{
  identity: AgentControlIdentity; pod: AuthenticatedPodObservation; connection: CodexAppServerConnection
  valid(): boolean; frameSequence(): number; close(): Promise<boolean>
  readNativeHistory(): Promise<NativeSessionCheckpoint>
  turnProcesses?: Pick<CodexProtocolDependencies, 'capture' | 'terminate'>
}> & ManagedCodexAuthControl & AgentTerminalControl
