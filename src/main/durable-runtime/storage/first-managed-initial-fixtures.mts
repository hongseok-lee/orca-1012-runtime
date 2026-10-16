import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { withDurableTransaction } from '../db/connection.ts'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { createFirstManagedBindingOwner, type FirstManagedBindingInput } from './first-managed-binding-owner.ts'
import { firstManagedFixture } from './first-managed-binding-owner-fixtures.mts'
import { fixture, pod, pvc, pv, helper, rawOutput, finish } from './managed-leaf-collector-fixtures.mts'
import { registerNamespaceProfile } from './namespace-holds.ts'
import { createAgentPodPlanner } from '../runtime/agent-pod-plan.ts'
import { CLOSED_AGENT_BOOTSTRAP } from '../runtime/closed-agent-bootstrap.ts'
import { recordAgentPodPlan } from '../runtime/agent-pod-plan-records.ts'
import { LockedGatewayAuthority } from '../runtime/gateway/authority.ts'
import { submitCommand, originalIdentity } from '../runtime/gateway/store.ts'
import { claimCommand } from '../runtime/gateway/claim.ts'
import { inputDigest } from '../runtime/gateway/input.ts'
import type { GatewayContext, VerifiedControllerIdentity, ExecutorId } from '../runtime/gateway/types.ts'
import type { PayloadHash } from '../runtime/runtime-evidence.ts'
import type { InitialAgentAttemptInput } from '../runtime/initial-agent-attempt.ts'
import type { FirstManagedInitialInput } from './first-managed-initial-owner.ts'

// Synthetic original credential/transport only. The new production owner still
// creates its original reader and collector; no observation/brand is injected.
export function freshObservation(f: ReturnType<typeof firstManagedFixture>, changedInode = false) {
  const c = f.wire.configuration, credential = f.settings.credential
  const response = { apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest',
    metadata: { name: credential.serviceAccountName, namespace: c.namespace, uid: credential.serviceAccountUid },
    status: { token: f.issued, expirationTimestamp: new Date(Date.now() + 600000).toISOString() } }
  const output = rawOutput(c)
  assert.ok(output.includes('"inode":"400"'))
  const wire = fixture([{ status: 201, body: response }, { body: pod(c) }, { body: pvc(c) },
    { body: pv(c) }, { body: helper(c) }, { body: pod(c) }], socket =>
    finish(socket, changedInode ? output.replace('"inode":"400"', '"inode":"401"') : output))
  Object.assign(wire.configuration, c)
  return { wire, settings: { ...f.settings, collector: wire.configuration } }
}

