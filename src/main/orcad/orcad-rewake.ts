import { captureRewakeCodexAuthSources, rewakeNativeFiles } from './orcad-rewake-auth.ts'
import { certifiedNativeSessionRef } from '../durable-runtime/runtime/native-session-certification.ts'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { join } from 'node:path'
import type { Pool } from 'pg'
import type { ControllerPassRequest } from '../durable-runtime/ha/pass.ts'
import { CLOSED_AGENT_BOOTSTRAP } from '../durable-runtime/runtime/closed-agent-bootstrap.ts'
import { claimRewakeOperation, settleRewakeOperation } from '../durable-runtime/lifecycle/rewake-retry.ts'
import type { RewakeOperationClaim } from '../durable-runtime/lifecycle/rewake-retry.ts'
import { claimOwnerlessWakeRetirement } from '../durable-runtime/runtime/ownerless-wake-retirement.ts'
import type { VerifiedControllerIdentity } from '../durable-runtime/runtime/gateway/types.ts'
import { retireAgentPod } from '../durable-runtime/runtime/agent-pod-retirement.ts'
import { agentPodPlanSource } from '../durable-runtime/runtime/agent-pod-plan-records.ts'
import { agentPodFields, agentPodInteger, agentPodText } from '../durable-runtime/runtime/agent-pod-policy.ts'
import { logicalId, counter } from '../../shared/durable-runtime/identity.ts'
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
type Native = Readonly<{ nativeArtifactFile: string; nativeSha256: string; nativeByteLength: number; nativeDistributionFile?:string }>

/** Starts a new Agent Pod for a READY-before Session whose Pod is gone (orphan
 * reconciled) once its input waits: a new WAKE operation, the same Pod shape and
 * binding, and the same native session resumed. Each wake runs through the
 * original first-managed attempt/grant/protection path, so one writer holds the
 * protected leaf at a time. One wake runs at a time in this process. */
