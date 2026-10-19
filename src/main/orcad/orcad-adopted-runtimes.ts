import { createAgentControlJournal } from '../durable-runtime/runtime/agent-control-journal.ts'
import { recordProviderChildExit } from '../durable-runtime/runtime/provider-start-observation.ts'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Pool } from 'pg'
import type { OrcadControllerConfig } from './orcad-controller-config.ts'
import { invalidOrcadControllerConfig, parseUniqueOrcadControllerJson, readPrivateOrcadControllerConfigBytes } from './orcad-controller-config.ts'
import { readOrcadControllerCredential } from './orcad-controller-credential.ts'
import { agentPodFields, agentPodInteger, agentPodText } from '../durable-runtime/runtime/agent-pod-policy.ts'
import { createKubernetesPodAuthenticator } from '../durable-runtime/runtime/kubernetes-pod-auth.ts'
import { captureManagedCodexNativePolicy } from '../durable-runtime/runtime/initial-codex-native-policy.ts'
import type { InitialCodexNativeSettings } from '../durable-runtime/runtime/initial-codex-native-policy.ts'
import { createTerminalInputRuntime } from '../durable-runtime/input/runtime-input.ts'
import { readPendingTerminalInputs } from '../durable-runtime/input/pending-terminal-input.ts'
import type { TerminalInputCommittedSink } from '../durable-runtime/input/runtime-input-types.ts'
import { createTerminalCodexOutput } from '../durable-runtime/output/terminal-codex-output.ts'
import { createAdoptedCodexExecutor } from '../durable-runtime/runtime/adopted-codex-executor.ts'
import type { AdoptedCodexTarget } from '../durable-runtime/runtime/adopted-codex-executor.ts'
import { createAgentCodexTransport } from '../durable-runtime/runtime/agent-codex-transport.ts'
import type { ControllerPassRequest } from '../durable-runtime/ha/pass.ts'
import type { ExecutorId } from '../durable-runtime/runtime/gateway/types.ts'
import { logicalId } from '../../shared/durable-runtime/identity.ts'
import type { UnitOwnership } from './orcad-unit-ownership.ts'

const deny = (): never => invalidOrcadControllerConfig('CONTROLLER_ADOPTION_CONFIG')
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixed internal executor name for adopted dispatch commands.
const ADOPTED_EXECUTOR = 'orca-adopted-codex-runtime' as ExecutorId

type Entry = Readonly<{
  executor: ReturnType<typeof createAdoptedCodexExecutor>
  input: ReturnType<typeof createTerminalInputRuntime>
  output: ReturnType<typeof createTerminalCodexOutput>
}>

/** Takes over every READY Codex or Claude session whose Pod-local control host an earlier
 * backend process recorded, one owner per session. It never starts a Pod,
 * control, native process or cold attempt; a session whose host is gone stays
 * for orphan reconciliation. It adopts only after claiming the unit's attempt
 * in this process's unit ownership (one owner per unit). */
