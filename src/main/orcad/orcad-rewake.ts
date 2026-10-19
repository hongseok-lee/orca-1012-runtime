import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../shared/durable-runtime/identity.ts'
import { runDurableTransaction } from '../durable-runtime/db/connection.ts'
import { lockAggregates } from '../durable-runtime/db/locks.ts'
import type { ControllerPassRequest } from '../durable-runtime/ha/pass.ts'
import { requestUnitIntent } from '../durable-runtime/lifecycle/intent.ts'
import type { UnitIntentAuthority } from '../durable-runtime/lifecycle/types.ts'
import { claimOwnerlessWakeRetirement } from '../durable-runtime/runtime/ownerless-wake-retirement.ts'
import type { VerifiedControllerIdentity } from '../durable-runtime/runtime/gateway/types.ts'
import { currentAuthoritySql } from '../durable-runtime/runtime/gateway/authority.ts'
import { retireAgentPod } from '../durable-runtime/runtime/agent-pod-retirement.ts'
import { agentPodPlanSource } from '../durable-runtime/runtime/agent-pod-plan-records.ts'
import { agentPodFields, agentPodInteger, agentPodText } from '../durable-runtime/runtime/agent-pod-policy.ts'
import type { createComputeCreationIdentityClient } from '../durable-runtime/runtime/compute-creation-identity.ts'
import { canonicalInput } from '../durable-runtime/runtime/gateway/input.ts'
import type { InitialCodexNativeSettings } from '../durable-runtime/runtime/initial-codex-native-policy.ts'
import type { TerminalInputCommittedSink } from '../durable-runtime/input/runtime-input-types.ts'
import type { OrcadControllerConfig } from './orcad-controller-config.ts'
import { invalidOrcadControllerConfig, parseUniqueOrcadControllerJson, readPrivateOrcadControllerConfigBytes } from './orcad-controller-config.ts'
import { readOrcadControllerCredential } from './orcad-controller-credential.ts'
import { prepareOrcadFirstManagedInitial } from './orcad-first-managed-initial.ts'
import type { UnitOwnership } from './orcad-unit-ownership.ts'

const deny = (): never => invalidOrcadControllerConfig('CONTROLLER_REWAKE_CONFIG')
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
type Dispatch = NonNullable<ReturnType<typeof prepareOrcadFirstManagedInitial>>
type Entry = { sessionId: string; unitId: string; operationId: string; dispatch: Dispatch; error: string | null }
type Native = Readonly<{ nativeArtifactFile: string; nativeSha256: string; nativeByteLength: number }>

/** A Pod's node is already authenticated through its Kubernetes Pod identity; a
 * later wake takes that node identity as its creation evidence instead of a
 * one-shot Cloud Audit Logs token (personal-scale deployment, single writer kept). */
function nodeIdentityCreationObserver(): ReturnType<typeof createComputeCreationIdentityClient> {
  return Object.freeze({
    async observe(input: Parameters<ReturnType<typeof createComputeCreationIdentityClient>['observe']>[0]) {
      const at = new Date().toISOString(), scope = input.scope
      return Object.freeze({ ok: true as const, observation: Object.freeze({ status: 'CREATE_OPERATION_COMPLETED' as const,
        source: 'CLOUD_AUDIT_LOGS' as const, identity: Object.freeze({ ...scope }), operationId: `node-identity:${scope.numericInstanceId}`,
        producer: 'compute.googleapis.com' as const, first: Object.freeze({ insertId: 'node-identity', timestamp: at }),
        last: Object.freeze({ insertId: 'node-identity', timestamp: at }),
        evidenceDigest: sha(JSON.stringify(['node-identity', scope.projectNumber, scope.zone, scope.instanceName, scope.numericInstanceId])) }) })
    },
  }) as ReturnType<typeof createComputeCreationIdentityClient>
}

