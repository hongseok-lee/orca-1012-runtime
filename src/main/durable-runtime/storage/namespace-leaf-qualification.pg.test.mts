import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { registerNamespaceProfile } from './namespace-holds.ts'
import { captureFirstManagedBindingProfile } from './first-managed-binding-owner-profile.ts'
import type { FirstManagedBindingProfileRecord } from './first-managed-binding-owner-profile.ts'
import { createFirstManagedBindingOwner } from './first-managed-binding-owner.ts'
import type { FirstManagedBindingInput } from './first-managed-binding-owner.ts'
import { createFirstManagedInitialReservationOwner } from './first-managed-initial-owner.ts'
import { readOriginalFirstManagedDirectory } from './initial-directory-revalidation-guard.ts'
import { firstManagedFixture } from './first-managed-binding-owner-fixtures.mts'
import { fixture, pod, pvc, pv, helper, rawOutput, finish } from './managed-leaf-collector-fixtures.mts'
import { observedInitialPool } from './first-managed-initial-fixtures.mts'
import { createAgentPodPlanner } from '../runtime/agent-pod-plan.ts'
import { CLOSED_AGENT_BOOTSTRAP } from '../runtime/closed-agent-bootstrap.ts'
import { recordAgentPodPlan } from '../runtime/agent-pod-plan-records.ts'
import { LockedGatewayAuthority } from '../runtime/gateway/authority.ts'
import { submitCommand, originalIdentity } from '../runtime/gateway/store.ts'
import { claimCommand } from '../runtime/gateway/claim.ts'
import { inputDigest } from '../runtime/gateway/input.ts'
import type { GatewayContext, VerifiedControllerIdentity, ExecutorId } from '../runtime/gateway/types.ts'
import type { PayloadHash } from '../runtime/runtime-evidence.ts'