export function prepareOrcadRewake(pool: Pool, config: OrcadControllerConfig, readSettings: () => InitialCodexNativeSettings,
  ownership: UnitOwnership) {
  const file = config.rewake?.configFile
  if (!file) { return null }
  const parsed = parseUniqueOrcadControllerJson(readPrivateOrcadControllerConfigBytes(file).toString('utf8'))
  const hasStorageTargets=parsed!==null&&typeof parsed==='object'&&Object.hasOwn(parsed,'storageTargets')
  const raw = agentPodFields(parsed,
    ['baseTargetFile', 'baseProfileFile', ...(parsed!==null&&typeof parsed==='object'&&Object.hasOwn(parsed,'codexAuthSources')?['codexAuthSources']:[]), ...(hasStorageTargets?['storageTargets']:[]), 'controlArtifactFile', 'controlSha256', 'codex', 'claude', 'runtimeServiceAccountUid',
      'clusterIdentityRef', 'projectId', 'projectNumber', 'stateDirectory', 'timeoutMs', 'nfsPodLabel', 'lifecyclePolicy'])
  const text = (key: string) => agentPodText(raw.get(key))
  const native = (key: 'codex' | 'claude'): Native & Record<string, unknown> => {
    const value=raw.get(key),distribution=value!==null&&typeof value==='object'&&Object.hasOwn(value,'nativeDistributionFile')
    const n = agentPodFields(value, ['nativeArtifactFile', 'nativeSha256', 'nativeByteLength', ...(distribution?['nativeDistributionFile']:[]), key === 'codex' ? 'codexAuthFile' : 'claudeTokenFile'])
    return Object.freeze({ nativeArtifactFile: agentPodText(n.get('nativeArtifactFile')), nativeSha256: agentPodText(n.get('nativeSha256')),
      nativeByteLength: agentPodInteger(n.get('nativeByteLength')),
      ...(distribution?{nativeDistributionFile:agentPodText(n.get('nativeDistributionFile'))}:{}),
      ...(key === 'codex' ? { codexAuthFile: agentPodText(n.get('codexAuthFile')) } : { provider: 'claude', claudeTokenFile: agentPodText(n.get('claudeTokenFile')) }) })
  }
  const codex = native('codex'), claude = native('claude')
  const codexAuthSources = captureRewakeCodexAuthSources(raw.get('codexAuthSources'))
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
  const entries = new Map<string, Entry>()
  let lastError: string | null = null, started = 0, abandoned = 0
  const describe = (entry: Entry): string => {
    const s = entry.dispatch.snapshot()
    return [s.errorCode, s.executionErrorCode, s.preparationErrorCode, s.reservationCode, s.target?.errorCode, s.assignment?.errorCode, s.coldFailure]
      .filter(code => !!code).join(':').replace(/[^A-Z0-9_:]/g, '_').slice(0, 150) || 'REWAKE_FAILED'
  }

  /** PG owns new claims; old private directories are discovery hints only for
   * importing operations created before durable recovery metadata existed. */
  async function settleOwnerless(signal: AbortSignal, controller: VerifiedControllerIdentity): Promise<void> {
    const legacy = existsSync(stateDirectory) ? new Set(readdirSync(stateDirectory).flatMap(session => {
      try { return readdirSync(join(stateDirectory, session)) } catch { return [] }
    })) : new Set<string>()
    const open = (await pool.query<{id:string;runtime_unit_id:string;recovery_root_id:string|null;
      retry_owner:string|null;retry_owner_term:string|null;expired:boolean}>(`SELECT o.id,o.runtime_unit_id,o.recovery_root_id,
      o.retry_owner,o.retry_owner_term,o.deadline_at<=clock_timestamp() AS expired FROM durable_runtime.operations o
      WHERE o.kind='WAKE' AND o.retry_accounted_at IS NULL AND ((o.recovery_root_id IS NOT NULL AND o.retry_claimed_at IS NOT NULL)
        OR (o.recovery_root_id IS NULL AND (o.result IS NULL OR EXISTS(SELECT 1 FROM durable_runtime.runtime_commands c
          WHERE c.operation_id=o.id AND c.state IN ('ACCEPTED','EXECUTING')))))`)).rows
    for (const op of open) {
      if(signal.aborted) {break}
      const entry = entries.get(op.id)
      if(!op.recovery_root_id) {
        if(!legacy.has(op.id)) {continue}
        await claimRewakeOperation(pool,controller,op.runtime_unit_id,lifecyclePolicy)
      } else if(!entry && op.retry_owner===controller.owner && op.retry_owner_term===controller.term && !op.expired) {
        // An overlapping invocation of THIS current owner may still be preparing.
        continue
      }
      const state=entry?.dispatch.snapshot()
      if(entry && !state?.providerReady && state?.status!=='FAILED' && !op.expired) {continue}
      if(entry && state?.status==='FAILED' && !op.expired) {
        const live=(await pool.query(`SELECT a.id FROM durable_runtime.attempts a
          JOIN durable_runtime.agent_pod_plans p ON p.attempt_id=a.id WHERE p.operation_id=$1 AND a.stopped_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM durable_runtime.runtime_audit_events e WHERE e.attempt_id=a.id
            AND e.kind IN ('PROVIDER_CHILD_EXIT_OBSERVED','AGENT_CONTAINER_EXIT_OBSERVED'))`,[op.id])).rowCount
        // A transport fault is not process death. Keep bridge reconnect/adoption
        // and original finite deadline; only authenticated exit facts retire early.
        if(live) {continue}
      }
      const reason=op.expired?'WAKE_DEADLINE_EXHAUSTED':entry?describe(entry):'REWAKE_OWNER_LOST'
      if(!state?.providerReady) {
        const attempt=await claimOwnerlessWakeRetirement(pool,controller,op.id)
        if(attempt && !signal.aborted) {
          const reviewer=readOrcadControllerCredential(config.inventory.tokenFile,'TOKEN').toString('utf8').trim()
          const retired=await retireAgentPod({apiOrigin:config.inventory.apiOrigin,namespace:config.inventory.namespace,ca,reviewer},
            attempt,AbortSignal.any([signal,AbortSignal.timeout(config.inventory.requestTimeoutMs)]))
          if(retired==='CONFLICT'||retired==='UNKNOWN') {lastError=`REWAKE_RETIRE_${retired}`}
        }
      }
      if(await settleRewakeOperation(pool,controller,op.id,reason)) {
        if(entry && !state?.providerReady) {entries.delete(op.id);ownership.release(entry.unitId,'rewake')}
        if(!state?.providerReady) {abandoned++;lastError=reason}
      }
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

  // Both first starts and later losses use the same durable operation claim.
  async function candidates() {
    return (await pool.query<{ unit_id: string; unit_revision: string; intent_revision: string; session_id: string; provider: 'codex' | 'claude';
      agent_id: string; workspace_id: string; reserved_path: string; binding_id: string; binding_revision: string; binding_epoch: string; canonical_directory: string }>(`
      SELECT u.id AS unit_id,u.revision::text AS unit_revision,u.intent_revision::text,s.id AS session_id,g.provider,g.id AS agent_id,s.workspace_id,
        w.reserved_path,b.id AS binding_id,b.revision::text AS binding_revision,b.epoch::text AS binding_epoch,b.canonical_directory
      FROM durable_runtime.runtime_units u JOIN durable_runtime.runtime_members m ON m.runtime_unit_id=u.id
      JOIN durable_runtime.sessions s ON s.id=m.session_id AND s.lifecycle='OPEN' JOIN durable_runtime.agents g ON g.id=s.agent_id
      JOIN durable_runtime.catalog_workspace_metadata w ON w.workspace_id=s.workspace_id
      JOIN durable_runtime.runtime_member_storage_bindings mb ON mb.runtime_unit_id=u.id AND mb.session_id=s.id
      JOIN durable_runtime.storage_bindings b ON b.id=mb.storage_binding_id
      -- Accepted input that still waits is demand to run, even if fencing suspended the Unit after it arrived.
      WHERE u.desired_mode IN ('RUNNING','SUSPENDED') AND u.active_attempt_id IS NULL AND g.provider IN ('codex','claude')
        AND b.access_state IN ('UNVERIFIED','VERIFIED') AND b.writer_attempt_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM durable_runtime.attempts a WHERE a.runtime_unit_id=u.id AND a.stopped_at IS NULL)
        AND EXISTS(SELECT 1 FROM durable_runtime.messages x WHERE x.session_id=s.id AND x.intake_status='DURABLE' AND x.cancel_revision=0)
        AND NOT EXISTS(SELECT 1 FROM durable_runtime.operations o WHERE o.runtime_unit_id=u.id AND o.kind='WAKE' AND o.result IS NULL
          AND o.step<>'INTENT_QUEUED')
        AND NOT EXISTS(SELECT 1 FROM durable_runtime.operations r WHERE r.runtime_unit_id=u.id AND r.recovery_root_id=r.id
          AND r.recovery_anchor_attempt_id IS NOT DISTINCT FROM (SELECT a.id FROM durable_runtime.attempts a WHERE a.runtime_unit_id=u.id AND a.ready_at IS NOT NULL
            ORDER BY a.execution_epoch DESC,a.ready_at DESC,a.id LIMIT 1)
          AND (r.retry_exhausted_reason IS NOT NULL OR (r.retry_at>clock_timestamp() AND r.deadline_at>clock_timestamp())))
      ORDER BY u.id`)).rows
  }

  async function wake(row: Awaited<ReturnType<typeof candidates>>[number], controller: VerifiedControllerIdentity, claim: RewakeOperationClaim): Promise<void> {
    const observations = await pool.query<{kind:string;next_state:unknown}>(`SELECT kind,next_state
      FROM durable_runtime.runtime_audit_events WHERE session_id=$1
      AND kind IN ('INITIAL_PROVIDER_READY','INITIAL_PROVIDER_NATIVE_OBSERVED') ORDER BY occurred_at DESC`, [row.session_id])
    const ready = observations.rows.map(event => ({native:certifiedNativeSessionRef(row.provider,event.kind,event.next_state)})).find(event => event.native)
    const plan = (await pool.query<{ plan: unknown }>(`SELECT plan FROM durable_runtime.agent_pod_plans WHERE runtime_unit_id=$1
      ORDER BY recorded_at DESC LIMIT 1`, [row.unit_id])).rows[0]
    let original = (await pool.query<{ id: string; qualification: string; leaf: string }>(`SELECT id,next_state->>'qualificationRef' AS qualification,
      next_state->'observation'->>'leafId' AS leaf FROM durable_runtime.runtime_audit_events WHERE kind='STORAGE_DIRECTORY_OBSERVATION_PREPARED'
      AND next_state->'scope'->>'sessionId'=$1 AND next_state->'scope'->>'bindingId'=$2 ORDER BY occurred_at DESC LIMIT 1`,
    [row.session_id, row.binding_id])).rows[0]
    const configured = raw.get('storageTargets')
    if(configured!==undefined && !Array.isArray(configured)) {throw new Error('REWAKE_STORAGE_CONFIG')}
    const selected = configured?.find((item: {canonicalDirectory?:string})=>item.canonicalDirectory===row.canonical_directory)
    const deploymentTarget = selected ? agentPodFields(parseUniqueOrcadControllerJson(readPrivateOrcadControllerConfigBytes(agentPodText(selected.baseTargetFile)).toString('utf8')),
      [...baseTarget.keys()]) : baseTarget
    const deploymentProfile = selected ? JSON.parse(readPrivateOrcadControllerConfigBytes(agentPodText(selected.baseProfileFile)).toString('utf8')) as Record<string,unknown> : baseProfile
    const prototype = plan ? agentPodPlanSource(plan.plan) : {policy:deploymentTarget.get('policy'),request:deploymentTarget.get('request') as Record<string,unknown>}
    const templateRequest = prototype.request as {protectedBindings:Record<string,unknown>[];profile:unknown}
    const leaf = original?.leaf ?? agentPodText(deploymentProfile.leafId)
    if(row.canonical_directory!==`/${config.inventory.dataset}/${leaf}`) {throw new Error('REWAKE_STORAGE_UNCONFIGURED')}
    const configuredBinding = templateRequest.protectedBindings[0]
    if(!configuredBinding || configuredBinding.leafId!==leaf) {throw new Error('REWAKE_STORAGE_UNCONFIGURED')}

    // The durable operation/budget claim precedes this external lookup.
    const nfs = await nfsPod()
    const source = plan ? prototype : {...prototype,policy:{...(prototype.policy as Record<string,unknown>),entrypoint:{command:CLOSED_AGENT_BOOTSTRAP.command,args:CLOSED_AGENT_BOOTSTRAP.args}}}
    const operationId=claim.operationId
    const op={external_resource_name:claim.resourceName,execution_epoch:claim.executionEpoch,intent_revision:claim.intentRevision}
    const request = { ...templateRequest, protectedBindings: templateRequest.protectedBindings.map(b=>({...b,bindingId:row.binding_id})) }
    const descriptor = canonicalInput({ version: 'orca-first-managed-closed-bootstrap-v1', policy: source.policy,
      protectedBindings: request.protectedBindings, profile: request.profile } as never)
    const target = { ...request, identity: { unitId: row.unit_id, operationId, attemptId: randomUUID(), resourceName: op.external_resource_name,
      executionEpoch: op.execution_epoch, intentRevision: op.intent_revision, specHash: sha(descriptor) } }
    // This wake owns the unit while its operation is open, then through the attempt it reserves.
    if (!(await ownership.claim(row.unit_id, row.session_id, 'rewake', { operationId, attemptId: target.identity.attemptId }))) {
      throw new Error('REWAKE_UNIT_OWNED')
    }
    // Exact bytes the binding was verified with: the namespace profile plus this leaf's qualification.
    const profileBytes = `${JSON.stringify({ ...deploymentProfile, qualificationRef: original?.qualification ?? deploymentProfile.qualificationRef, leafId: leaf }, null, 2)}\n`
    const dir = join(stateDirectory, row.session_id, operationId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const write = (name: string, value: unknown) => { const path = join(dir, name)
      writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); return path }
    const collector = { ...(deploymentTarget.get('collector') as Record<string, unknown>), podName: nfs.name, podUid: nfs.uid }
    const targetFile = write('target-prepared.json', { policy: source.policy, request: target, policyRevision: baseTarget.get('policyRevision'),
      sessionId: row.session_id, actorId, originalAuditId: original?.id ?? randomUUID(), pinId: randomUUID(),
      binding: { bindingId: row.binding_id, expectedRevision: row.binding_revision, storageEpoch: row.binding_epoch },
      executorId: baseTarget.get('executorId'), ownerTokenFile: write('initial-owner-token', randomBytes(32).toString('hex')),
      acceptedProfileFile: write('accepted-profile.json', profileBytes), expectedProfileDigest: sha(profileBytes),
      podTokenFile: baseTarget.get('podTokenFile'), podTimeoutMs: baseTarget.get('podTimeoutMs'), credential: baseTarget.get('credential'), collector })
    const spool = join(dir, 'terminal-output'); mkdirSync(spool, { mode: 0o700 })
    const nativeFiles = rewakeNativeFiles(row.provider, row.agent_id, row.provider === 'claude' ? claude : codex, codexAuthSources)
    const coldFile = write('cold.json', { emptyFolderFile: write('empty-folder.json', { kind: 'FRESH_EMPTY_FOLDER', workspaceId: row.workspace_id,
      canonicalDirectory: row.canonical_directory, checkout: '/agent/checkout', sourceCheckout: row.reserved_path }),
    ...nativeFiles, controlArtifactFile: text('controlArtifactFile'), controlSha256: text('controlSha256'),
    runtimeServiceAccountName: 'orca-runtime-agent', runtimeServiceAccountUid: text('runtimeServiceAccountUid'), originalAuditId: original?.id ?? randomUUID(),
    pinId: randomUUID(), ownerTokenFile: write('cold-owner-token', randomBytes(32).toString('hex')), actorId,
    clusterIdentityRef: text('clusterIdentityRef'), projectId: text('projectId'), projectNumber: text('projectNumber'),
    outputSpoolDirectory: spool, creationWindow: 'AUTHENTICATED_NODE', timeoutMs })
    const { rewake: _rewake, ...rest } = config
    const reuseProfile = !!(await pool.query('SELECT 1 FROM durable_runtime.resource_profiles WHERE runtime_unit_id=$1',[row.unit_id])).rowCount
    const existingCheckout = !!plan || !!(await pool.query('SELECT 1 FROM durable_runtime.storage_write_grants WHERE storage_binding_id=$1 LIMIT 1',[row.binding_id])).rowCount
    const options = { recoverNative:!!plan&&!ready?.native, ...(ready?.native ? {nativeSessionRef:ready.native} : {}), reuseProfile, existingCheckout,
      creationObserver: 'AUTHENTICATED_KUBERNETES_NODE' as const }
    let dispatch = prepareOrcadFirstManagedInitial({ ...rest, firstManagedInitial: { configFile: targetFile, coldConfigFile: coldFile } },
      pool, ca, undefined, readSettings, options)
    if (!dispatch) { throw new Error('REWAKE_DISPATCH') }
    const bindingProof=(await pool.query<{identity_proof_ref:string|null}>('SELECT identity_proof_ref FROM durable_runtime.storage_bindings WHERE id=$1',[row.binding_id])).rows[0]
    const ownProof=original?(await pool.query<{ref:string}>("SELECT next_state->>'evidenceRef' AS ref FROM durable_runtime.runtime_audit_events WHERE id=$1",[original.id])).rows[0]?.ref:null
    if(!original || ownProof!==bindingProof.identity_proof_ref) {
      const current=(await pool.query<{revision:string}>('SELECT revision::text FROM durable_runtime.runtime_units WHERE id=$1',[row.unit_id])).rows[0]
      const verified=await dispatch.verifyFirstBinding({sessionId:logicalId('session',row.session_id),unitId:logicalId('runtime-unit',row.unit_id),bindingId:logicalId('storage-binding',row.binding_id),
        expectedUnitRevision:counter('row:runtime-unit',current.revision),expectedBindingRevision:counter('row:storage-binding',row.binding_revision),actorId,pinId:randomUUID(),
        ownerToken:randomBytes(32).toString('hex'),leafId:leaf,refreshStopped:true},new AbortController().signal)
      if(verified.outcome!=='VERIFIED' || !verified.audit?.ok) {throw new Error(verified.errorCode??'INITIAL_BINDING_UNCONFIRMED')}
      original={id:verified.audit.value.auditId,qualification:verified.qualificationRef,leaf}
      const binding=(await pool.query<{revision:string}>('SELECT revision::text FROM durable_runtime.storage_bindings WHERE id=$1',[row.binding_id])).rows[0]
      const finalTarget=JSON.parse(readPrivateOrcadControllerConfigBytes(targetFile).toString('utf8'))
      finalTarget.originalAuditId=original.id;finalTarget.binding.expectedRevision=binding.revision
      const finalCold=JSON.parse(readPrivateOrcadControllerConfigBytes(coldFile).toString('utf8'));finalCold.originalAuditId=original.id
      dispatch=prepareOrcadFirstManagedInitial({...rest,firstManagedInitial:{configFile:write('target.json',finalTarget),coldConfigFile:write('cold-final.json',finalCold)}},pool,ca,undefined,readSettings,options)
      if(!dispatch) {throw new Error('REWAKE_DISPATCH')}
    }
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
    async wakePending(signal: AbortSignal, controller: VerifiedControllerIdentity): Promise<number> {
      if (signal.aborted) { return 0 }
      await settleOwnerless(signal, controller)
      for(const [id,entry] of entries) {
        const stopped=(await pool.query(`SELECT 1 FROM durable_runtime.attempts a JOIN durable_runtime.agent_pod_plans p ON p.attempt_id=a.id
          WHERE p.operation_id=$1 AND a.stopped_at IS NOT NULL`,[id])).rowCount
        if(stopped) {await entry.dispatch.close().catch(()=>undefined);entries.delete(id);ownership.release(entry.unitId,'rewake')}
      }
      if (busy()) { return 0 }
      for (const row of await candidates()) {
        // A candidate has no live attempt, so no other owner (e.g. the first-managed target) can serve it now.
        // This candidate has no live writer. A READY cache from an earlier
        // stopped attempt cannot suppress the next independent recovery incident.
        for(const [id,entry] of entries) {
          if(entry.unitId===row.unit_id && entry.dispatch.snapshot().providerReady) {
            await entry.dispatch.close().catch(()=>undefined);entries.delete(id);ownership.release(entry.unitId,'rewake')
          }
        }
        const claim=await claimRewakeOperation(pool,controller,row.unit_id,lifecyclePolicy)
        if(!claim) {continue}
        try { await wake(row, controller, claim); return 1 }
        catch (error) {
          lastError = error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'REWAKE_FAILED'
          await settleRewakeOperation(pool,controller,claim.operationId,lastError)
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
