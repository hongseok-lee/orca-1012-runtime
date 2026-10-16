import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, withDurableTransaction } from '../db/connection.ts'
import { requestUnitIntent } from '../lifecycle/intent.ts'
import { intent, executor } from '../lifecycle/verification-fixtures.mts'
import type { LifecycleOperation } from '../lifecycle/types.ts'
import { firstManagedFixture } from '../storage/first-managed-binding-owner-fixtures.mts'
import { createFirstManagedBindingOwner } from '../storage/first-managed-binding-owner.ts'
import type { FirstManagedBindingInput } from '../storage/first-managed-binding-owner.ts'
import { requireInitialFixtureDatabase, freshObservation, type InitialFixtureDatabase } from '../storage/first-managed-initial-fixtures.mts'
import { registerNamespaceProfile } from '../storage/namespace-holds.ts'
import { CLOSED_AGENT_BOOTSTRAP } from './closed-agent-bootstrap.ts'
import { createAgentPodPlanner, type TrustedAgentPodRequest } from './agent-pod-plan.ts'
import type { FirstManagedInitialDispatchConfig } from './first-managed-initial-dispatch.ts'

/** Additive isolated setup only; no controller/claim/plan/profile or proof is fabricated here. */
export async function dispatchFixture(pool: Pool, expected: InitialFixtureDatabase) {
  await requireInitialFixtureDatabase(pool, expected)
  const f = firstManagedFixture(), agent = randomUUID(), workspace = randomUUID()
  const original: FirstManagedBindingInput = {
    sessionId: logicalId('session', randomUUID()), unitId: logicalId('runtime-unit', randomUUID()),
    bindingId: logicalId('storage-binding', randomUUID()), expectedUnitRevision: counter('row:runtime-unit', '0'),
    expectedBindingRevision: counter('row:storage-binding', '0'), actorId: 'fixture-first-managed-dispatch',
    pinId: randomUUID(), ownerToken: `fixture-original-owner:${randomUUID()}`, leafId: f.leafId,
  }
  await withDurableTransaction(pool, async tx => {
    await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'synthetic')", [agent])
    await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'dispatch fixture','READY')", [workspace, `dispatch:${workspace}`])
    await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT')", [original.unitId])
    await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [original.sessionId, agent, workspace])
    await tx.query('INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2)', [f.record.profile.backendId, f.record.profile.exportId])
    await tx.query("INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state) VALUES($1,$2,$3,$4,'UNVERIFIED')",
      [original.bindingId, f.record.profile.backendId, f.record.profile.exportId, `/${f.record.profile.datasetName}/${f.leafId}`])
    await tx.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)', [original.unitId, original.sessionId, original.bindingId])
  })
  const registered = await registerNamespaceProfile(pool, { ...f.record.profile, digest: f.settings.expectedProfileDigest, actorId: original.actorId })
  assert.equal(registered.database.ok, true); assert.equal(registered.database.cleanupFailed, false)
  const verified = await createFirstManagedBindingOwner(pool, f.settings, f.wire.dependencies).verifyFirstBinding(original, new AbortController().signal)
  assert.equal(verified.outcome, 'VERIFIED'); assert.equal(verified.pin.state, 'RELEASED')
  assert.ok(verified.audit?.ok)
  const members = { unit: original.unitId, sessions: [original.sessionId], binding: original.bindingId }
  const queued = await requestUnitIntent(pool, await intent(pool, members))
  assert.equal(queued.status, 'COMMITTED')
  const operation = (await pool.query<LifecycleOperation>('SELECT * FROM durable_runtime.operations WHERE runtime_unit_id=$1 AND result IS NULL', [original.unitId])).rows[0]
  assert.ok(operation); assert.equal(operation.kind, 'WAKE'); assert.ok(operation.external_resource_name)
  const dataset = f.record.profile.datasetName
  const policy = { namespace: 'first-managed-dispatch-fixture', dataset, image: `example.invalid/agent@sha256:${'1'.repeat(64)}`,
    entrypoint: { command: CLOSED_AGENT_BOOTSTRAP.command, args: CLOSED_AGENT_BOOTSTRAP.args },
    nfsServer: 'nfs.fixture.svc.cluster.local', protectedExportRoot: `/exports/runtime-domains/${dataset}`,
    paths: { home: '/agent/home', claudeState: '/agent/home/.claude', codexState: '/agent/home/.codex', checkout: '/agent/checkout' },
    protectedMounts: [{ key: 'home', clientPath: '/agent' }],
    shared: { claimName: 'shared-fixture', claimUid: 'shared-claim', pvUid: 'shared-pv', serverPath: `/exports/shared/${dataset}` } }
  const request: TrustedAgentPodRequest = {
    identity: { unitId: original.unitId, operationId: operation.id, attemptId: randomUUID(), resourceName: operation.external_resource_name,
      executionEpoch: operation.execution_epoch, intentRevision: operation.intent_revision, specHash: 'a'.repeat(64) },
    protectedBindings: [{ key: 'home', bindingId: original.bindingId, leafId: f.leafId, claimName: 'protected-fixture',
      claimUid: 'protected-consumer-claim', pvUid: 'protected-consumer-pv', serverPath: `/exports/runtime-domains/${dataset}/${f.leafId}`, mode: 'RW' }],
    profile: { revision: '0', cpuMilli: 100, memoryMi: 128, ephemeralMi: 256, temporaryMi: 64 },
  }
  const fresh = freshObservation(f), pinId = randomUUID(), ownerToken = `fixture-fresh-owner:${randomUUID()}`
  let tokenReads = 0
  const config: FirstManagedInitialDispatchConfig = { pool, policy, request, policyRevision: '0', sessionId: original.sessionId,
    actorId: original.actorId, originalAuditId: verified.audit.value.auditId, pinId,
    binding: { bindingId: original.bindingId, expectedRevision: '1', storageEpoch: '0' }, executorId: executor, externalBudgetMs: 60000,
    async readOwnerToken(id, signal) { assert.equal(this, config); assert.equal(id, pinId); assert.equal(signal.aborted, false); tokenReads++; return ownerToken },
    podConfig: { apiOrigin: 'https://kubernetes.invalid:6443', ca: Buffer.from('synthetic-ca'), namespace: policy.namespace,
      dataset, timeoutMs: 1000, readBearerToken: () => f.reviewerToken }, firstManagedDirectory: fresh.settings }
  const plan = createAgentPodPlanner(policy).plan(request), podUid = `fixture-dispatch:${randomUUID()}`
  const observedPod = { ...plan.pod, metadata: { ...plan.pod.metadata, uid: podUid, resourceVersion: 'fixture-rv' } }
  const auditBefore = (await pool.query('SELECT to_jsonb(a) AS body FROM durable_runtime.runtime_audit_events a WHERE id=$1', [config.originalAuditId])).rows[0].body
  return { f, fresh, config, plan, observedPod, ownerToken, auditBefore, get tokenReads() { return tokenReads } }
}