export type InitialFixtureDatabase = Readonly<{ database: string; oid: string; system: string }>
export async function requireInitialFixtureDatabase(pool: Pool, expected: InitialFixtureDatabase) {
  const identity = (await pool.query(`SELECT current_database() AS database,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system`)).rows[0]
  assert.deepEqual(identity, expected)
  assert.deepEqual((await pool.query('SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows,
    [{ dataset_name: 'orca-1012-dev-v1' }])
}
export async function seedInitialRevalidation(pool: Pool, expected: InitialFixtureDatabase,
  options: Readonly<{ closedBootstrap?: true }> = {}) {
  await requireInitialFixtureDatabase(pool, expected)
  const f = firstManagedFixture(), agent = randomUUID(), workspace = randomUUID()
  const original: FirstManagedBindingInput = { sessionId: logicalId('session', randomUUID()),
    unitId: logicalId('runtime-unit', randomUUID()), bindingId: logicalId('storage-binding', randomUUID()),
    expectedUnitRevision: counter('row:runtime-unit', '0'), expectedBindingRevision: counter('row:storage-binding', '0'),
    actorId: 'fixture-initial-revalidation', pinId: randomUUID(), ownerToken: `fixture-original-owner:${randomUUID()}`, leafId: f.leafId }
  await withDurableTransaction(pool, async tx => {
    await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'synthetic')", [agent])
    await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'initial revalidation fixture','READY')",
      [workspace, `fixture-revalidation:${workspace}`])
    await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT')", [original.unitId])
    await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [original.sessionId, agent, workspace])
    await tx.query('INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2)', [f.record.profile.backendId, f.record.profile.exportId])
    await tx.query("INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state) VALUES($1,$2,$3,$4,'UNVERIFIED')",
      [original.bindingId, f.record.profile.backendId, f.record.profile.exportId, `/${f.record.profile.datasetName}/${f.leafId}`])
    await tx.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)',
      [original.unitId, original.sessionId, original.bindingId])
  })
  const registered = await registerNamespaceProfile(pool, { ...f.record.profile, digest: f.settings.expectedProfileDigest, actorId: original.actorId })
  assert.equal(registered.database.ok, true); assert.equal(registered.disposition?.status, 'REGISTERED')
  const verified = await createFirstManagedBindingOwner(pool, f.settings, f.wire.dependencies)
    .verifyFirstBinding(original, new AbortController().signal)
  assert.equal(verified.outcome, 'VERIFIED'); assert.equal(verified.pin.state, 'RELEASED')
  assert.ok(verified.audit?.ok)
  const originalAuditId = verified.audit.value.auditId
  await f.wire.assertCleanup()
  const scope = `fixture-revalidation:${randomUUID()}`, owner = `fixture-controller:${randomUUID()}`
  // SAFETY: synthetic controller and executor identities exist only in this
  // isolated fixture. This does not qualify any live issuer/physical authority.
  const controller = Object.freeze({ scope, owner, term: counter('controller-term', '1') }) as VerifiedControllerIdentity
  const operation = logicalId('operation', randomUUID()), attemptId = randomUUID()
  const context: GatewayContext = Object.freeze({ runtimeUnitId: original.unitId, operationId: operation, controller })
  const dataset = f.record.profile.datasetName
  const plan = createAgentPodPlanner({ namespace: 'initial-revalidation-fixture', dataset,
    image: `example.invalid/agent@sha256:${'1'.repeat(64)}`,
    entrypoint: options.closedBootstrap ? { command: CLOSED_AGENT_BOOTSTRAP.command, args: CLOSED_AGENT_BOOTSTRAP.args } :
      { command: ['/opt/agent/entrypoint'], args: ['--cold'] },
    nfsServer: 'nfs.fixture.svc.cluster.local', protectedExportRoot: `/exports/runtime-domains/${dataset}`,
    paths: { home: '/agent/home', claudeState: '/agent/home/.claude', codexState: '/agent/home/.codex', checkout: '/agent/checkout' },
    protectedMounts: [{ key: 'home', clientPath: '/agent' }],
    shared: { claimName: 'shared-fixture', claimUid: 'shared-claim', pvUid: 'shared-pv', serverPath: `/exports/shared/${dataset}` },
  }).plan({ identity: { unitId: original.unitId, operationId: operation, attemptId, resourceName: `orca-unit-${operation}`,
    executionEpoch: '0', intentRevision: '0', specHash: 'a'.repeat(64) },
  protectedBindings: [{ key: 'home', mode: 'RW', bindingId: original.bindingId, leafId: f.leafId,
    claimName: 'protected-fixture', claimUid: 'protected-consumer-claim', pvUid: 'protected-consumer-pv',
    serverPath: `/exports/runtime-domains/${dataset}/${f.leafId}` }],
  profile: { revision: '0', cpuMilli: 100, memoryMi: 128, ephemeralMi: 256, temporaryMi: 64 } })
  const request = await withDurableTransaction(pool, async tx => {
    await tx.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,$2,1,clock_timestamp()+interval '10 minutes')", [scope, owner])
    await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0)", [original.unitId])
    await tx.query(`INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,execution_epoch,external_resource_name)
      VALUES($1,$2,'WAKE',0,$3,1,'ENSURE_ATTEMPT',0,$4)`, [operation, original.unitId, scope, plan.identity.resourceName])
    const stored = await recordAgentPodPlan(tx, context, plan)
    const envelope = { operationId: operation, controllerTerm: controller.term, stepRevision: counter('step-revision', '0'),
      executionEpoch: plan.identity.executionEpoch, intentRevision: plan.identity.intentRevision,
      podTarget: 'CREATE_WITHOUT_POD' as const, expectedPodUid: null }
    const commandInput = { resourceName: plan.identity.resourceName, body: { mode: 'COLD', planDigest: stored.record.planDigest,
      attemptId: plan.identity.attemptId, resourceProfileRevision: plan.pod.metadata.annotations['orca.dev/resource-profile-revision'] } }
    const locked = await LockedGatewayAuthority.acquire(tx, context)
    // SAFETY: locally computed digest/executor nominal types for fixture input.
    const submitted = await submitCommand(locked, { command: 'ensureAttempt', envelope, input: commandInput,
      inputHash: inputDigest(commandInput) as PayloadHash, predecessor: { kind: 'NONE' } })
    const claimed = await claimCommand(locked, originalIdentity(submitted.command), `fixture-executor:${operation}` as ExecutorId)
    assert.equal(claimed.disposition, 'CLAIMED')
    if (claimed.disposition !== 'CLAIMED') { throw new Error('fixture original claim missing') }
    const input: InitialAgentAttemptInput = { claim: claimed.claim, planDigest: stored.record.planDigest,
      expectedUnitRevision: counter('row:runtime-unit', '0'), bindings: [{ bindingId: original.bindingId,
        expectedRevision: counter('row:storage-binding', '1'), storageEpoch: counter('storage-epoch', '0') }] }
    return input
  })
  const input: FirstManagedInitialInput = { sessionId: original.sessionId, actorId: original.actorId, originalAuditId,
    pinId: randomUUID(), ownerToken: `fixture-fresh-owner:${randomUUID()}`, context, attempt: request }
  const auditBefore = (await pool.query('SELECT to_jsonb(a) AS body FROM durable_runtime.runtime_audit_events a WHERE id=$1', [originalAuditId])).rows[0].body
  const bindingBefore = (await pool.query('SELECT to_jsonb(b) AS body FROM durable_runtime.storage_bindings b WHERE id=$1', [original.bindingId])).rows[0].body
  return { f, original, verified, input, plan, auditBefore, bindingBefore }
}
export type InitialRevalidationFixture = Awaited<ReturnType<typeof seedInitialRevalidation>>