// Synthetic qualification/HTTPS/WebSocket data only. Real product owners and
// PG transactions are used; no live collector/provider/physical proof is run.
const database = process.env.ORCA_NAMESPACE_LEAF_DATABASE, oid = process.env.ORCA_NAMESPACE_LEAF_DATABASE_OID
const system = process.env.ORCA_NAMESPACE_LEAF_SYSTEM, evidenceRoot = process.env.ORCA_NAMESPACE_LEAF_EVIDENCE_ROOT
if (process.env.ORCA_NAMESPACE_LEAF_APPROVED !== 'root-first-verification' || database !== 'orca_unhandled_wake_expiry_20261016' ||
    process.env.PGDATABASE !== database || oid !== '96658' || system !== '7696101282789175327' || !evidenceRoot) {
  throw new Error('Root-approved existing namespace-leaf verification database required')
}
const pool = createDurablePool({ database, max: 4, application_name: 'namespace-leaf-qualification-first' })
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const tag = `namespace-leaf:${randomUUID()}`
const profile = { profileId: randomUUID(), datasetName: 'orca-1012-dev-v1', backendId: tag, exportId: tag, generation: '1' }
const signal = () => new AbortController().signal
type Synthetic = ReturnType<typeof firstManagedFixture>
function wireFor(f: Synthetic) {
  const c = { ...f.wire.configuration, ...f.settings.collector }, credential = f.settings.credential
  const response = { apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest',
    metadata: { name: credential.serviceAccountName, namespace: c.namespace, uid: credential.serviceAccountUid },
    status: { token: f.issued, expirationTimestamp: new Date(Date.now() + 600000).toISOString() } }
  // Reuse the reviewed raw helper framing, replacing only this synthetic leaf.
  const inode = String(400n + BigInt(`0x${f.record.leafId.replaceAll('-', '').slice(-8)}`))
  const output = rawOutput(c).replaceAll('00000000-0000-4000-8000-00000000000a', f.record.leafId)
    .replace('"inode":"400"', `"inode":"${inode}"`)
  const wire = fixture([{ status: 201, body: response }, { body: pod(c) }, { body: pvc(c) },
    { body: pv(c) }, { body: helper(c) }, { body: pod(c) }], socket => finish(socket, output))
  Object.assign(wire.configuration, c)
  return { wire, settings: { ...f.settings, collector: wire.configuration } }
}
function qualification(namespaceDigest?: string): Synthetic {
  const f = firstManagedFixture(), leafId = randomUUID()
  const record: FirstManagedBindingProfileRecord = { ...f.record, leafId, qualificationRef: `${tag}:qualification:${leafId}`,
    profile: { ...profile, ...(namespaceDigest === undefined ? {} : { namespaceDigest }) } }
  const bytes = Buffer.from(JSON.stringify(record)), collector = { ...f.settings.collector,
    backendId: profile.backendId, exportId: profile.exportId }
  const configured = { ...f, record, leafId, bytes, settings: { ...f.settings,
    acceptedProfileBytes: bytes, expectedProfileDigest: hash(bytes), collector } }
  const fresh = wireFor(configured)
  return { ...configured, ...fresh }
}
async function seed(f: Synthetic): Promise<FirstManagedBindingInput> {
  const agent = randomUUID(), workspace = randomUUID()
  const input: FirstManagedBindingInput = { sessionId: logicalId('session', randomUUID()),
    unitId: logicalId('runtime-unit', randomUUID()), bindingId: logicalId('storage-binding', randomUUID()),
    expectedUnitRevision: counter('row:runtime-unit', '0'), expectedBindingRevision: counter('row:storage-binding', '0'),
    actorId: tag, pinId: randomUUID(), ownerToken: `${tag}:owner:${randomUUID()}`, leafId: f.record.leafId }
  await withDurableTransaction(pool, async tx => {
    await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'synthetic')", [agent])
    await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,$3,'READY')", [workspace, `${tag}:${workspace}`, tag])
    await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT')", [input.unitId])
    await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [input.sessionId, agent, workspace])
    await tx.query("INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state) VALUES($1,$2,$3,$4,'UNVERIFIED')",
      [input.bindingId, profile.backendId, profile.exportId, `/${profile.datasetName}/${f.record.leafId}`])
    await tx.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)', [input.unitId, input.sessionId, input.bindingId])
  })
  return input
}
async function namespaceRows() {
  return {
    profile: (await pool.query('SELECT to_jsonb(p)::text AS body FROM durable_runtime.storage_namespace_profiles p WHERE id=$1', [profile.profileId])).rows,
    versions: (await pool.query('SELECT to_jsonb(v)::text AS body FROM durable_runtime.storage_namespace_profile_versions v WHERE profile_id=$1 ORDER BY generation', [profile.profileId])).rows
  }
}
async function audit(id: string) {
  return (await pool.query('SELECT id,next_state,evidence_refs FROM durable_runtime.runtime_audit_events WHERE id=$1', [id])).rows[0]
}
async function initialInput(f: Synthetic, input: FirstManagedBindingInput, originalAuditId: string) {
  const scope = `${tag}:controller`, owner = `${tag}:controller-owner`
  // Reviewed nominal fixture context with its own new SQL lease row only;
  // existing PR154's normal controller lease is neither acquired nor changed.
  const controller = { scope, owner, term: counter('controller-term', '1') } as VerifiedControllerIdentity
  const context: GatewayContext = { runtimeUnitId: input.unitId, operationId: logicalId('operation', randomUUID()), controller }
  const plan = createAgentPodPlanner({ namespace: 'namespace-leaf-fixture', dataset: profile.datasetName,
    image: `example.invalid/agent@sha256:${'1'.repeat(64)}`,
    entrypoint: { command: CLOSED_AGENT_BOOTSTRAP.command, args: CLOSED_AGENT_BOOTSTRAP.args },
    nfsServer: 'nfs.fixture.svc.cluster.local', protectedExportRoot: `/exports/runtime-domains/${profile.datasetName}`,
    paths: { home: '/agent/home', claudeState: '/agent/home/.claude', codexState: '/agent/home/.codex', checkout: '/agent/checkout' },
    protectedMounts: [{ key: 'home', clientPath: '/agent' }],
    shared: { claimName: 'shared-fixture', claimUid: 'shared-claim', pvUid: 'shared-pv', serverPath: `/exports/shared/${profile.datasetName}` },
  }).plan({ identity: { unitId: input.unitId, operationId: context.operationId, attemptId: randomUUID(),
    resourceName: `orca-unit-${context.operationId}`, executionEpoch: '0', intentRevision: '0', specHash: 'a'.repeat(64) },
  protectedBindings: [{ key: 'home', mode: 'RW', bindingId: input.bindingId, leafId: f.record.leafId,
    claimName: 'protected-fixture', claimUid: 'protected-claim', pvUid: 'protected-pv',
    serverPath: `/exports/runtime-domains/${profile.datasetName}/${f.record.leafId}` }],
  profile: { revision: '0', cpuMilli: 100, memoryMi: 128, ephemeralMi: 256, temporaryMi: 64 } })
  const attempt = await withDurableTransaction(pool, async tx => {
    await tx.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,$2,1,clock_timestamp()+interval '10 minutes')", [scope, owner])
    await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0)", [input.unitId])
    await tx.query(`INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,execution_epoch,external_resource_name)
      VALUES($1,$2,'WAKE',0,$3,1,'ENSURE_ATTEMPT',0,$4)`, [context.operationId, input.unitId, scope, plan.identity.resourceName])
    const stored = await recordAgentPodPlan(tx, context, plan), authority = await LockedGatewayAuthority.acquire(tx, context)
    const body = { resourceName: plan.identity.resourceName, body: { mode: 'COLD', planDigest: stored.record.planDigest,
      attemptId: plan.identity.attemptId, resourceProfileRevision: '0' } }
    const submitted = await submitCommand(authority, { command: 'ensureAttempt', envelope: { operationId: context.operationId,
      controllerTerm: controller.term, stepRevision: counter('step-revision', '0'), executionEpoch: counter('execution-epoch', '0'),
      intentRevision: counter('intent-revision', '0'), podTarget: 'CREATE_WITHOUT_POD', expectedPodUid: null },
      input: body, inputHash: inputDigest(body) as PayloadHash, predecessor: { kind: 'NONE' } })
    const claimed = await claimCommand(authority, originalIdentity(submitted.command), `${tag}:executor` as ExecutorId)
    assert.equal(claimed.disposition, 'CLAIMED')
    if (claimed.disposition !== 'CLAIMED') { throw new Error('Synthetic original claim required') }
    return { claim: claimed.claim, planDigest: stored.record.planDigest, expectedUnitRevision: counter('row:runtime-unit', '0'),
      bindings: [{ bindingId: input.bindingId, expectedRevision: counter('row:storage-binding', '1'), storageEpoch: counter('storage-epoch', '0') }] }
  })
  return { sessionId: input.sessionId, actorId: tag, originalAuditId, pinId: randomUUID(),
    ownerToken: `${tag}:initial-owner:${randomUUID()}`, context, attempt }
}

