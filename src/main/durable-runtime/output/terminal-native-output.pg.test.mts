import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host.ts'
import { registerEventProducer, enqueueRuntimeEvent, claimRuntimeEvent, processRuntimeEvent } from '../events/store.ts'
import type { VerifiedWorkloadIdentity } from '../runtime/runtime-evidence.ts'
import type { EventProducer } from '../events/types.ts'
import { terminalCodexPayload, terminalCodexOutputEventHandler } from './terminal-codex-event.ts'
import { readManagedTerminalNativeChat } from './terminal-native-read.ts'
import { bindManagedTerminalNativeChatMethods } from '../rpc/terminal-native-chat.ts'
import { captureDurableCatalogReadConfig } from '../rpc/config.ts'
import { appendAudit } from '../journal/store.ts'
import { defineMethod, defineStreamingMethod, type RpcContext } from '../../runtime/rpc/core.ts'
import { NativeChatSession } from '../../../shared/rpc-contract/native-chat-params.ts'
import { createTerminalCodexOutput } from './terminal-codex-output.ts'
import type { ReadyProviderBinding } from '../providers/shared/contracts.ts'
import type { GatewayContext } from '../runtime/gateway/types.ts'

// Real PG transactions with synthetic provider/workload/lease controls only.
// This test issues no production authority and launches no provider/Pod.
test('Terminal raw output COMMIT/dedup/authenticated nativeChat frames and closed history', {concurrency: false}, async () => {
  assert.equal(process.env.PGDATABASE, 'orca_ops_resources_20261017')
  const pool = createDurablePool({max: 4, application_name: 'terminal-output-owned-first', statement_timeout: 15000})
  const id = randomUUID(), owner = `terminal-output:${id}`, agent = logicalId('agent', randomUUID())
  const session = logicalId('session', randomUUID()), unit = logicalId('runtime-unit', randomUUID())
  const workspace = logicalId('workspace', randomUUID()), attempt = logicalId('attempt', randomUUID())
  const tab = logicalId('tab', randomUUID()), storage = randomUUID(), operation = logicalId('operation', randomUUID())
  const pod = `synthetic-pod:${id}`, incarnation = `synthetic-incarnation:${id}`, producerId = logicalId('producer', randomUUID())
  const authority = {scope: owner, owner, term: counter('controller-term', '1')}
  const binding = {sessionId: session, tabId: tab, terminalHandle: owner, providerBindingRevision: '1',
    runtimeUnitId: unit, attemptId: attempt, podUid: pod, executionEpoch: '1', connectionInstanceId: owner,
    providerRef: {provider: 'codex', nativeSessionRef: `synthetic-thread:${id}`}} as ReadyProviderBinding
  const workload = {attemptId: attempt, producerId, incarnation, podUid: pod, executionEpoch: '1',
    principalRef: owner, authenticationEvidenceRef: owner} as VerifiedWorkloadIdentity
  const producer: EventProducer = {workload, agentId: agent, runtimeUnitId: unit}
  const config = captureDurableCatalogReadConfig({pool, datasetName: 'orca-1012-dev-v1', hostId: LOCAL_EXECUTION_HOST_ID,
    readHostIdentity: () => LOCAL_EXECUTION_HOST_ID, repositoryIds: [], projectGroupIds: [owner], workspacePublicIds: [], pollIntervalMs: 20})
  const cleanups = new Map<string, () => void>()
  const context = {authenticatedCallerFingerprint: 'f'.repeat(64), clientKind: 'mobile', connectionId: owner,
    runtime: {registerSubscriptionCleanup(token: string, callback: () => void) {cleanups.get(token)?.(); cleanups.set(token, callback)},
      cleanupSubscription(token: string) {const fn = cleanups.get(token); cleanups.delete(token); fn?.()}}} as unknown as RpcContext
  const params = {agent: 'codex', sessionId: session, subscriptionId: owner, limit: 40}
  const notification = (sequence: string, text: string) => ({connectionId: owner, sequence, method: 'item/completed',
    observedAt: '2026-10-17T04:00:00.000Z', params: {threadId: binding.providerRef.nativeSessionRef,
      turnId: `synthetic-turn:${sequence}`, item: {id: `synthetic-item:${sequence}`, type: 'agentMessage', text}}})
  try {
    const identity = (await pool.query(`SELECT (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
      (SELECT system_identifier::text FROM pg_control_system()) AS system`)).rows[0]
    assert.equal(identity.oid, '98744'); assert.equal(identity.system, '7696101282789175327')
    await withDurableTransaction(pool, async tx => {
      await tx.query(`INSERT INTO durable_runtime.agents(id,provider,dataset_name) VALUES($1,'codex','orca-1012-dev-v1')`, [agent])
      await tx.query(`INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state,dataset_name)
        VALUES($1,$2,$2,'READY','orca-1012-dev-v1')`, [workspace, owner])
      await tx.query(`INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase,execution_epoch) VALUES($1,'SUSPENDED','ABSENT',1)`, [unit])
      await tx.query(`INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision,updated_at)
        VALUES($1,0,'{}',0,clock_timestamp())`, [unit])
      await tx.query(`INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,resource_profile_revision,effective_resources,status)
        VALUES($1,$2,1,'COLD',$3,$4,0,'{}','STOPPED')`, [attempt, unit, pod, incarnation])
      await tx.query(`INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2)`, [storage, owner])
      await tx.query(`INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state)
        VALUES($1,$2,$3,$4,'RO')`, [storage, storage, owner, `/synthetic/${id}`])
      await tx.query(`INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')`, [session, agent, workspace])
      await tx.query(`INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)`, [unit, session, storage])
      await tx.query(`INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at)
        VALUES($1,$1,1,clock_timestamp()+interval '10 minutes')`, [owner])
      await tx.query(`INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)`, [owner, {id: owner,
        name: owner, createdFrom: 'manual', parentPath: null, parentGroupId: null, color: null,
        tabOrder: 0, createdAt: 0, updatedAt: 0, isCollapsed: false}])
      await tx.query(`INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,project_group_id,reserved_path,payload,create_request)
        VALUES($1,'FOLDER_WORKSPACE',$2,$3,$4,'{}')`, [workspace, owner, `/synthetic/${id}`, {id: owner,
        projectGroupId: owner, name: owner, folderPath: `/synthetic/${id}`, comment: '', createdAt: 0, updatedAt: 0,
        lastActivityAt: 0, sortOrder: 0, isArchived: false, isUnread: false, isPinned: false}])
      await tx.query(`INSERT INTO durable_runtime.tabs(id,workspace_id,session_id,kind,terminal_handle,ui_order,lifecycle)
        VALUES($1,$2,$3,'terminal',$4,0,'OPEN')`, [tab, workspace, session, owner])
      await tx.query(`INSERT INTO durable_runtime.catalog_tab_metadata(tab_id,public_tab_id,payload,launch_request)
        VALUES($1,$2,$3,'{}')`, [tab, owner, {id: owner, type: 'terminal', title: owner, isActive: true,
          parentTabId: owner, leafId: owner, status: 'ready', terminal: owner, viewMode: 'chat'}])
      await appendAudit(tx, {actorId: owner, runtimeUnitId: unit, sessionId: session, kind: 'INITIAL_PROVIDER_READY',
        nextState: {kind: 'INITIAL_PROVIDER_READY', attemptId: attempt, podUid: pod, executionEpoch: '1',
          providerBindingRevision: '1', connectionInstanceId: owner, providerRef: {provider: 'codex', nativeSessionRef: binding.providerRef.nativeSessionRef}},
        occurredAt: new Date(), receivedAt: new Date(), producerId, producerSeq: counter('sequence:producer', '1'), evidenceRefs: []})
    })
    await registerEventProducer(pool, producer)
    const raw = notification('1', 'synthetic 原 payload α'), eventId = logicalId('event', randomUUID())
    const queued = {eventId, sequence: counter('sequence:producer', '1'), payload: terminalCodexPayload(binding, raw), targetSessionIds: [session]}
    assert.equal((await enqueueRuntimeEvent(pool, producer, queued)).status, 'COMMITTED')
    assert.equal((await enqueueRuntimeEvent(pool, producer, queued)).status, 'REPLAYED')
    const claim = await claimRuntimeEvent(pool, {producerId, incarnation: workload.incarnation}, authority, {claimDurationMs: 30000})
    assert.equal(claim.status, 'CLAIMED'); if (claim.status !== 'CLAIMED') { throw new Error('CLAIM') }
    const processed = await processRuntimeEvent(pool, claim.claim, async (tx, record) => {
      await terminalCodexOutputEventHandler(tx, record)
      const invisible = await readManagedTerminalNativeChat(config, params, context)
      assert.equal(invisible?.kind, 'PAGE'); if (invisible?.kind === 'PAGE') { assert.equal(invisible.messages.length, 0) }
    })
    assert.equal(processed.status, 'DONE')
    const page = await readManagedTerminalNativeChat(config, params, context)
    assert.equal(page?.kind, 'PAGE'); if (page?.kind !== 'PAGE') { throw new Error('PAGE') }
    assert.deepEqual(page.messages[0].blocks, [{type: 'text', text: 'synthetic 原 payload α'}])
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM durable_runtime.session_events
      WHERE session_id=$1 AND body->>'kind'='TERMINAL_CODEX_NOTIFICATION'`, [session])).rows[0].n, 1)
    await assert.rejects(readManagedTerminalNativeChat(config, params, {...context, authenticatedCallerFingerprint: undefined}), /AUTHENTICATED/)
    const denied = captureDurableCatalogReadConfig({...config, readHostIdentity: () => LOCAL_EXECUTION_HOST_ID, projectGroupIds: []})
    await assert.rejects(readManagedTerminalNativeChat(denied, params, context), /selector_not_found/)
    const frames: unknown[] = []
    const declarations = bindManagedTerminalNativeChatMethods([
      defineMethod({name: 'nativeChat.readSession', params: NativeChatSession, handler: async () => {throw new Error('MANAGED_FS_FALLBACK')}}),
      defineStreamingMethod({name: 'nativeChat.subscribe', params: NativeChatSession, handler: async () => {throw new Error('MANAGED_FS_FALLBACK')}})
    ], {...config, readHostIdentity: () => LOCAL_EXECUTION_HOST_ID})
    const stream = declarations.find(method => method.name === 'nativeChat.subscribe')!
    if (!('stream' in stream && stream.stream)) { throw new Error('STREAM') }
    await stream.handler(params as never, context, frame => frames.push(frame))
    assert.equal((frames[0] as {type: string}).type, 'snapshot')
    const spoolDirectory = path.join(process.env.HOME!, 'implementation', owner.replace(':', '-'))
    mkdirSync(spoolDirectory, {mode: 0o700, recursive: true})
    const output = createTerminalCodexOutput({pool, spoolDirectory, current: () => ({binding,
      protection: {takePreparedProtection: () => ({workloadIdentity: workload})}, context: {controller: authority, runtimeUnitId: unit, operationId: operation} as GatewayContext})})
    output.onNativeNotification(notification('2', 'second committed synthetic output'))
    await output.drain()
    for (let tries = 0; tries < 30 && frames.length < 2; tries++) { await delay(20) }
    assert.equal((frames[1] as {type: string}).type, 'replacement')
    assert.equal(output.snapshot().committed, 1)
    output.onNativeNotification(notification('2', 'second committed synthetic output')); await output.drain()
    assert.equal(output.snapshot().committed, 1)
    for (const cleanup of cleanups.values()) { cleanup() }; cleanups.clear()
    await pool.query(`UPDATE durable_runtime.tabs SET lifecycle='CLOSED',closed_at=clock_timestamp() WHERE id=$1`, [tab])
    output.onNativeNotification(notification('3', 'historical late output')); await output.drain()
    assert.equal(output.snapshot().committed, 2)
    await assert.rejects(readManagedTerminalNativeChat(config, params, context), /TARGET_UNAVAILABLE/)
    assert.equal((await pool.query('SELECT lifecycle FROM durable_runtime.tabs WHERE id=$1', [tab])).rows[0].lifecycle, 'CLOSED')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM durable_runtime.structured_session_aliases WHERE session_id=$1', [session])).rows[0].n, 0)
    await output.close()
    console.log(JSON.stringify({phase: 'TERMINAL_OUTPUT_PG_CALLBACK_COMPLETE', owner, sessionId: session,
      syntheticProvider: true, actualInference: false, schemaApplied: 0}))
  } finally { for (const cleanup of cleanups.values()) { cleanup() }; await pool.end() }
})