export function observedInitialPool(pool: Pool, options: Readonly<{
  beforeFinalCheckout?: () => Promise<void>; beforeFinalCommit?: () => Promise<void>;
  unknownFinalCommit?: boolean; rejectConnect?: 3 | 4;
}> = {}) {
  const events: string[] = [], active = new Set<number>()
  let connects = 0, ends = 0
  const facade = new Proxy(pool, { get(target, key) {
    if (key === 'end') { return () => { ends++; throw new Error('Borrowed pool must not end') } }
    if (key !== 'connect') { return Reflect.get(target, key, target) }
    return async () => {
      const ordinal = ++connects
      events.push(`CONNECT${ordinal}`)
      if (ordinal === 3 && options.beforeFinalCheckout) { await options.beforeFinalCheckout() }
      if (ordinal === options.rejectConnect) { throw new Error('Synthetic checkout rejection') }
      const client = await pool.connect(); active.add(ordinal)
      let unknown = false
      return new Proxy(client, { get(original, property) {
        if (property === 'query') { return async (...args: unknown[]) => {
          const sql = args[0]
          if (ordinal === 3 && sql === 'COMMIT' && options.beforeFinalCommit) { await options.beforeFinalCommit() }
          const value = await Reflect.apply(original.query, original, args)
          if (sql === 'COMMIT' || sql === 'ROLLBACK') { events.push(`${sql}${ordinal}`) }
          if (ordinal === 3 && sql === 'COMMIT' && options.unknownFinalCommit) {
            unknown = true; return { ...value, command: 'UNCONFIRMED' }
          }
          if (sql === 'ROLLBACK' && unknown) { return { ...value, command: 'UNCONFIRMED' } }
          return value
        } }
        if (property === 'release') { return (...args: unknown[]) => {
          Reflect.apply(original.release, original, args); active.delete(ordinal); events.push(`CLEANUP${ordinal}`)
        } }
        return Reflect.get(original, property, original)
      } })
    }
  } })
  return { pool: facade, events, active, get connects() { return connects }, get ends() { return ends } }
}

export async function addPastGrant(pool: Pool, f: InitialRevalidationFixture) {
  const unit = randomUUID(), attempt = randomUUID(), grant = randomUUID()
  await withDurableTransaction(pool, async tx => {
    await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT')", [unit])
    await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0)", [unit])
    await tx.query("INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,resource_profile_revision,effective_resources,status) VALUES($1,$2,0,'COLD',0,'{}','RESERVED')", [attempt, unit])
    await tx.query(`INSERT INTO durable_runtime.storage_write_grants(id,storage_binding_id,attempt_id,storage_epoch,state,revoked_at,revocation_proof_ref)
      VALUES($1,$2,$3,0,'REVOKED',clock_timestamp(),'fixture-past-revoked-proof')`, [grant, f.original.bindingId, attempt])
  })
  return grant
}
