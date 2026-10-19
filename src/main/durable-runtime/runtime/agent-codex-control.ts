import { readNativeSessionCheckpoint, markNativeEntered, recordNativeSessionCheckpoint, claudeResumeLaunch } from './native-session-checkpoint.ts'
import { randomUUID } from 'node:crypto'
import { constants, openSync, fstatSync, closeSync, readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { createInterface } from 'node:readline'
import { spawnSync } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { openCodexAppServerConnection } from '../../codex/codex-app-server-connection.ts'
import { CodexAppServerHandshakeExitUnprovenError } from '../../codex/codex-app-server-handshake-exit-proof.ts'
import type { CodexAppServerConnection } from '../../codex/codex-app-server-connection-types.ts'
import { immutableSnapshot } from '../providers/shared/immutable-snapshot.ts'
import type { CodexProtocolDependencies } from '../providers/codex/protocol.ts'
import { agentMountProbeSource } from '../storage/agent-mount-collector-probe.ts'
import { createAgentCodexPreparation } from './agent-codex-preparation.ts'
import type { CodexNativeArtifact } from './agent-codex-preparation.ts'
import type { InitialProviderPaths } from './initial-provider-paths.ts'
import { AGENT_CLAUDE_METHODS, openAgentClaudeNative } from './agent-claude-native.ts'
import type { AgentNativeConnection } from './agent-claude-native.ts'

type Launch = Parameters<CodexProtocolDependencies['open']>[0]
/** Installed by trusted deployment/bootstrap composition, not decoded from a
 * public RPC. Launch env may contain secrets: never hash or persist this DTO. */
export type AgentCodexControlPolicy = Readonly<{
  /** Absent means Codex; Claude carries its OAuth token in launch.env and an empty codexAuth. */
  provider?: 'codex' | 'claude'
  protectedRoot: string
  launch: Launch
  nativeArtifact: CodexNativeArtifact
  codexAuth: string
  bindChallenge: string
  paths: InitialProviderPaths
}>

/** Runs INSIDE the Agent Pod. It holds the actual protected root directory open
 * while the backend authenticates this control instance and commits its grants.
 * The private exec channel is not public RPC or physical authority by itself.
 * Native effects are impossible until its one COLD message; only the upper
 * actual-COMMIT permit may send that message over the owned connection. */
export function runAgentCodexControl(original: AgentCodexControlPolicy,
  input: Readable = process.stdin, output: Writable = process.stdout): Readonly<{
    phase(): string
    closed: Promise<void>
  }> {
  const policy = immutableSnapshot(original), controlId = randomUUID()
  if (!/^[0-9a-f-]{36}$/.test(policy.bindChallenge)) { throw new Error('AGENT_CODEX_BIND_CHALLENGE') }
  const provider = policy.provider ?? 'codex'
  const nativeMethods = provider === 'claude' ? AGENT_CLAUDE_METHODS : new Set(['thread/start', 'thread/resume', 'turn/start', 'turn/interrupt'])
  let phase = 'CLOSED_GATE', connection: CodexAppServerConnection | AgentNativeConnection | null = null
  let coldUsed = false, stopping = false, uncertain = false
  const root = policy.protectedRoot
  const paths = policy.paths
  if (root !== '/agent' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(paths.agentId) ||
      paths.home !== `${root}/home/${paths.agentId}` ||
      paths.checkout !== `${root}/checkout` || !['FRESH_EMPTY_FOLDER', 'EXISTING'].includes(paths.checkoutPreparation) ||
      policy.launch.cwd !== paths.checkout || policy.launch.env.HOME !== paths.home ||
      policy.launch.command !== `${paths.home}/.orca-native/${provider}` ||
      provider === 'codex' && (policy.launch.env.CODEX_HOME !== `${paths.home}/.codex` || policy.launch.args.at(-1) !== 'app-server') ||
      provider === 'claude' && (!policy.launch.env.CLAUDE_CODE_OAUTH_TOKEN || policy.codexAuth !== '')) {
    throw new Error('AGENT_CODEX_DEPLOYMENT_POLICY')
  }
  const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const stat = fstatSync(fd)
  if (!stat.isDirectory()) { closeSync(fd); throw new Error('AGENT_CODEX_PROTECTED_ROOT') }
  const preparation = createAgentCodexPreparation(fd, policy.nativeArtifact, policy.codexAuth, paths, provider)
  const seen = new Set<string>()
  let resolveClosed!: () => void
  const closed = new Promise<void>(resolve => { resolveClosed = resolve })
  // A lost request/transport does not release protection or pretend descendants
  // stopped. The original owner must reconcile this exact control instance.
  const retained = setInterval(() => {}, 2_147_483_647)
  const reader = createInterface({ input, crlfDelay: Infinity })
  function send(value: unknown): void {
    if (output.destroyed || !output.writable) { uncertain = true; phase = 'UNCONFIRMED'; return }
    try { output.write(`${JSON.stringify(value)}\n`) }
    catch { uncertain = true; phase = 'UNCONFIRMED' }
  }
  function response(id: string, value: unknown): void { send({ id, controlId, result: value }) }
  function failure(id: string, code: string): void { send({ id, controlId, error: { code } }) }
  function releaseRoot(): void {
    preparation.close(); closeSync(fd); clearInterval(retained); reader.close(); phase = 'STOPPED'; resolveClosed()
  }
  output.on('error', () => { uncertain = true; phase = 'UNCONFIRMED' })
  reader.on('close', () => {
    if (phase !== 'STOPPED') { uncertain = true; phase = 'UNCONFIRMED' }
  })
  // A projected Pod-bound token stays in the private authenticated exec channel
  // and is consumed by the existing TokenReview boundary. It is never an audit
  // field, a control reference, a launch environment value, or a hashed input.
  let podBearer: string
  try { podBearer = readFileSync('/var/run/secrets/orca-runtime-agent/token', 'utf8').trim() }
  catch { releaseRoot(); throw new Error('AGENT_CODEX_POD_CREDENTIAL') }
  const proc = readFileSync('/proc/self/stat', 'utf8'), startTicks = proc.slice(proc.lastIndexOf(')') + 2).split(' ')[19]
  send({ event: 'HELLO', controlId, pid: process.pid, startTicks, bindChallenge: policy.bindChallenge,
    root: { path: root, device: String(stat.dev), inode: String(stat.ino) }, podBearer })
  podBearer = ''
  let serial = Promise.resolve()
  reader.on('line', line => {
    serial = serial.then(async () => {
      let request: Record<string, unknown>
      try {
        if (Buffer.byteLength(line) > 1024 * 1024) { throw new Error('FRAME_SIZE') }
        const value: unknown = JSON.parse(line)
        if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('FRAME') }
        request = value as Record<string, unknown>
      } catch { uncertain = true; phase = 'UNCONFIRMED'; return }
      const id = request.id
      if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id) || request.controlId !== controlId || seen.has(id)) {
        uncertain = true; phase = 'UNCONFIRMED'; return
      }
      seen.add(id)
      if (stopping) { failure(id, 'AGENT_CONTROL_UNCONFIRMED'); return }
      if (request.method === 'CLOSE') {
        stopping = true; phase = 'STOPPING'
        // A lost native request can still be reconciled with the ORIGINAL
        // connection's owned process proof. It never permits another COLD.
        const stopped = connection ? await connection.close() : !coldUsed
        if (!stopped) { uncertain = true; phase = 'UNCONFIRMED'; failure(id, 'AGENT_STOP_UNCONFIRMED'); return }
        response(id, { stopped: true, controlId }); releaseRoot(); return
      }
      if (uncertain) { failure(id, 'AGENT_CONTROL_UNCONFIRMED'); return }
      if (request.method === 'PREPARE_COLD' || request.method === 'NATIVE_CHUNK' || request.method === 'NATIVE_FINISH') {
        if (coldUsed || !['CLOSED_GATE', 'PREPARING_COLD'].includes(phase)) { failure(id, 'AGENT_COLD_PREPARATION_GATE'); return }
        try {
          if (request.method === 'PREPARE_COLD') { preparation.begin(); phase = 'PREPARING_COLD' }
          else if (request.method === 'NATIVE_CHUNK') {
            const params = request.params
            if (!params || typeof params !== 'object') { throw new Error('AGENT_COLD_CHUNK_PARAMS') }
            preparation.append(Reflect.get(params, 'offset'), Reflect.get(params, 'bytes'))
          } else { preparation.finish(); phase = 'CLOSED_GATE' }
          response(id, { prepared: preparation.ready() })
        } catch { uncertain = true; phase = 'UNCONFIRMED'; failure(id, 'AGENT_COLD_PREPARATION_FAILED') }
        return
      }
      if(request.method==='NATIVE_STATE') {response(id,readNativeSessionCheckpoint(paths.home,provider));return}
      if (request.method === 'MOUNT_PROBE') {
        if (phase !== 'CLOSED_GATE' || coldUsed) { failure(id, 'AGENT_MOUNT_PROBE_GATE'); return }
        // Reuse the original fixed read-only probe within this authenticated
        // control. No broader exec-admission exception or caller root list.
        const probe = spawnSync('/usr/local/bin/node', ['-e', agentMountProbeSource,
          JSON.stringify({ roots: ['/agent', '/shared'] })], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
        if (probe.status !== 0 || probe.stderr) { failure(id, 'AGENT_MOUNT_PROBE_FAILED'); return }
        response(id, { output: probe.stdout }); return
      }
      if (request.method === 'COLD') {
        if (coldUsed || phase !== 'CLOSED_GATE' || !preparation.ready() || !isDeepStrictEqual(request.launch, policy.launch)) {
          failure(id, 'AGENT_COLD_POLICY'); return
        }
        const priorNative=readNativeSessionCheckpoint(paths.home,provider)
        if(priorNative.state==='UNKNOWN') {failure(id,'NATIVE_IDENTITY_UNCONFIRMED');return}
        const launch=provider==='claude' && priorNative.state==='FOUND' ? claudeResumeLaunch(policy.launch,priorNative.nativeSessionRef) : policy.launch
        markNativeEntered(paths.home)
        coldUsed = true; phase = 'OPENING'
        if (provider === 'claude') {
          try {
            connection = await openAgentClaudeNative(launch, {
              onFault: () => { uncertain = true; phase = 'UNCONFIRMED'; send({ event: 'NATIVE_UNAVAILABLE', controlId }) },
              onNotification: (method, params) => {
                if(method==='claude/message' && params && typeof params==='object' && Reflect.get(params,'type')==='system' && Reflect.get(params,'subtype')==='init' && typeof Reflect.get(params,'session_id')==='string') {
                  recordNativeSessionCheckpoint(paths.home,'claude',Reflect.get(params,'session_id'))
                }
                send({ event: 'NOTIFICATION', controlId, method, params })
              },
              onExit: () => { uncertain = true; phase = 'UNCONFIRMED'; send({ event: 'NATIVE_EXIT', controlId, provider }) },
            })
            phase = 'READY'; response(id, { nativePid: connection.pid })
          } catch (error) {
            // Pod-local diagnostic only (host log); the backend still sees the fixed code.
            process.stderr.write(`AGENT_CLAUDE_COLD_FAILED ${error instanceof Error ? error.message.slice(0, 400) : 'unknown'}\n`)
            uncertain = true; phase = 'UNCONFIRMED'; failure(id, 'AGENT_COLD_FAILED')
          }
          return
        }
        let codex: CodexAppServerConnection | null = null
        try {
          connection = codex = await openCodexAppServerConnection(policy.launch, {
            onNotification: (method, params) => send({ event: 'NOTIFICATION', controlId, method, params }),
            onServerRequest: pending => codex?.respondWithError(pending.id, -32000,
              'Durable Codex driver does not support this reply channel'),
            onExit: () => { uncertain = true; phase = 'UNCONFIRMED'; send({ event: 'NATIVE_EXIT', controlId }) },
          })
          phase = 'READY'; response(id, { nativePid: connection.pid })
        } catch (error) {
          // Initialization may fail without a proven process-tree exit. Keep
          // the original owned handle so CLOSE can reconcile THAT process;
          // neither this error nor the preserved connection permits COLD again.
          if (error instanceof CodexAppServerHandshakeExitUnprovenError) { connection = error.connection }
          uncertain = true; phase = 'UNCONFIRMED'; failure(id, 'AGENT_COLD_FAILED')
        }
        return
      }
      if (!connection || phase !== 'READY' || typeof request.method !== 'string' || !nativeMethods.has(request.method)) {
        failure(id, 'AGENT_NATIVE_METHOD'); return
      }
      try {
        const params = request.params
        if (!params || typeof params !== 'object' || Array.isArray(params)) { failure(id, 'AGENT_NATIVE_PARAMS'); return }
        const result=await connection.request(request.method,params as Record<string,unknown>)
        if(provider==='codex' && ['thread/start','thread/resume'].includes(request.method) && result && typeof result==='object') {
          const thread=Reflect.get(result,'thread'),native=thread && typeof thread==='object'?Reflect.get(thread,'id'):null
          if(typeof native!=='string') {throw Error('NATIVE_THREAD_RESPONSE')}
          recordNativeSessionCheckpoint(paths.home,'codex',native)
        }
        response(id,result)
      } catch { failure(id, 'AGENT_NATIVE_REQUEST_UNCONFIRMED') }
    }).catch(() => { uncertain = true; phase = 'UNCONFIRMED' })
  })
  return Object.freeze({ phase: () => phase, closed })
}
