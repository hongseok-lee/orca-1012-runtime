import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { createDurablePool } from '../db/connection.ts'
import { readMigrations } from '../db/migrate.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { createFirstManagedInitialReservationOwner } from './first-managed-initial-owner.ts'
import { inputDigest } from '../runtime/gateway/input.ts'
import { freshObservation, requireInitialFixtureDatabase, seedInitialRevalidation,
  observedInitialPool, addPastGrant, type InitialRevalidationFixture } from './first-managed-initial-fixtures.mts'

// Source-only until Root supplies exact existing isolated SQL23 identity and
// allocates the first PG slot. No DDL/reset/live collector/Pod/provider execution.
const database = process.env.ORCA_INITIAL_REVALIDATION_DATABASE
const oid = process.env.ORCA_INITIAL_REVALIDATION_DATABASE_OID
const system = process.env.ORCA_INITIAL_REVALIDATION_SYSTEM
const migrationsPath = process.env.ORCA_INITIAL_REVALIDATION_MIGRATIONS
if (process.env.ORCA_INITIAL_REVALIDATION_APPROVED !== 'root-first-verification' ||
    !database || database === 'orca_dev' || !/^orca_[a-z0-9_]+$/u.test(database) || database !== process.env.PGDATABASE ||
    !oid || !/^[1-9][0-9]*$/u.test(oid) || !system || !/^[1-9][0-9]*$/u.test(system) || !migrationsPath) {
  throw new Error('Root-approved existing isolated SQL23 database/system/OID/ledger required')
}
const pool = createDurablePool({ database, max: 4, application_name: 'initial-directory-revalidation-first' })
const expected = { database, oid, system }
const seed = () => seedInitialRevalidation(pool, expected)
const signal = () => new AbortController().signal
const held = async (id: string) => (await pool.query('SELECT state FROM durable_runtime.storage_namespace_holds WHERE id=$1', [id])).rows[0]?.state
async function originalPreserved(f: InitialRevalidationFixture, fullBinding: boolean) {
  assert.deepEqual((await pool.query('SELECT to_jsonb(a) AS body FROM durable_runtime.runtime_audit_events a WHERE id=$1',
    [f.input.originalAuditId])).rows[0].body, f.auditBefore)
  const current = (await pool.query('SELECT to_jsonb(b) AS body FROM durable_runtime.storage_bindings b WHERE id=$1', [f.original.bindingId])).rows[0].body
  assert.equal(current.identity_proof_ref, f.bindingBefore.identity_proof_ref)
  assert.equal(current.identity_verified_at, f.bindingBefore.identity_verified_at)
  if (fullBinding) { assert.deepEqual(current, f.bindingBefore) }
}
async function attempts(f: InitialRevalidationFixture) {
  return (await pool.query('SELECT count(*)::text AS count FROM durable_runtime.attempts WHERE runtime_unit_id=$1', [f.original.unitId])).rows[0].count
}
async function auditFor(f: InitialRevalidationFixture) {
  return (await pool.query("SELECT id,session_id,runtime_unit_id,operation_id,next_state FROM durable_runtime.runtime_audit_events WHERE producer_id=$1 AND kind='INITIAL_AGENT_DIRECTORY_REVALIDATED'", [f.input.pinId])).rows
}