/** Starts a new Agent Pod for a READY-before Session whose Pod is gone (orphan
 * reconciled) once its input waits: a new WAKE operation, the same Pod shape and
 * binding, and the same native session resumed. Each wake runs through the
 * original first-managed attempt/grant/protection path, so one writer holds the
 * protected leaf at a time. One wake runs at a time in this process. */
export function prepareOrcadRewake(pool: Pool, config: OrcadControllerConfig, readSettings: () => InitialCodexNativeSettings,
  ownership: UnitOwnership) {
  const file = config.rewake?.configFile
  if (!file) { return null }
  const raw = agentPodFields(parseUniqueOrcadControllerJson(readPrivateOrcadControllerConfigBytes(file).toString('utf8')),
    ['baseTargetFile', 'baseProfileFile', 'controlArtifactFile', 'controlSha256', 'codex', 'claude', 'runtimeServiceAccountUid',
      'clusterIdentityRef', 'projectId', 'projectNumber', 'stateDirectory', 'timeoutMs', 'nfsPodLabel', 'lifecyclePolicy'])
  const text = (key: string) => agentPodText(raw.get(key))
  const native = (key: 'codex' | 'claude'): Native & Record<string, unknown> => {
    const n = agentPodFields(raw.get(key), ['nativeArtifactFile', 'nativeSha256', 'nativeByteLength', key === 'codex' ? 'codexAuthFile' : 'claudeTokenFile'])
    return Object.freeze({ nativeArtifactFile: agentPodText(n.get('nativeArtifactFile')), nativeSha256: agentPodText(n.get('nativeSha256')),
      nativeByteLength: agentPodInteger(n.get('nativeByteLength')),
      ...(key === 'codex' ? { codexAuthFile: agentPodText(n.get('codexAuthFile')) } : { provider: 'claude', claudeTokenFile: agentPodText(n.get('claudeTokenFile')) }) })
  }
  const codex = native('codex'), claude = native('claude')
  const lifecycle = agentPodFields(raw.get('lifecyclePolicy'), ['operationDeadlineMs', 'idleDurationMs'])
  const lifecyclePolicy = Object.freeze({ operationDeadlineMs: agentPodInteger(lifecycle.get('operationDeadlineMs')),
    idleDurationMs: lifecycle.get('idleDurationMs') === null ? null : agentPodInteger(lifecycle.get('idleDurationMs')) })
  const baseTarget = agentPodFields(parseUniqueOrcadControllerJson(readPrivateOrcadControllerConfigBytes(text('baseTargetFile')).toString('utf8')),
    ['policy', 'request', 'policyRevision', 'sessionId', 'actorId', 'originalAuditId', 'pinId', 'binding', 'executorId',
      'ownerTokenFile', 'acceptedProfileFile', 'expectedProfileDigest', 'podTokenFile', 'podTimeoutMs', 'credential', 'collector'])
  const baseProfile = JSON.parse(readPrivateOrcadControllerConfigBytes(text('baseProfileFile')).toString('utf8')) as Record<string, unknown>
  const actorId = agentPodText(baseTarget.get('actorId')), stateDirectory = text('stateDirectory'), timeoutMs = agentPodInteger(raw.get('timeoutMs'))
  if (timeoutMs > 2_147_483_647 || !baseProfile || typeof baseProfile !== 'object') { return deny() }
  const ca = readOrcadControllerCredential(config.inventory.caFile, 'CA')
  const observer = nodeIdentityCreationObserver()
  const entries = new Map<string, Entry>()
  let lastError: string | null = null, started = 0, abandoned = 0
  // Per Session: failed wakes and when the next one may start (bounded retry).
  const failures = new Map<string, { count: number; nextAt: number }>()
  const RETRY_MS = 60_000, MAX_WAKES = 3
  const describe = (entry: Entry): string => {
    const s = entry.dispatch.snapshot()
    return [s.errorCode, s.executionErrorCode, s.preparationErrorCode, s.reservationCode, s.target?.errorCode, s.assignment?.errorCode, s.coldFailure]
      .filter(code => !!code).join(':').replace(/[^A-Z0-9_:]/g, '_').slice(0, 150) || 'REWAKE_FAILED'
  }

  /** A wake this process (or an earlier one) started whose owner is gone or
   * failed: once no attempt of the Unit is live (none reserved, or its Pod was
   * deleted and orphan reconciliation stopped it), the operation and its
   * command are closed as FAILED and the Session may wake again. */
  async function abandon(operationId: string, reason: string, controller?: VerifiedControllerIdentity): Promise<boolean> {
    const result = await runDurableTransaction(pool, async tx => {
      if (!controller || !(await tx.query(`SELECT 1 WHERE ${currentAuthoritySql}`, [controller.scope,controller.owner,controller.term])).rowCount) { return false }
      // An already terminal wake may still hold a command claimed by a lost owner.
      const op = (await tx.query<{ runtime_unit_id: string }>(`SELECT runtime_unit_id FROM durable_runtime.operations o
        WHERE id=$1 AND controller_scope=$2 AND kind='WAKE' AND (result IS NULL OR EXISTS(SELECT 1 FROM durable_runtime.runtime_commands c
          WHERE c.operation_id=o.id AND c.state IN ('ACCEPTED','EXECUTING')))`, [operationId,controller.scope])).rows[0]
      if (!op) { return false }
      const members = (await tx.query<{ session_id: string }>('SELECT session_id FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1',
        [op.runtime_unit_id])).rows.map(row => logicalId('session', row.session_id))
      await lockAggregates(tx, { sessionIds: members, runtimeUnitIds: [logicalId('runtime-unit', op.runtime_unit_id)] })
      // A live attempt keeps its writer; a stopped one was fenced by orphan reconciliation.
      const live = await tx.query('SELECT 1 FROM durable_runtime.attempts WHERE runtime_unit_id=$1 AND stopped_at IS NULL', [op.runtime_unit_id])
      if (live.rowCount) { return false }
      const failed = JSON.stringify({ state: 'FAILED', reason })
      await tx.query(`UPDATE durable_runtime.runtime_commands SET state='RESOLVED',settled_at=clock_timestamp(),result=$2::jsonb,revision=revision+1
        WHERE operation_id=$1 AND state IN ('ACCEPTED','EXECUTING')`, [operationId, failed])
      await tx.query(`UPDATE durable_runtime.operations SET step='FAILED',step_revision=step_revision+1,revision=revision+1,result=$2::jsonb
        WHERE id=$1 AND result IS NULL`, [operationId, failed])
      await tx.query(`UPDATE durable_runtime.runtime_units SET phase='ABSENT',revision=revision+1
        WHERE id=$1 AND active_attempt_id IS NULL AND phase='PROVISIONING'`, [op.runtime_unit_id])
      return true
    })
    return result.ok && result.commitOutcome === 'ACKNOWLEDGED' && result.value
  }
  /** Open wakes started under this state directory that no live owner holds. */
  async function settleOwnerless(signal: AbortSignal, controller: VerifiedControllerIdentity): Promise<void> {
    if (!existsSync(stateDirectory)) { return }
    const started = new Set(readdirSync(stateDirectory).flatMap(session => {
      try { return readdirSync(join(stateDirectory, session)) } catch { return [] }
    }))
    const open = (await pool.query<{ id: string }>(`SELECT o.id FROM durable_runtime.operations o WHERE o.kind='WAKE' AND (o.result IS NULL
      OR EXISTS(SELECT 1 FROM durable_runtime.runtime_commands c WHERE c.operation_id=o.id AND c.state IN ('ACCEPTED','EXECUTING')))`)).rows
    for (const { id } of open) {
      const entry = entries.get(id)
      if (!started.has(id) || (entry && entry.dispatch.snapshot().status !== 'FAILED')) { continue }
      const reason = entry ? describe(entry) : 'REWAKE_OWNER_LOST'
      // Its Pod (if any) goes first; orphan reconciliation then fences the attempt and a later pass closes the wake.
      const attempt = await claimOwnerlessWakeRetirement(pool, controller, id)
      if (attempt && !signal.aborted) {
        const reviewer = readOrcadControllerCredential(config.inventory.tokenFile, 'TOKEN').toString('utf8').trim()
        const retirement = await retireAgentPod({ apiOrigin: config.inventory.apiOrigin, namespace: config.inventory.namespace, ca, reviewer },
          attempt, AbortSignal.any([signal, AbortSignal.timeout(config.inventory.requestTimeoutMs)]))
        if (retirement === 'CONFLICT' || retirement === 'UNKNOWN') { lastError = `REWAKE_RETIRE_${retirement}` }
      }
      if (await abandon(id, reason, controller) && entry) {
        entries.delete(id); abandoned++; lastError = reason
        ownership.release(entry.unitId, 'rewake')
        const failure = failures.get(entry.sessionId) ?? { count: 0, nextAt: 0 }
        failures.set(entry.sessionId, { count: failure.count + 1, nextAt: Date.now() + RETRY_MS })
      } else if (!entry) { abandoned++ }
    }
  }

  function nfsPod(): Promise<{ name: string; uid: string }> {
    const token = readOrcadControllerCredential(config.inventory.tokenFile, 'TOKEN').toString('utf8').trim()
    const url = new URL(`/api/v1/namespaces/${config.inventory.namespace}/pods?labelSelector=${encodeURIComponent(text('nfsPodLabel'))}`, config.inventory.apiOrigin)
    return new Promise((resolve, reject) => {
      const req = httpsRequest(url, { ca, headers: { Authorization: `Bearer ${token}` }, timeout: config.inventory.requestTimeoutMs }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk)).on('end', () => {
          try {
            const items = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { items?: { metadata: { name: string; uid: string; deletionTimestamp?: string }; status?: { phase?: string } }[] }).items ?? []
            const live = items.filter(item => !item.metadata.deletionTimestamp && item.status?.phase === 'Running')
            if (res.statusCode !== 200 || live.length !== 1) { reject(new Error('REWAKE_NFS_POD')); return }
            resolve({ name: live[0].metadata.name, uid: live[0].metadata.uid })
          } catch { reject(new Error('REWAKE_NFS_POD')) }
        })
      })
      req.on('timeout', () => req.destroy(new Error('REWAKE_NFS_POD'))).on('error', reject)
      req.end()
    })
  }

  // Sessions that answered READY before, have no live attempt and hold input that waits for one.
  async function candidates() {
    return (await pool.query<{ unit_id: string; unit_revision: string; intent_revision: string; session_id: string; provider: 'codex' | 'claude';
      workspace_id: string; reserved_path: string; binding_id: string; binding_revision: string; binding_epoch: string; canonical_directory: string }>(`
      SELECT u.id AS unit_id,u.revision::text AS unit_revision,u.intent_revision::text,s.id AS session_id,g.provider,s.workspace_id,
        w.reserved_path,b.id AS binding_id,b.revision::text AS binding_revision,b.epoch::text AS binding_epoch,b.canonical_directory
      FROM durable_runtime.runtime_units u JOIN durable_runtime.runtime_members m ON m.runtime_unit_id=u.id
      JOIN durable_runtime.sessions s ON s.id=m.session_id AND s.lifecycle='OPEN' JOIN durable_runtime.agents g ON g.id=s.agent_id
      JOIN durable_runtime.catalog_workspace_metadata w ON w.workspace_id=s.workspace_id
      JOIN durable_runtime.runtime_member_storage_bindings mb ON mb.runtime_unit_id=u.id AND mb.session_id=s.id
      JOIN durable_runtime.storage_bindings b ON b.id=mb.storage_binding_id
      -- Accepted input that still waits is demand to run, even if fencing suspended the Unit after it arrived.
      WHERE u.desired_mode IN ('RUNNING','SUSPENDED') AND u.active_attempt_id IS NULL AND g.provider IN ('codex','claude')
        AND b.access_state='VERIFIED' AND b.writer_attempt_id IS NULL
        AND EXISTS(SELECT 1 FROM durable_runtime.attempts a WHERE a.runtime_unit_id=u.id AND a.ready_at IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM durable_runtime.attempts a WHERE a.runtime_unit_id=u.id AND a.stopped_at IS NULL)
        AND EXISTS(SELECT 1 FROM durable_runtime.messages x WHERE x.session_id=s.id AND x.intake_status='DURABLE' AND x.cancel_revision=0)
        AND NOT EXISTS(SELECT 1 FROM durable_runtime.operations o WHERE o.runtime_unit_id=u.id AND o.kind='WAKE' AND o.result IS NULL
          AND o.step<>'INTENT_QUEUED')
      ORDER BY u.id`)).rows
  }

  async function wake(candidate: Awaited<ReturnType<typeof candidates>>[number], controller: VerifiedControllerIdentity): Promise<void> {
    let row = candidate
    const ready = (await pool.query<{ native: string }>(`SELECT next_state->'providerRef'->>'nativeSessionRef' AS native
      FROM durable_runtime.runtime_audit_events WHERE session_id=$1 AND kind='INITIAL_PROVIDER_READY' ORDER BY occurred_at DESC LIMIT 1`,
    [row.session_id])).rows[0]
    const plan = (await pool.query<{ plan: unknown }>(`SELECT plan FROM durable_runtime.agent_pod_plans WHERE runtime_unit_id=$1
      ORDER BY recorded_at DESC LIMIT 1`, [row.unit_id])).rows[0]
    const original = (await pool.query<{ id: string; qualification: string; leaf: string }>(`SELECT id,next_state->>'qualificationRef' AS qualification,
      next_state->'observation'->>'leafId' AS leaf FROM durable_runtime.runtime_audit_events WHERE kind='STORAGE_DIRECTORY_OBSERVATION_PREPARED'
      AND next_state->'scope'->>'sessionId'=$1 AND next_state->'scope'->>'bindingId'=$2 ORDER BY occurred_at DESC LIMIT 1`,
    [row.session_id, row.binding_id])).rows[0]
    if (!ready?.native || !plan || !original?.qualification || !original.leaf) { throw new Error('REWAKE_SOURCE') }
    // External lookups first: a transient failure here leaves no wake operation behind.
    const nfs = await nfsPod()
    // A Unit fenced before epochs advanced on orphan reconciliation still has its
    // stopped attempt on the current epoch; the new attempt needs the next one.
    await runDurableTransaction(pool, async tx => {
      await lockAggregates(tx, { sessionIds: [logicalId('session', row.session_id)], runtimeUnitIds: [logicalId('runtime-unit', row.unit_id)] })
      await tx.query(`UPDATE durable_runtime.runtime_units u SET execution_epoch=execution_epoch+1,revision=revision+1
        WHERE u.id=$1 AND u.active_attempt_id IS NULL AND EXISTS(SELECT 1 FROM durable_runtime.attempts a
          WHERE a.runtime_unit_id=u.id AND a.execution_epoch=u.execution_epoch AND a.stopped_at IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM durable_runtime.attempts a WHERE a.runtime_unit_id=u.id AND a.stopped_at IS NULL)`, [row.unit_id])
    })
    const unitNow = (await pool.query<{ revision: string; intent_revision: string }>(
      'SELECT revision::text,intent_revision::text FROM durable_runtime.runtime_units WHERE id=$1', [row.unit_id])).rows[0]
    row = { ...row, unit_revision: unitNow.revision, intent_revision: unitNow.intent_revision }
    // The same Pod shape and binding as the Unit's last plan, under a new WAKE operation.
    const source = agentPodPlanSource(plan.plan)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: internal controller scope for this Unit's wake intent.
    const authority = Object.freeze({ principalId: actorId, runtimeUnitId: logicalId('runtime-unit', row.unit_id),
      scope: `rewake:runtime-unit:${row.unit_id}` }) as unknown as UnitIntentAuthority
    const intent = await requestUnitIntent(pool, { authority, operationKey: `rewake:${randomUUID()}`, desired: 'RUNNING',
      expectedRevision: counter('row:runtime-unit', row.unit_revision), expectedIntentRevision: counter('intent-revision', row.intent_revision),
      policy: lifecyclePolicy })
    if (intent.status !== 'COMMITTED') { throw new Error('REWAKE_INTENT') }
    const operationId = String((intent.receipt.response as { operationId?: unknown }).operationId)
    const op = (await pool.query<{ external_resource_name: string; execution_epoch: string; intent_revision: string; step: string }>(
      `SELECT external_resource_name,execution_epoch::text,intent_revision::text,step FROM durable_runtime.operations
       WHERE id=$1 AND runtime_unit_id=$2 AND kind='WAKE' AND result IS NULL`, [operationId, row.unit_id])).rows[0]
    if (!op || op.step !== 'INTENT_QUEUED') { throw new Error('REWAKE_OPERATION') }
    const request = source.request as { protectedBindings: unknown[]; profile: unknown }
    const descriptor = canonicalInput({ version: 'orca-first-managed-closed-bootstrap-v1', policy: source.policy,
      protectedBindings: request.protectedBindings, profile: request.profile } as never)
    const target = { ...request, identity: { unitId: row.unit_id, operationId, attemptId: randomUUID(), resourceName: op.external_resource_name,
      executionEpoch: op.execution_epoch, intentRevision: op.intent_revision, specHash: sha(descriptor) } }
    // This wake owns the unit while its operation is open, then through the attempt it reserves.
    if (!(await ownership.claim(row.unit_id, row.session_id, 'rewake', { operationId, attemptId: target.identity.attemptId }))) {
      await abandon(operationId, 'REWAKE_UNIT_OWNED', controller)
      throw new Error('REWAKE_UNIT_OWNED')
    }
    // Exact bytes the binding was verified with: the namespace profile plus this leaf's qualification.
    const profileBytes = `${JSON.stringify({ ...baseProfile, qualificationRef: original.qualification, leafId: original.leaf }, null, 2)}\n`
    const dir = join(stateDirectory, row.session_id, operationId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const write = (name: string, value: unknown) => { const path = join(dir, name)
      writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); return path }
    const collector = { ...(baseTarget.get('collector') as Record<string, unknown>), podName: nfs.name, podUid: nfs.uid }
    const targetFile = write('target.json', { policy: source.policy, request: target, policyRevision: baseTarget.get('policyRevision'),
      sessionId: row.session_id, actorId, originalAuditId: original.id, pinId: randomUUID(),
      binding: { bindingId: row.binding_id, expectedRevision: row.binding_revision, storageEpoch: row.binding_epoch },
      executorId: baseTarget.get('executorId'), ownerTokenFile: write('initial-owner-token', randomBytes(32).toString('hex')),
      acceptedProfileFile: write('accepted-profile.json', profileBytes), expectedProfileDigest: sha(profileBytes),
      podTokenFile: baseTarget.get('podTokenFile'), podTimeoutMs: baseTarget.get('podTimeoutMs'), credential: baseTarget.get('credential'), collector })
    const spool = join(dir, 'terminal-output'); mkdirSync(spool, { mode: 0o700 })
    const nativeFiles = row.provider === 'claude' ? claude : codex
    const coldFile = write('cold.json', { emptyFolderFile: write('empty-folder.json', { kind: 'FRESH_EMPTY_FOLDER', workspaceId: row.workspace_id,
      canonicalDirectory: row.canonical_directory, checkout: '/agent/checkout', sourceCheckout: row.reserved_path }),
    ...nativeFiles, controlArtifactFile: text('controlArtifactFile'), controlSha256: text('controlSha256'),
    runtimeServiceAccountName: 'orca-runtime-agent', runtimeServiceAccountUid: text('runtimeServiceAccountUid'), originalAuditId: original.id,
    pinId: randomUUID(), ownerTokenFile: write('cold-owner-token', randomBytes(32).toString('hex')), actorId,
    clusterIdentityRef: text('clusterIdentityRef'), projectId: text('projectId'), projectNumber: text('projectNumber'),
    outputSpoolDirectory: spool, creationWindow: 'AUTHENTICATED_NODE', timeoutMs })
    const { rewake: _rewake, ...rest } = config
    const dispatch = prepareOrcadFirstManagedInitial({ ...rest, firstManagedInitial: { configFile: targetFile, coldConfigFile: coldFile } },
      pool, ca, undefined, readSettings, { nativeSessionRef: ready.native, creationObserver: observer })
    if (!dispatch) { throw new Error('REWAKE_DISPATCH') }
    entries.set(operationId, { sessionId: row.session_id, unitId: row.unit_id, operationId, dispatch, error: null })
    started++
  }

  const busy = () => [...entries.values()].some(entry => {
    const status = entry.dispatch.snapshot()
    return status.status !== 'FAILED' && !status.providerReady
  })
  const byOperation = (operationId: string) => entries.get(operationId)?.dispatch

  return Object.freeze({
    /** Controller pass hook: queue at most one new wake per pass. */
    async wakePending(signal: AbortSignal): Promise<number> {
      if (signal.aborted) { return 0 }
      await settleOwnerless(signal, controller)
      if (busy()) { return 0 }
      for (const row of await candidates()) {
        const failure = failures.get(row.session_id)
        // A candidate has no live attempt, so no other owner (e.g. the first-managed target) can serve it now.
        if ((failure && (failure.count >= MAX_WAKES || Date.now() < failure.nextAt)) ||
            [...entries.values()].some(entry => entry.sessionId === row.session_id && entry.dispatch.snapshot().providerReady)) { continue }
        try { await wake(row, controller); return 1 }
        catch (error) {
          lastError = error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'REWAKE_FAILED'
          failures.set(row.session_id, { count: (failure?.count ?? 0) + 1, nextAt: Date.now() + RETRY_MS })
          return 0
        }
      }
      return 0
    },
    // Each wake executes once: a dispatch that already ran is never planned again (no second claim).
    planStep: ((operation, unit) => {
      const dispatch = byOperation(operation.id)
      return dispatch && dispatch.snapshot().status === 'IDLE' ? dispatch.planStep(operation, unit) : null
    }) satisfies NonNullable<ControllerPassRequest['planStep']>,
    executeCommitted: (async (claim, signal, context) => {
      const dispatch = byOperation(context.operationId)
      if (!dispatch) { return deny() }
      await dispatch.executeCommitted(claim, signal, context)
    }) satisfies NonNullable<ControllerPassRequest['executeCommitted']>,
    lookupOriginal: (async (command, signal, context) => {
      const dispatch = byOperation(command.operation_id)
      if (!dispatch) { return deny() }
      await dispatch.lookupOriginal(command, signal, context)
    }) satisfies NonNullable<ControllerPassRequest['lookupOriginal']>,
    ownsOperation: (operationId: string) => entries.has(operationId),
    onTerminalInputCommitted: ((input) => {
      for (const entry of entries.values()) { if (entry.sessionId === input.authority.sessionId) { entry.dispatch.onTerminalInputCommitted?.(input) } }
    }) satisfies TerminalInputCommittedSink,
    snapshot: () => Object.freeze({ started, active: entries.size, lastError: lastError ? `${lastError}:${abandoned}`.slice(0, 160) : null,
      last: [...entries.values()].at(-1)?.dispatch.snapshot() ?? null }),
    async close(): Promise<void> { for (const entry of entries.values()) { await entry.dispatch.close().catch(() => undefined) } },
  })
}
