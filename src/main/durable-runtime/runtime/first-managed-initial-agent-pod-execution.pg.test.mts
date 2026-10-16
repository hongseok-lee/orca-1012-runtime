import assert from 'node:assert/strict'
import test from 'node:test'
import { createDurablePool } from '../db/connection.ts'
import { AgentPodCreateError } from '../lifecycle/agent-pod-create.ts'
import { freshObservation, observedInitialPool, requireInitialFixtureDatabase,
  seedInitialRevalidation } from '../storage/first-managed-initial-fixtures.mts'
import type { ManagedLeafCollectorDependencies } from '../storage/managed-leaf-collector-types.ts'
import { harness, reviewerToken } from './kubernetes-pod-auth-fixtures.mts'
import { createFirstManagedInitialAgentPodExecution } from './initial-agent-pod-execution.ts'

// Only the new factory composition. Original owners and real DB helpers are
// consumed directly; HTTPS/collector transports and qualification are synthetic.
const database = process.env.ORCA_FIRST_MANAGED_INITIAL_POD_DATABASE
const oid = process.env.ORCA_FIRST_MANAGED_INITIAL_POD_DATABASE_OID
const system = process.env.ORCA_FIRST_MANAGED_INITIAL_POD_SYSTEM
if (process.env.ORCA_FIRST_MANAGED_INITIAL_POD_APPROVED !== 'root-first-verification' ||
    !database || database === 'orca_dev' || !/^orca_[a-z0-9_]+$/u.test(database) || database !== process.env.PGDATABASE ||
    !oid || !/^[1-9][0-9]*$/u.test(oid) || !system || !/^[1-9][0-9]*$/u.test(system)) {
  throw new Error('Root-approved existing isolated SQL23 identity required')
}
const pool = createDurablePool({ database, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 5000,
  application_name: 'first-managed-initial-pod-connection' })
const expected = { database, oid, system }
type Seed = Awaited<ReturnType<typeof seedInitialRevalidation>>
type Fresh = ReturnType<typeof freshObservation>
function compose(f: Seed, fresh: Fresh, observer: ReturnType<typeof observedInitialPool>,
  dependencies: ManagedLeafCollectorDependencies = fresh.wire.dependencies) {
  const podHttp = harness([])
  const executor = createFirstManagedInitialAgentPodExecution({ pool: observer.pool, firstManagedDirectory: fresh.settings,
    podConfig: { apiOrigin: 'https://kubernetes.invalid:6443', ca: Buffer.from('synthetic-pod-ca'),
      namespace: f.plan.pod.metadata.namespace, dataset: f.f.record.profile.datasetName, timeoutMs: 1000,
      readBearerToken: () => reviewerToken } }, podHttp.transport, dependencies)
  return { executor, podHttp }
}
async function originalAudit(f: Seed) {
  assert.deepEqual((await pool.query('SELECT to_jsonb(a) AS body FROM durable_runtime.runtime_audit_events a WHERE id=$1',
    [f.input.originalAuditId])).rows[0].body, f.auditBefore)
}

test('fresh managed initial Pod factory keeps failed preparation and abort closed', async t => {
  t.after(() => pool.end())
  await requireInitialFixtureDatabase(pool, expected)
  const ledger = (await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows
  assert.equal(ledger.length, 23)

  await t.test('actual authenticated tuple mismatch reaches no Pod request', async () => {
    const f = await seedInitialRevalidation(pool, expected), fresh = freshObservation(f.f, true)
    const observer = observedInitialPool(pool), { executor, podHttp } = compose(f, fresh, observer)
    const result = await executor.start({ ...f.input, remainingMs: 60000 }, new AbortController().signal)
    assert.equal(result.preparation.outcome, 'FAILED'); assert.equal(result.preparation.phase, 'AUDIT')
    assert.equal(result.preparation.reservation, null); assert.equal(result.execution, null)
    assert.equal(podHttp.requests.length, 0); assert.equal(observer.active.size, 0); assert.equal(observer.ends, 0)
    await originalAudit(f); await fresh.wire.assertCleanup()
    // A definite failed-preparation hold remains with the real private owner.
    // No raw token/retained capability, forced release or success callback is used.
  })

  await t.test('actual credential transport failure cannot become preparation success', async () => {
    const f = await seedInitialRevalidation(pool, expected), fresh = freshObservation(f.f)
    const failedCredential = harness([{ errorCode: 'ECONNRESET' }])
    const observer = observedInitialPool(pool)
    const { executor, podHttp } = compose(f, fresh, observer,
      { ...fresh.wire.dependencies, https: failedCredential.transport })
    const result = await executor.start({ ...f.input, remainingMs: 60000 }, new AbortController().signal)
    assert.equal(result.preparation.phase, 'COLLECT'); assert.notEqual(result.preparation.outcome, 'RESERVED')
    assert.equal(result.preparation.reservation, null); assert.equal(result.execution, null)
    assert.equal(podHttp.requests.length, 0); assert.equal(failedCredential.requests.length, 1)
    assert.equal(observer.active.size, 0); assert.equal(observer.ends, 0)
    await originalAudit(f); failedCredential.assertCleanup(); await fresh.wire.assertCleanup()
  })

  for (const mode of ['unconfirmed', 'release-failed'] as const) {
    await t.test(`${mode} real reservation result cannot enter Pod transport`, async () => {
      const f = await seedInitialRevalidation(pool, expected), fresh = freshObservation(f.f)
      const observer = observedInitialPool(pool, { unknownFinalCommit: mode === 'unconfirmed',
        rejectConnect: mode === 'release-failed' ? 4 : undefined })
      const { executor, podHttp } = compose(f, fresh, observer)
      const result = await executor.start({ ...f.input, remainingMs: 60000 }, new AbortController().signal)
      assert.equal(result.preparation.outcome, 'RECONCILIATION_REQUIRED'); assert.equal(result.execution, null)
      assert.equal(result.preparation.reservation?.database?.settlement, mode === 'unconfirmed' ? 'UNCONFIRMED' : 'COMMITTED')
      assert.equal(result.preparation.reservation?.pins.disposition, 'RETAINED')
      assert.equal(podHttp.requests.length, 0); assert.equal(observer.active.size, 0); assert.equal(observer.ends, 0)
      await originalAudit(f); await fresh.wire.assertCleanup()
      // Preserve fixture-owned uncertain/release-failed holds for reconciliation;
      // never hide them with automatic release/retry or a new pin.
    })
  }

  await t.test('already-aborted caller starts neither preparation nor Pod HTTP', async () => {
    const f = await seedInitialRevalidation(pool, expected), fresh = freshObservation(f.f)
    const observer = observedInitialPool(pool), { executor, podHttp } = compose(f, fresh, observer)
    const controller = new AbortController(); controller.abort()
    await assert.rejects(executor.start({ ...f.input, remainingMs: 60000 }, controller.signal),
      error => error instanceof AgentPodCreateError && error.code === 'ABORTED')
    assert.equal(observer.connects, 0); assert.equal(observer.active.size, 0)
    assert.equal(podHttp.requests.length, 0); assert.equal(fresh.wire.api.requests.length, 0)
    await originalAudit(f); await fresh.wire.assertCleanup()
  })

  assert.deepEqual((await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')).rows, ledger)
})