test('namespace leaf qualification separates file evidence from one unchanged namespace and revalidates the original leaf', async t => {
  t.after(() => pool.end())
  const identity = await withDurableTransaction(pool, async tx => {
    const actual = (await tx.query(`SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
      (SELECT system_identifier::text FROM pg_control_system()) AS system,pg_backend_pid() AS backend_pid,clock_timestamp() AS observed_at`)).rows[0]
    assert.equal(actual.database, database); assert.equal(actual.oid, oid); assert.equal(actual.system, system)
    assert.deepEqual((await tx.query('SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows, [{ dataset_name: profile.datasetName }])
    return actual
  })
  await writeFile(`${evidenceRoot}/fixture-identity.json`, `${JSON.stringify(identity)}\n`, { mode: 0o600, flag: 'wx' })
  const ledger = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length, 23)
  const legacy = qualification(), acceptedA = captureFirstManagedBindingProfile(legacy.bytes, legacy.settings.expectedProfileDigest)
  assert.equal(acceptedA.digest, legacy.settings.expectedProfileDigest); assert.equal(acceptedA.namespaceDigest, acceptedA.digest)
  assert.equal('namespaceDigest' in acceptedA.record.profile, false)
  const registered = await registerNamespaceProfile(pool, { ...profile, digest: acceptedA.namespaceDigest, actorId: tag })
  assert.equal(registered.disposition?.status, 'REGISTERED'); assert.equal(registered.database.ok, true)
  const namespaceBefore = await namespaceRows(), a = await seed(legacy)
  const verifiedA = await createFirstManagedBindingOwner(pool, legacy.settings, legacy.wire.dependencies).verifyFirstBinding(a, signal())
  assert.equal(verifiedA.outcome, 'VERIFIED'); assert.equal(verifiedA.pin.state, 'RELEASED'); assert.ok(verifiedA.audit?.ok)
  const originalA = await audit(verifiedA.audit.value.auditId)
  assert.equal(originalA.next_state.digest, acceptedA.digest); assert.equal('qualificationDigest' in originalA.next_state, false)
  const expectedEvidence = `first-managed-binding:sha256:${hash(JSON.stringify({ profileDigest: acceptedA.digest,
    profileId: profile.profileId, generation: profile.generation, pinId: a.pinId,
    scope: { sessionId: a.sessionId, unitId: a.unitId, bindingId: a.bindingId,
      expectedUnitRevision: a.expectedUnitRevision, expectedBindingRevision: a.expectedBindingRevision, actorId: a.actorId },
    leafId: legacy.record.leafId, observationRef: verifiedA.observationRef, qualificationRef: legacy.record.qualificationRef }))}`
  assert.equal(verifiedA.evidenceRef, expectedEvidence)
  await legacy.wire.assertCleanup(); t.diagnostic('LEGACY_NAMESPACE_BINDING_COMPLETE')

  const second = qualification(acceptedA.namespaceDigest), acceptedB = captureFirstManagedBindingProfile(second.bytes, second.settings.expectedProfileDigest)
  assert.notEqual(acceptedB.digest, acceptedA.digest); assert.notEqual(second.record.leafId, legacy.record.leafId)
  assert.equal(acceptedB.namespaceDigest, acceptedA.namespaceDigest)
  const repeated = await registerNamespaceProfile(pool, { ...second.record.profile, digest: acceptedB.namespaceDigest, actorId: tag })
  assert.equal(repeated.disposition?.status, 'ALREADY_REGISTERED'); assert.equal(repeated.database.ok, true)
  assert.deepEqual(await namespaceRows(), namespaceBefore)
  const b = await seed(second), verifiedB = await createFirstManagedBindingOwner(pool, second.settings, second.wire.dependencies).verifyFirstBinding(b, signal())
  assert.equal(verifiedB.outcome, 'VERIFIED'); assert.equal(verifiedB.pin.state, 'RELEASED'); assert.ok(verifiedB.audit?.ok)
  const originalB = await audit(verifiedB.audit.value.auditId)
  assert.equal(originalB.next_state.digest, acceptedA.namespaceDigest); assert.equal(originalB.next_state.qualificationDigest, acceptedB.digest)
  assert.notEqual(verifiedA.evidenceRef, verifiedB.evidenceRef)
  const holds = (await pool.query('SELECT profile_id,generation,digest,state FROM durable_runtime.storage_namespace_holds WHERE id=ANY($1::uuid[])', [[a.pinId, b.pinId]])).rows
  assert.equal(holds.length, 2)
  for (const hold of holds) { assert.deepEqual(hold, { profile_id: profile.profileId, generation: '1', digest: acceptedA.namespaceDigest, state: 'RELEASED' }) }
  assert.deepEqual(await namespaceRows(), namespaceBefore); await second.wire.assertCleanup(); t.diagnostic('SECOND_LEAF_BINDING_COMPLETE')

  const wrongNamespace = qualification(hash(`${tag}:wrong-namespace`))
  const wrongAccepted = captureFirstManagedBindingProfile(wrongNamespace.bytes, wrongNamespace.settings.expectedProfileDigest)
  const rejected = await registerNamespaceProfile(pool, { ...profile, digest: wrongAccepted.namespaceDigest, actorId: tag })
  assert.equal(rejected.database.ok, false)
  const owner = createFirstManagedBindingOwner(pool, wrongNamespace.settings, wrongNamespace.wire.dependencies)
  const badHold = await owner.verifyFirstBinding({ ...b, leafId: wrongNamespace.record.leafId, pinId: randomUUID() }, signal())
  assert.equal(badHold.phase, 'HOLD'); assert.notEqual(badHold.outcome, 'VERIFIED'); assert.equal(badHold.pin.state, 'NOT_ACQUIRED')
  assert.equal(wrongNamespace.wire.api.requests.length, 0)
  const duplicate = await registerNamespaceProfile(pool, { ...profile, profileId: randomUUID(), digest: acceptedA.namespaceDigest, actorId: tag })
  assert.equal(duplicate.database.ok, false)
  assert.deepEqual(await namespaceRows(), namespaceBefore)
  const malformed = Buffer.from(JSON.stringify({ ...second.record, profile: { ...profile, namespaceDigest: 'invalid' } }))
  assert.throws(() => captureFirstManagedBindingProfile(malformed, hash(malformed)))
  assert.throws(() => captureFirstManagedBindingProfile(second.bytes, hash('different-file')))
  const initial = await initialInput(second, b, originalB.id)
  await assert.rejects(withDurableTransaction(pool, tx => readOriginalFirstManagedDirectory(tx, acceptedB, {
    originalAuditId: originalA.id, sessionId: a.sessionId,
    context: { ...initial.context, runtimeUnitId: a.unitId }, bindingId: a.bindingId })))
  // Same leaf/namespace is also insufficient when the qualification file hash changes.
  const changedBytes = Buffer.from(JSON.stringify({ ...second.record, qualificationRef: `${tag}:different-qualification` }))
  const changed = captureFirstManagedBindingProfile(changedBytes, hash(changedBytes))
  await assert.rejects(withDurableTransaction(pool, tx => readOriginalFirstManagedDirectory(tx, changed, {
    originalAuditId: originalB.id, sessionId: b.sessionId,
    context: initial.context, bindingId: b.bindingId })))
  t.diagnostic('WRONG_NAMESPACE_LEAF_AND_FILE_REJECTED')

  const fresh = wireFor(second)
  let heldThroughCommit = false
  const observed = observedInitialPool(pool, { beforeFinalCommit: async () => {
    assert.equal((await pool.query('SELECT state FROM durable_runtime.storage_namespace_holds WHERE id=$1', [initial.pinId])).rows[0].state, 'HELD')
    heldThroughCommit = true
  } })
  const reserved = await createFirstManagedInitialReservationOwner(observed.pool, fresh.settings, fresh.wire.dependencies).reserveInitialAttempt(initial, signal())
  assert.equal(reserved.outcome, 'RESERVED'); assert.equal(reserved.pin.state, 'RELEASED'); assert.equal(heldThroughCommit, true)
  assert.equal(reserved.reservation?.pins.disposition, 'RELEASED'); assert.equal(observed.active.size, 0); assert.equal(observed.ends, 0)
  assert.equal(reserved.physicalPinIssued, false); assert.equal(reserved.writerGrantActivated, false); assert.equal(reserved.providerReady, false)
  const revalidated = (await pool.query("SELECT next_state FROM durable_runtime.runtime_audit_events WHERE producer_id=$1 AND kind='INITIAL_AGENT_DIRECTORY_REVALIDATED'", [initial.pinId])).rows[0].next_state
  assert.equal(revalidated.profileDigest, acceptedB.digest); assert.equal(revalidated.namespaceDigest, acceptedA.namespaceDigest)
  assert.equal(revalidated.originalAuditId, originalB.id); assert.equal(revalidated.qualificationRef, second.record.qualificationRef)
  assert.deepEqual(await audit(originalA.id), originalA); assert.deepEqual(await audit(originalB.id), originalB)
  assert.deepEqual(await namespaceRows(), namespaceBefore)
  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
  await fresh.wire.assertCleanup(); t.diagnostic('INITIAL_NAMESPACE_REVALIDATION_SETTLED')
  await writeFile(`${evidenceRoot}/fixture-result.json`, `${JSON.stringify({ tag, profileId: profile.profileId,
    generation: profile.generation, legacyFileDigest: acceptedA.digest, secondFileDigest: acceptedB.digest,
    namespaceDigest: acceptedA.namespaceDigest, bindingIds: [a.bindingId, b.bindingId], leafIds: [legacy.record.leafId, second.record.leafId],
    holdIds: [a.pinId, b.pinId, initial.pinId], profileUnchanged: true, ledger23Unchanged: true, heldThroughCommit,
    actualProviderOrPhysicalProof: false })}\n`, { mode: 0o600, flag: 'wx' })
})
