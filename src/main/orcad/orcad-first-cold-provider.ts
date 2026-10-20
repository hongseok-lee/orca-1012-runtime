import {orcadManagedAccountAccess} from './orcad-managed-account-access.ts'
import type {ManagedCodexCredentialReader} from '../durable-runtime/providers/codex/managed-credential-owner.ts'
import { createAgentControlJournal } from '../durable-runtime/runtime/agent-control-journal.ts'
import { readCodexNativeDistribution } from './orcad-native-distribution.ts'
import { recordProviderChildExit } from '../durable-runtime/runtime/provider-start-observation.ts'
import { fstatSync, createReadStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { OrcadControllerConfig } from './orcad-controller-config.ts'
import { readAgentTerminalDistribution } from './orcad-terminal-distribution.ts'
import { invalidOrcadControllerConfig, parseUniqueOrcadControllerJson, readPrivateOrcadControllerConfigBytes } from './orcad-controller-config.ts'
import { readOrcadControllerCredential } from './orcad-controller-credential.ts'
import { agentPodFields, agentPodInteger, agentPodText } from '../durable-runtime/runtime/agent-pod-policy.ts'
import { createInitialCodexExecutor } from '../durable-runtime/runtime/initial-codex-executor.ts'
import { claudeSessionIdForOrcaSession } from '../claude/claude-structured-launch-resolution.ts'
import { createKubernetesPodAuthenticator } from '../durable-runtime/runtime/kubernetes-pod-auth.ts'
import { createComputeCreationIdentityClient } from '../durable-runtime/runtime/compute-creation-identity.ts'
import { logicalId } from '../../shared/durable-runtime/identity.ts'
import type { FirstManagedBindingOwnerConfig } from '../durable-runtime/storage/first-managed-binding-owner.ts'
import type { InitialEmptyFolderDeclaration } from '../durable-runtime/runtime/initial-provider-paths.ts'
import { captureManagedCodexNativePolicy } from '../durable-runtime/runtime/initial-codex-native-policy.ts'
import type { InitialCodexNativeSettings } from '../durable-runtime/runtime/initial-codex-native-policy.ts'
import type { ControlledCreationWindow } from '../durable-runtime/runtime/controlled-creation-window.ts'
import { createTerminalInputRuntime } from '../durable-runtime/input/runtime-input.ts'
import { readPendingTerminalInputs } from '../durable-runtime/input/pending-terminal-input.ts'
import { createTerminalCodexOutput } from '../durable-runtime/output/terminal-codex-output.ts'
import { createAdoptedCodexExecutor } from '../durable-runtime/runtime/adopted-codex-executor.ts'
import { createAgentCodexTransport } from '../durable-runtime/runtime/agent-codex-transport.ts'
import type { ControllerPassRequest } from '../durable-runtime/ha/pass.ts'
import type { InitialProviderPaths } from '../durable-runtime/runtime/initial-provider-paths.ts'
import type { ExecutorId } from '../durable-runtime/runtime/gateway/types.ts'

const deny = (): never => invalidOrcadControllerConfig('CONTROLLER_FIRST_COLD_CONFIG')
/** Private anonymous pipe only. A regular file/argv/env token cannot enter
 * this one-shot development Audit supplier. No token hash or error body. */
export async function readFirstColdAuditPipe(timeoutMs: number): Promise<string> {
  if (process.env.ORCA_DURABLE_AUDIT_TOKEN_FD !== '3') { return deny() }
  const fd = 3, chunks: Buffer[] = []
  let bytes = 0
  const stream = createReadStream('', { fd, autoClose: true })
  const timer = setTimeout(() => stream.destroy(new Error('CONTROLLER_FIRST_COLD_CONFIG')), timeoutMs)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFIFO() && !stat.isSocket()) { return deny() }
    for await (const chunk of stream) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += part.length
      if (bytes > 16384) { return deny() }
      chunks.push(part)
    }
    const token = Buffer.concat(chunks).toString('utf8').trim()
    if (!token || !/^[A-Za-z0-9._~+/=-]+$/.test(token)) { return deny() }
    return token
  } catch { return deny() }
  finally { clearTimeout(timer); stream.destroy(); for (const part of chunks) { part.fill(0) } }
}

/** Startup-only optional specialization. Old/absent configuration is inert.
 * Uses the same controller callback and original clients; no extra controller,
 * row-to-authority cast, public RPC or flat observation supplier is introduced. */