export function prepareOrcadAdoptedRuntimes(pool: Pool, config: OrcadControllerConfig, ca: Uint8Array,
  readSettings: () => InitialCodexNativeSettings, ownership: UnitOwnership) {
  const file = config.adoption?.configFile
  if (!file) { return null }
  const raw = agentPodFields(parseUniqueOrcadControllerJson(readPrivateOrcadControllerConfigBytes(file).toString('utf8')),
    ['controlArtifactDirectory', 'runtimeServiceAccountName', 'runtimeServiceAccountUid', 'clusterIdentityRef', 'outputSpoolRoot', 'timeoutMs'])
  const text = (key: string) => agentPodText(raw.get(key))
  const timeoutMs = agentPodInteger(raw.get('timeoutMs'))
  if (text('runtimeServiceAccountName') !== 'orca-runtime-agent' || timeoutMs > 2_147_483_647) { return deny() }
  const artifacts = text('controlArtifactDirectory'), spoolRoot = text('outputSpoolRoot')
  const apiOrigin = config.inventory.apiOrigin, namespace = config.inventory.namespace, dataset = config.inventory.dataset
  const readReviewerBearer = (signal: AbortSignal) => {
    if (signal.aborted) { return deny() }
    return readOrcadControllerCredential(config.inventory.tokenFile, 'TOKEN').toString('utf8').trim()
  }
  const podAuthenticator = createKubernetesPodAuthenticator({ apiOrigin, ca: Buffer.from(ca), clusterIdentityRef: text('clusterIdentityRef'),
    audience: 'orca-runtime-agent', namespace, dataset, timeoutMs, readReviewerBearer })
  const entries = new Map<string, Entry>(), errors = new Map<string, string>()
  let lastInput: string | null = null

  function transportFor(target: AdoptedCodexTarget) {
    if (!target.controlSha256) { return deny() }
    const home = `/agent/home/${target.agentId}`, native = captureManagedCodexNativePolicy(readSettings())
    // Re-attach only: the bundle must be the one the recorded host verified; no host launch policy is resent.
    const bootstrapBytes = readFileSync(join(artifacts, `agent-control-${target.controlSha256}.cjs`))
    const launch = Object.freeze({ command: `${home}/.orca-native/codex`, args: [...native.args, 'app-server'], cwd: '/agent/checkout',
      env: { ...native.env, HOME: home, CODEX_HOME: `${home}/.codex`, PATH: native.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' } })
    const transport = createAgentCodexTransport({ apiOrigin, ca: Buffer.from(ca), namespace, container: 'agent', timeoutMs, reconnectBudgetMs: 30_000,
      bootstrapBytes, bootstrapSha256: target.controlSha256, journal:createAgentControlJournal(pool,target.podUid), nativeArtifactFile: '', podAuthenticator, readReviewerBearer,
      onProviderChildExit:(exit)=>recordProviderChildExit(pool,target,exit),
      expected: Object.freeze({ serviceAccountName: text('runtimeServiceAccountName'), serviceAccountUid: text('runtimeServiceAccountUid'),
        podName: target.podName, podUid: target.podUid, runtimeUnitId: target.runtimeUnitId, operationId: target.operationId,
        executionEpoch: target.executionEpoch, specHash: target.specHash }),
      policy: Object.freeze({ protectedRoot: '/agent', launch, nativeArtifact: Object.freeze({ sha256: '0'.repeat(64), byteLength: 1 }), codexAuth: '',
        bindChallenge: '00000000-0000-4000-8000-000000000000', paths: Object.freeze({ workspaceId: '', agentId: target.agentId, home,
          checkout: '/agent/checkout' as const, checkoutPreparation: 'FRESH_EMPTY_FOLDER' as const, canonicalDirectory: '', sourceHome: '', sourceCheckout: '' }) }) })
    return Object.freeze({ transport, checkout: '/agent/checkout', nativeOptions: native.options, codexPolicy: native.executionPolicy })
  }

  async function adoptSession(sessionId: string, provider: 'codex' | 'claude', controller: Parameters<NonNullable<ControllerPassRequest['adoptRuntimes']>>[1]): Promise<boolean> {
    const spool = join(spoolRoot, sessionId)
    mkdirSync(spool, { recursive: true, mode: 0o700 })
    let executor: ReturnType<typeof createAdoptedCodexExecutor> | null = null
    const current = () => executor?.current() ?? null
    const input = createTerminalInputRuntime(pool, { current }, notice => { lastInput = `${notice.phase}:${notice.code ?? 'NONE'}` })
    const output = createTerminalCodexOutput({ pool, spoolDirectory: spool, current })
    executor = createAdoptedCodexExecutor(pool, { sessionId: logicalId('session', sessionId), executorId: ADOPTED_EXECUTOR,
      ...(provider === 'claude' ? { provider: 'claude' as const } : {}),
      journaledSequence: connectionId => output.journaledSequence(connectionId),
      sink: input.observe, onNativeNotification: output.onNativeNotification,
      onReady() {
        void output.drain().catch(() => { /* retained by the output owner */ }); input.ready()
        // Input the lost owner accepted but never dispatched goes out now.
        void readPendingTerminalInputs(pool, sessionId).then(list => { for (const item of list) { input.committed(item) } })
          .catch(() => { lastInput = 'RETAINED:PENDING_INPUT_READ' })
      },
      deployment: async target => transportFor(target) })
    try {
      await executor.adopt(controller)
      entries.set(sessionId, Object.freeze({ executor, input, output }))
      errors.delete(sessionId)
      return true
    } catch (error) {
      errors.set(sessionId, error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'ADOPTION_FAILED')
      input.dispose()
      await output.close().catch(() => undefined)
      return false
    }
  }

  const adoptRuntimes: NonNullable<ControllerPassRequest['adoptRuntimes']> = async (signal, controller) => {
    const found = await pool.query<{ session_id: string; provider: 'codex' | 'claude'; unit_id: string; attempt_id: string }>(
      `SELECT h.session_id,h.provider,a.runtime_unit_id AS unit_id,a.id AS attempt_id FROM durable_runtime.agent_control_hosts h
      JOIN durable_runtime.attempts a ON a.id=h.attempt_id JOIN durable_runtime.runtime_units u ON u.active_attempt_id=a.id
      JOIN durable_runtime.sessions s ON s.id=h.session_id
      WHERE h.provider IN ('codex','claude') AND h.control_sha256 IS NOT NULL AND a.status='READY' AND a.stopped_at IS NULL
      AND u.phase='READY' AND s.lifecycle='OPEN' ORDER BY h.recorded_at`)
    let adopted = 0
    for (const { session_id: sessionId, provider, unit_id: unitId, attempt_id: attemptId } of found.rows) {
      if (signal.aborted) { break }
      const entry = entries.get(sessionId)
      // An adopted owner stays this session's owner: its in-flight deliveries and observations live in it.
      if (entry?.executor.current() || entry?.executor.phase() === 'READY') { continue }
      if (!(await ownership.claim(unitId, sessionId, 'adopted', { attemptId }))) { continue }
      if (entry) { entries.delete(sessionId); entry.input.dispose(); await entry.output.close().catch(() => undefined) }
      if (await adoptSession(sessionId, provider, controller)) { adopted++ } else { ownership.release(unitId, 'adopted') }
    }
    return adopted
  }
  return Object.freeze({
    adoptRuntimes,
    onTerminalInputCommitted: ((input) => { entries.get(input.authority.sessionId)?.input.committed(input) }) satisfies TerminalInputCommittedSink,
    snapshot: () => Object.freeze({ adopted: entries.size, failed: errors.size,
      firstError: errors.size ? [...errors.values()][0] : null, lastInput }),
    async close(): Promise<void> {
      for (const entry of entries.values()) {
        entry.input.dispose()
        try { await entry.input.drain() } finally { await entry.output.close() }
      }
      entries.clear()
    },
  })
}