await test('first managed initial revalidation: original JSONB scope, fresh tuple, final guard and real settlement', async t => {
  t.after(() => pool.end())
  await requireInitialFixtureDatabase(pool, expected)
  const ledger = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  const migrations = await readMigrations(migrationsPath)
  assert.equal(migrations.length, 23)
  assert.deepEqual(ledger.map(r => [r.version, r.checksum]), migrations.map(r => [r.version, r.checksum]))

  await t.test('exact original JSONB audit survives; fresh audit binds current command and hold lasts through COMMIT', async () => {
    const f = await seed(), fresh = freshObservation(f.f)
    let commitObserved = false
    const observer = observedInitialPool(pool, { beforeFinalCommit: async () => {
      assert.equal(await held(f.input.pinId), 'HELD')
      assert.equal(observer.connects, 3); assert.equal(observer.events.includes('CONNECT4'), false)
      assert.ok(observer.events.includes('CLEANUP2')); commitObserved = true
    } })
    const request = fresh.wire.dependencies.https.request.bind(fresh.wire.dependencies.https)
    const dependencies = { ...fresh.wire.dependencies, https: { request(...args: Parameters<typeof request>) {
      assert.equal(observer.active.size, 0); assert.ok(observer.events.includes('CLEANUP1'))
      return request(...args)
    } } }
    const owner = createFirstManagedInitialReservationOwner(observer.pool, fresh.settings, dependencies)
    const result = await owner.reserveInitialAttempt(f.input, signal())
    assert.equal(result.outcome, 'RESERVED'); assert.equal(result.gate, 'CLOSED'); assert.equal(commitObserved, true)
    assert.equal(result.reservation?.database?.settlement, 'COMMITTED')
    assert.equal(result.reservation?.database?.commitOutcome, 'ACKNOWLEDGED')
    assert.equal(result.reservation?.pins.disposition, 'RELEASED'); assert.equal(result.pin.state, 'RELEASED')
    assert.equal(result.pin.handedOff, true); assert.equal(await held(f.input.pinId), 'RELEASED')
    assert.equal(await held(f.original.pinId), 'RELEASED'); assert.equal(await attempts(f), '1')
    assert.ok(observer.events.indexOf('COMMIT3') < observer.events.indexOf('CONNECT4'))
    assert.equal(observer.connects, 4); assert.equal(observer.active.size, 0); assert.equal(observer.ends, 0)
    assert.equal(result.physicalPinIssued, false); assert.equal(result.namespacePin, false)
    assert.equal(result.providerReady, false); assert.equal(result.writerGrantActivated, false)
    assert.equal(result.kubernetesExecutionAuthorized, false)
    const rows = await auditFor(f); assert.equal(rows.length, 1)
    const row = rows[0], body = row.next_state, claim = f.input.attempt.claim
    assert.notEqual(row.id, f.input.originalAuditId)
    assert.equal(row.session_id, f.input.sessionId); assert.equal(row.runtime_unit_id, f.original.unitId)
    assert.equal(row.operation_id, f.input.context.operationId)
    assert.equal(body.originalAuditId, f.input.originalAuditId); assert.equal(body.originalIdentityRef, f.verified.evidenceRef)
    assert.equal(body.pinId, f.input.pinId); assert.notEqual(body.pinId, f.original.pinId)
    assert.equal(body.qualificationRef, f.f.record.qualificationRef)
    assert.deepEqual(body.originalCandidate, f.auditBefore.next_state.observation.candidate)
    assert.deepEqual(body.observation.candidate, body.originalCandidate)
    assert.equal(body.scope.commandId, claim.commandId); assert.equal(body.scope.planDigest, f.input.attempt.planDigest)
    assert.equal(body.scope.expectedUnitRevision, '0'); assert.equal(body.scope.expectedBindingRevision, '1')
    assert.equal(body.scope.claimDigest, inputDigest({ commandId: claim.commandId, executorId: claim.executorId,
      executionToken: claim.executionToken, controllerTerm: claim.controllerTerm, command: claim.identity.command,
      inputHash: claim.identity.inputHash, originalEnvelope: { ...claim.identity.originalEnvelope } }))
    for (const secret of [f.input.ownerToken, claim.executionToken, f.f.issued, f.f.reviewerToken]) {
      assert.equal(JSON.stringify(result).includes(secret), false); assert.equal(JSON.stringify(row).includes(secret), false)
    }
    assert.equal('retainedOwner' in result.reservation!.pins, false); assert.equal('retainedLease' in result.reservation!.pins, false)
    await originalPreserved(f, false)
    const count = observer.connects, requests = fresh.wire.api.requests.length
    assert.equal((await owner.reserveInitialAttempt(f.input, signal())).errorCode, 'FIRST_MANAGED_INITIAL_ALREADY_ATTEMPTED')
    assert.equal(observer.connects, count); assert.equal(fresh.wire.api.requests.length, requests)
    await fresh.wire.assertCleanup()
  })

  await t.test('changed authenticated leaf inode is preserved and rejected; failed preparation release stays strict', async () => {
    const f = await seed(), fresh = freshObservation(f.f, true), observer = observedInitialPool(pool)
    const owner = createFirstManagedInitialReservationOwner(observer.pool, fresh.settings, fresh.wire.dependencies)
    const result = await owner.reserveInitialAttempt(f.input, signal())
    assert.equal(result.outcome, 'FAILED'); assert.equal(result.phase, 'AUDIT')
    assert.equal(result.observation?.candidate.inode, '401'); assert.equal(f.auditBefore.next_state.observation.candidate.inode, '400')
    assert.ok(result.audit && !result.audit.ok)
    assert.equal(result.audit.error.code, 'INITIAL_DIRECTORY_FULL_TUPLE_CHANGED')
    assert.equal(result.reservation, null); assert.equal(result.pin.failedPreparationReleaseEligible, true)
    assert.equal(await held(f.input.pinId), 'HELD'); assert.equal(await attempts(f), '0')
    assert.equal((await auditFor(f)).length, 0); await originalPreserved(f, true)
    const connects = observer.connects
    await assert.rejects(owner.releaseFailedPreparation({ ...f.input, ownerToken: `fixture-wrong-owner:${randomUUID()}` }),
      error => error instanceof Error && 'code' in error && error.code === 'FIRST_MANAGED_INITIAL_OWNER_MISMATCH')
    assert.equal(observer.connects, connects)
    const released = await owner.releaseFailedPreparation(f.input)
    assert.equal(released.pin.state, 'RELEASED'); assert.equal(await held(f.input.pinId), 'RELEASED')
    assert.equal((await owner.releaseFailedPreparation(f.input)).errorCode, 'FIRST_MANAGED_INITIAL_RELEASE_NOT_ELIGIBLE')
    assert.equal(observer.connects, connects + 1)
    await fresh.wire.assertCleanup()
  })

  for (const mismatch of ['exact-original-audit-missing', 'original-session-scope', 'current-claim-token'] as const) {
    await t.test(`${mismatch} cannot adopt a current binding ref as authority`, async () => {
      const f = await seed(), fresh = freshObservation(f.f), observer = observedInitialPool(pool)
      const owner = createFirstManagedInitialReservationOwner(observer.pool, fresh.settings, fresh.wire.dependencies)
      const input = mismatch === 'exact-original-audit-missing' ? { ...f.input, originalAuditId: randomUUID() } :
        mismatch === 'original-session-scope' ? { ...f.input, sessionId: randomUUID() } :
          { ...f.input, attempt: { ...f.input.attempt, claim: { ...f.input.attempt.claim,
            executionToken: logicalId('runtime-command-execution', randomUUID()) } } }
      const result = await owner.reserveInitialAttempt(input, signal())
      assert.equal(result.outcome, 'FAILED'); assert.equal(result.reservation, null)
      assert.ok(result.audit && !result.audit.ok)
      assert.equal(result.audit.error.code, mismatch === 'exact-original-audit-missing' ? 'INITIAL_DIRECTORY_AUDIT_MISSING' :
        mismatch === 'original-session-scope' ? 'INITIAL_DIRECTORY_ORIGINAL_AUDIT_MISMATCH' : 'INITIAL_AGENT_CLAIM')
      assert.equal((await auditFor(f)).length, 0); assert.equal(await attempts(f), '0')
      await originalPreserved(f, true)
      assert.equal((await owner.releaseFailedPreparation(input)).pin.state, 'RELEASED')
      await fresh.wire.assertCleanup()
    })
  }

  await t.test('a REVOKED grant added after preparation is rejected by final transaction and released after ROLLBACK', async () => {
    const f = await seed(), fresh = freshObservation(f.f)
    const observer = observedInitialPool(pool, { beforeFinalCheckout: async () => {
      assert.equal((await auditFor(f)).length, 1); assert.ok(observer.events.includes('CLEANUP2'))
      assert.equal(await held(f.input.pinId), 'HELD'); await addPastGrant(pool, f)
    } })
    const owner = createFirstManagedInitialReservationOwner(observer.pool, fresh.settings, fresh.wire.dependencies)
    const result = await owner.reserveInitialAttempt(f.input, signal())
    assert.equal(result.outcome, 'FAILED'); assert.equal(result.reservation?.database?.settlement, 'ROLLED_BACK')
    assert.ok(result.reservation?.database && !result.reservation.database.ok)
    assert.equal(result.reservation.database.error.code, 'INITIAL_DIRECTORY_PAST_USE')
    assert.equal(result.reservation.pins.disposition, 'RELEASED'); assert.equal(await held(f.input.pinId), 'RELEASED')
    assert.ok(observer.events.indexOf('ROLLBACK3') < observer.events.indexOf('CONNECT4'))
    assert.equal(await attempts(f), '0'); await originalPreserved(f, true)
    await fresh.wire.assertCleanup()
  })

  for (const mode of ['not-started', 'unconfirmed', 'release-failed'] as const) {
    await t.test(`${mode} preserves the real engine disposition and does not repeat handoff or release`, async () => {
      const f = await seed(), fresh = freshObservation(f.f)
      const observer = observedInitialPool(pool, { rejectConnect: mode === 'not-started' ? 3 : mode === 'release-failed' ? 4 : undefined,
        unknownFinalCommit: mode === 'unconfirmed' })
      const owner = createFirstManagedInitialReservationOwner(observer.pool, fresh.settings, fresh.wire.dependencies)
      const result = await owner.reserveInitialAttempt(f.input, signal())
      assert.equal(result.reservation?.database?.settlement, mode === 'not-started' ? 'NOT_STARTED' : mode === 'unconfirmed' ? 'UNCONFIRMED' : 'COMMITTED')
      assert.equal(result.reservation?.pins.disposition, mode === 'not-started' ? 'RELEASED' : 'RETAINED')
      assert.equal(result.reservation?.pins.reason, mode === 'unconfirmed' ? 'UNCONFIRMED' : mode === 'release-failed' ? 'RELEASE_FAILED' : null)
      assert.equal(result.outcome, mode === 'not-started' ? 'FAILED' : 'RECONCILIATION_REQUIRED')
      assert.equal(await held(f.input.pinId), mode === 'not-started' ? 'RELEASED' : 'HELD')
      assert.equal(await attempts(f), mode === 'not-started' ? '0' : '1')
      assert.equal(observer.connects, mode === 'unconfirmed' ? 3 : 4)
      assert.equal(observer.active.size, 0); assert.equal(observer.ends, 0)
      const connects = observer.connects, requests = fresh.wire.api.requests.length
      assert.equal((await owner.reserveInitialAttempt(f.input, signal())).errorCode, 'FIRST_MANAGED_INITIAL_ALREADY_ATTEMPTED')
      assert.equal((await owner.releaseFailedPreparation(f.input)).errorCode, 'FIRST_MANAGED_INITIAL_RELEASE_NOT_ELIGIBLE')
      assert.equal(observer.connects, connects); assert.equal(fresh.wire.api.requests.length, requests)
      await originalPreserved(f, mode === 'not-started')
      // Unknown final ACK / failed group release leave fixture-owned holds for
      // Root reconciliation. No force release, replay or cleanup hides them.
      await fresh.wire.assertCleanup()
    })
  }

  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
})