export type OrcadColdRewake = Readonly<{
  /** The native session the Session's earlier READY recorded; resumed, never replaced. */
  nativeSessionRef?: string
  reuseProfile?: boolean
  recoverNative?: boolean
  existingCheckout?: boolean
  /** Explicit identity source for later wakes; no inferred Compute creation completion. */
  creationObserver: 'AUTHENTICATED_KUBERNETES_NODE'
}>

export function prepareOrcadFirstColdProvider(config: OrcadControllerConfig, pool: Pool, ca: Uint8Array, initial: Readonly<{
  sessionId: string; planDigest: string; directory: FirstManagedBindingOwnerConfig
}>, originalAuditToken?: string, originalReadSettings?: () => InitialCodexNativeSettings, rewake?: OrcadColdRewake,readCodexCredential?:ManagedCodexCredentialReader) {
  const file = config.firstManagedInitial?.coldConfigFile
  if (!file) { return undefined }
  try {
    if (typeof originalReadSettings !== 'function') { return deny() }
    const readSettings = originalReadSettings
    const parsed = parseUniqueOrcadControllerJson(readPrivateOrcadControllerConfigBytes(file).toString('utf8'))
    const nodeWindow = parsed !== null && typeof parsed === 'object' && Object.hasOwn(parsed, 'creationWindow')
    // provider: "claude" selects Claude with its OAuth token file in place of the Codex auth file.
    const distribution=parsed!==null&&typeof parsed==='object'&&Object.hasOwn(parsed,'nativeDistributionFile')
    const hasTerminal = parsed !== null && typeof parsed === 'object' && Object.hasOwn(parsed, 'terminalDistributionFile')
    const claude = parsed !== null && typeof parsed === 'object' && Object.hasOwn(parsed, 'provider')
    const raw = agentPodFields(parsed,
      ['emptyFolderFile','nativeArtifactFile','nativeSha256','nativeByteLength','controlArtifactFile','controlSha256',...(distribution?['nativeDistributionFile']:[]), ...(hasTerminal ? ['terminalDistributionFile'] : []),
        ...(claude ? ['provider', 'claudeTokenFile'] : ['codexAuthFile']),
        'runtimeServiceAccountName','runtimeServiceAccountUid','originalAuditId','pinId','ownerTokenFile','actorId',
        'clusterIdentityRef','projectId','projectNumber','outputSpoolDirectory', ...(nodeWindow ? ['creationWindow'] : ['creationStartTime','creationEndTime']), 'timeoutMs'])
    const text = (key: string) => agentPodText(raw.get(key))
    const timeoutMs = agentPodInteger(raw.get('timeoutMs'))
    if (timeoutMs > 2_147_483_647 || text('runtimeServiceAccountName') !== 'orca-runtime-agent' ||
        text('projectId') !== 'bold-hope-441519-s3' || text('projectNumber') !== '608028832645') { return deny() }
    const declaration = agentPodFields(parseUniqueOrcadControllerJson(readPrivateOrcadControllerConfigBytes(text('emptyFolderFile')).toString('utf8')),
      ['kind','workspaceId','canonicalDirectory','checkout','sourceCheckout'])
    if (declaration.get('kind') !== 'FRESH_EMPTY_FOLDER' || declaration.get('checkout') !== '/agent/checkout') { return deny() }
    const emptyFolder: InitialEmptyFolderDeclaration = Object.freeze({ kind: 'FRESH_EMPTY_FOLDER',
      workspaceId: logicalId('workspace', agentPodText(declaration.get('workspaceId'))),
      canonicalDirectory: agentPodText(declaration.get('canonicalDirectory')), checkout: '/agent/checkout',
      sourceCheckout: agentPodText(declaration.get('sourceCheckout')) })
    const nativeDistribution=!claude&&distribution?readCodexNativeDistribution(text('nativeDistributionFile'),{file:text('nativeArtifactFile'),sha256:text('nativeSha256'),byteLength:agentPodInteger(raw.get('nativeByteLength'))}):null
    const terminalDistribution = hasTerminal ? readAgentTerminalDistribution(text('terminalDistributionFile')) : null
    const nativeArtifact = Object.freeze({ sha256: text('nativeSha256'), byteLength: agentPodInteger(raw.get('nativeByteLength')),
      ...(terminalDistribution ? { terminal: { platform: terminalDistribution.platform, arch: terminalDistribution.arch, nodeAbi: terminalDistribution.nodeAbi,
        runtime: { sha256: terminalDistribution.runtime.sha256, byteLength: terminalDistribution.runtime.byteLength },
        addon: { sha256: terminalDistribution.addon.sha256, byteLength: terminalDistribution.addon.byteLength } } } : {}),
      ...(nativeDistribution?{codeModeHost:{sha256:nativeDistribution.host.sha256,byteLength:nativeDistribution.host.byteLength},sandboxBwrap:{sha256:nativeDistribution.bwrap.sha256,byteLength:nativeDistribution.bwrap.byteLength}}:{}) })
    // The control bundle (with the Claude SDK) is larger than a config file; the transport caps it at 4 MiB.
    const bootstrapBytes = readPrivateOrcadControllerConfigBytes(text('controlArtifactFile'), 4 * 1024 * 1024)
    const bootstrapSha256 = text('controlSha256'), nativeArtifactFile = text('nativeArtifactFile')
    // Read only the already imported product-managed credential. Never hash,
    // serialize to evidence, publish, or inspect the root original again.
    if (claude && text('provider') !== 'claude') { return deny() }
    if(!claude&&!readCodexCredential) {return deny()}
    // Legacy field is accepted for config compatibility, never an alternate source.
    const codexAuth = ''
    const claudeToken = claude ? agentPodText(readPrivateOrcadControllerConfigBytes(text('claudeTokenFile')).toString('utf8').trim()) : ''
    const ownerToken = agentPodText(readPrivateOrcadControllerConfigBytes(text('ownerTokenFile')).toString('utf8'))
    const originalAuditId = logicalId('event', text('originalAuditId')), pinId = logicalId('storage-namespace-pin', text('pinId'))
    const actorId = text('actorId'), clusterIdentityRef = text('clusterIdentityRef')
    const serviceAccountName = text('runtimeServiceAccountName'), serviceAccountUid = text('runtimeServiceAccountUid')
    const projectId = text('projectId'), projectNumber = text('projectNumber')
    let creation: ControlledCreationWindow
    if (nodeWindow) {
      if (text('creationWindow') !== 'AUTHENTICATED_NODE') { return deny() }
      creation = Object.freeze({ creationWindow: 'AUTHENTICATED_NODE' })
    } else { creation = Object.freeze({ creationStartTime: text('creationStartTime'), creationEndTime: text('creationEndTime') }) }
    if (!rewake && (!originalAuditToken || !/^[A-Za-z0-9._~+/=-]+$/.test(originalAuditToken))) { return deny() }
    let auditToken = originalAuditToken ?? '', supplied = false
    const creationObserver = rewake?.creationObserver ?? createComputeCreationIdentityClient({ timeoutMs,
      tokenProvider: Object.freeze({ async getAccessToken(signal: AbortSignal) {
        if (signal.aborted || supplied || !auditToken) { return deny() }
        supplied = true; const value = auditToken; auditToken = ''; return value
      } }) })
    const apiOrigin = config.inventory.apiOrigin, namespace = config.inventory.namespace, dataset = config.inventory.dataset
    const readReviewerBearer = (signal: AbortSignal) => {
      if (signal.aborted) { return deny() }
      return readOrcadControllerCredential(config.inventory.tokenFile, 'TOKEN').toString('utf8').trim()
    }
    const podAuthenticator = createKubernetesPodAuthenticator({ apiOrigin, ca: Buffer.from(ca), clusterIdentityRef,
      audience: 'orca-runtime-agent', namespace, dataset, timeoutMs, readReviewerBearer })
    let executor: ReturnType<typeof createInitialCodexExecutor> | undefined
    let adopted: ReturnType<typeof createAdoptedCodexExecutor> | null = null, adoptError: string | null = null
    // The cold owner of this process first; otherwise a provider adopted from an earlier process.
    const current = () => executor?.current() ?? adopted?.current() ?? null
    // Same launch/env/policy for the cold path and for adoption of this exact Pod.
    function agentDeployment(pod: Readonly<{ podName: string; podUid: string; runtimeUnitId: string; operationId: string
      executionEpoch: string; specHash: string }>, paths: InitialProviderPaths) {
      if (!claude) { readCodexCredential?.(paths.agentId, rewake===undefined || rewake.existingCheckout===false) }
      const native = captureManagedCodexNativePolicy(readSettings())
      if (native.env.HOME !== undefined && native.env.HOME !== paths.home ||
          native.env.CODEX_HOME !== undefined && native.env.CODEX_HOME !== `${paths.home}/.codex`) { return deny() }
      // Claude's native session id is fixed by the Orca session, as on the desktop lane.
      // A later wake resumes that same session in the new Pod (the launch args are what the Pod's Claude gets).
      const launch = claude
        ? Object.freeze({ command: `${paths.home}/.orca-native/claude`, args: rewake?.nativeSessionRef ? ['--dangerously-skip-permissions', '--resume', rewake.nativeSessionRef]
          : ['--dangerously-skip-permissions', '--session-id', claudeSessionIdForOrcaSession(initial.sessionId)],
          cwd: paths.checkout, env: { HOME: paths.home, PATH: '/usr/local/bin:/usr/bin:/bin', CLAUDE_CODE_OAUTH_TOKEN: claudeToken } })
        : Object.freeze({ command: `${paths.home}/.orca-native/codex`, args: [...native.args, '-c', 'cli_auth_credentials_store="ephemeral"', 'app-server'], cwd: paths.checkout,
          env: { ...native.env, HOME: paths.home, CODEX_HOME: `${paths.home}/.codex`, PATH: native.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' } })
      return Object.freeze({ native, agent: Object.freeze({ apiOrigin, ca: Buffer.from(ca), namespace, container: 'agent', timeoutMs, bootstrapBytes,
        bootstrapSha256, nativeArtifactFile,
        ...(!claude&&readCodexCredential?{readManagedAccess:orcadManagedAccountAccess(pool,config,readCodexCredential,paths.agentId)} : {}), journal:createAgentControlJournal(pool,pod.podUid), ...(nativeDistribution?{nativeCompanionFile:nativeDistribution.host.file,nativeBwrapFile:nativeDistribution.bwrap.file}:{}),
        ...(terminalDistribution ? { terminalSupply: { runtime: terminalDistribution.runtime, addon: terminalDistribution.addon } } : {}), podAuthenticator, readReviewerBearer,
        expected: Object.freeze({ serviceAccountName, serviceAccountUid, ...pod }),
        onProviderChildExit:(exit:Readonly<{controlId:string;hostSeq:number}>)=>recordProviderChildExit(pool,pod,exit),
        policy: Object.freeze({ ...(claude ? { provider: 'claude' as const } : {}), protectedRoot: '/agent', launch, nativeArtifact, codexAuth,
          bindChallenge: randomUUID(), paths }) }) })
    }
    let inputPhase = 'UNUSED', inputError: string | null = null
    const inputRuntime = createTerminalInputRuntime(pool, { current }, notice => {
      inputPhase = notice.phase; inputError = notice.code ?? null
    })
    const output = createTerminalCodexOutput({ pool, spoolDirectory: text('outputSpoolDirectory'), current })
    executor = createInitialCodexExecutor(pool, { sessionId: logicalId('session', initial.sessionId), planDigest: initial.planDigest,
      ...(claude ? { provider: 'claude' as const } : {}),
      ...(rewake?.nativeSessionRef ? { resume: Object.freeze({ nativeSessionRef: rewake.nativeSessionRef }) } : {}),
      existingCheckout: rewake?.existingCheckout, recoverNative:rewake?.recoverNative,
      emptyFolder,
      sink: inputRuntime.observe,
      onNativeNotification: output.onNativeNotification,
      onReady() {
        // Both consumers borrow this SAME original READY owner. Raw cold
        // notifications retained before READY now become drainable.
        void output.drain().catch(() => { /* The output owner retains the failure/spool. */ })
        inputRuntime.ready()
        // Input accepted while no Pod was READY (queued early, or before this
        // owner existed) goes out now; the input runtime ignores a repeat.
        void readPendingTerminalInputs(pool, initial.sessionId).then(list => { for (const item of list) { inputRuntime.committed(item) } })
          .catch(() => { inputError = 'PENDING_INPUT_READ' })
      },
      async deployment({ plan, podUid, paths }, signal) {
        // Legacy READY hosts may still be adopted. Reject incomplete deployment
        // only when a new native COLD is actually requested, before protection/grants.
        if (!claude && !nativeDistribution) {throw new Error('CODEX_NATIVE_DISTRIBUTION_REQUIRED')}
        if (signal.aborted) { return deny() }
        const id = plan.plan.identity
        const prepared = agentDeployment({ podName: id.resourceName, podUid, runtimeUnitId: id.unitId, operationId: id.operationId,
          executionEpoch: id.executionEpoch, specHash: id.specHash }, paths)
        return Object.freeze({ originalAuditId, pinId, ownerToken, actorId, ...creation, nativeOptions: prepared.native.options, codexPolicy: prepared.native.executionPolicy,
          config: Object.freeze({ directory: initial.directory, nfsServer: plan.plan.mountExpectations.protected[0].server,
            mounts: Object.freeze({ apiOrigin, ca: Buffer.from(ca), namespace, dataset, timeoutMs, readReviewerBearer }),
            execution: Object.freeze({ clusterIdentityRef, namespace, dataset, audience: 'orca-runtime-agent', projectId, projectNumber,
              timeoutMs, podAuthenticator, creationObserver }),
            agent: prepared.agent }) })
      } })
    const originalExecutor = executor
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixed internal executor name for adopted dispatch commands.
    const adoptedExecutorId = 'orca-adopted-codex-runtime' as ExecutorId
    const adoptRuntimes: NonNullable<ControllerPassRequest['adoptRuntimes']> = async (_signal, controller) => {
      // Never compete with this process's own cold owner, and never adopt twice.
      if (originalExecutor.current() || adopted?.current() || adopted?.phase() === 'READY' || !['UNUSED', 'READY'].includes(originalExecutor.phase())) { return 0 }
      const candidate = createAdoptedCodexExecutor(pool, { sessionId: logicalId('session', initial.sessionId), executorId: adoptedExecutorId,
        ...(claude ? { provider: 'claude' as const } : {}),
        journaledSequence: connectionId => output.journaledSequence(connectionId),
        sink: inputRuntime.observe, onNativeNotification: output.onNativeNotification,
        onReady() {
          void output.drain().catch(() => { /* retained by the output owner */ }); inputRuntime.ready()
          // Input the lost owner accepted but never dispatched goes out now.
          void readPendingTerminalInputs(pool, initial.sessionId).then(list => { for (const item of list) { inputRuntime.committed(item) } })
            .catch(() => { inputError = 'PENDING_INPUT_READ' })
        },
        async deployment(target) {
          // Only the protected root and checkout are used by an adopted control; nothing is prepared or copied.
          const paths: InitialProviderPaths = Object.freeze({ workspaceId: '', agentId: target.agentId, home: `/agent/home/${target.agentId}`,
            checkout: '/agent/checkout', checkoutPreparation: 'FRESH_EMPTY_FOLDER', canonicalDirectory: '', sourceHome: '', sourceCheckout: '' })
          const prepared = agentDeployment(target, paths)
          // A vanished Pod must not hold the pass: re-attach briefly, then leave it to orphan reconciliation.
          return Object.freeze({ transport: createAgentCodexTransport({ ...prepared.agent, reconnectBudgetMs: 30_000 }), checkout: paths.checkout,
            nativeOptions: prepared.native.options, codexPolicy: prepared.native.executionPolicy })
        } })
      // A failed adoption leaves the attempt to orphan reconciliation; the next pass may try again.
      // Published before adopt(): its onReady drains output and sends pending input through current().
      adopted = candidate
      try { await candidate.adopt(controller); adoptError = null; return 1 }
      catch (error) {
        adopted = null
        adoptError = error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'ADOPTION_FAILED'; return 0 }
    }
    return Object.freeze({ ...originalExecutor, adoptRuntimes,
      // Owned while a cold start runs or a provider owner is held; a lost owner no longer claims the Session.
      ownsSession: (sessionId: string) => sessionId === initial.sessionId &&
        (current() !== null || !['UNUSED', 'READY', 'RETAINED_UNCONFIRMED'].includes(originalExecutor.phase())),
      currentTerminalRuntime: (sessionId: string) => sessionId === initial.sessionId ? current() : null,
      onTerminalInputCommitted: inputRuntime.committed,
      assertOutputAvailable(): void {
        const state = output.snapshot()
        if (state.failed || state.closed) { throw new Error('TERMINAL_OUTPUT_UNAVAILABLE') }
      },
      snapshot: () => Object.freeze({ ...originalExecutor.snapshot(), inputPhase, inputError, output: output.snapshot(),
        adoption: Object.freeze({ phase: adopted?.phase() ?? null, error: adoptError }) }),
      async close(): Promise<void> {
        inputRuntime.dispose()
        try { await inputRuntime.drain() } finally { await output.close() }
      } })
  } catch (error) {
    // The original cause stays a fixed code in the private runtime log; the caller sees only the config refusal.
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') ?? Reflect.get(error, 'message') : null
    process.stderr.write(`[orcad] first cold config refused: ${typeof code === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(code) ? code : 'UNCLASSIFIED'}\n`)
    return deny()
  }
}