/** Observe real composer transactions only; fault injection never fabricates a successful SQL result. */
export function composerPool(pool: Pool, fault: Readonly<{ ordinal: 1 | 2; kind: 'COMMIT_UNKNOWN' | 'CLEANUP' }> | null = null,
  afterProfileCommit?: () => void) {
  let connects = 0, ends = 0
  const active = new Set<number>(), events: string[] = []
  const borrowed = new Proxy(pool, { get(target, key) {
    if (key === 'end') { return () => { ends++; throw new Error('Borrowed composer Pool must not end') } }
    if (key !== 'connect') { const member = Reflect.get(target, key, target); return typeof member === 'function' ? member.bind(target) : member }
    return async () => {
      const ordinal = ++connects, client = await pool.connect(); active.add(ordinal)
      return new Proxy(client, { get(original, property) {
        if (property === 'query') { return async (...args: unknown[]) => {
          const result = await Reflect.apply(original.query, original, args), sql = args[0]
          if (sql === 'COMMIT' || sql === 'ROLLBACK') { events.push(`${sql}${ordinal}`) }
          if (sql === 'COMMIT' && ordinal === 2) { afterProfileCommit?.() }
          if (sql === 'COMMIT' && ordinal === fault?.ordinal && fault.kind === 'COMMIT_UNKNOWN') { throw new DurableDatabaseError('08006') }
          return result
        } }
        if (property === 'release') { return (...args: unknown[]) => {
          Reflect.apply(original.release, original, args); active.delete(ordinal); events.push(`CLEANUP${ordinal}`)
          if (ordinal === fault?.ordinal && fault.kind === 'CLEANUP') { throw new DurableDatabaseError('08006') }
        } }
        return Reflect.get(original, property, original)
      } })
    }
  } })
  return { pool: borrowed, active, events, get connects() { return connects }, get ends() { return ends } }
}
