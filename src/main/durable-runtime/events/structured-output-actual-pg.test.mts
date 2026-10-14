import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { JsonValue } from '../db/atomic.ts'
import { createDurablePool } from '../db/connection.ts'
import { readMigrations } from '../db/migrate.ts'
import type { VerifiedWorkloadIdentity } from '../runtime/runtime-evidence.ts'
import type { ConsumerAuthority, EventClaim } from './types.ts'
import { registerEventProducer, enqueueRuntimeEvent, claimRuntimeEvent, processRuntimeEvent } from './store.ts'
import { structuredOutputEventHandler } from './structured-output.ts'

// Future root-assigned isolated DB only; this source does not apply migrations.
assert.match(process.env.PGDATABASE ?? '', /^orca_p120_[a-z0-9_]+$/)
const pool = createDurablePool({ max: 3, application_name: 'orca-p120-structured-output-fixture',
  connectionTimeoutMillis: 5000, statement_timeout: 15000 })
let ledger: unknown[] = []
const cases: string[] = []
before(async () => {
  assert.ok(process.env.P120_MIGRATIONS, 'root-pinned SQL input directory is required')
  const expected = await readMigrations(process.env.P120_MIGRATIONS)
  assert.equal(expected.length, 19)
  const actual = await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')
  assert.deepEqual(actual.rows.map(({ version, checksum }) => ({ version, checksum })),
    expected.map(({ version, checksum }) => ({ version, checksum })))
  ledger = actual.rows
})
after(async () => {
  try {
    const afterLedger = await pool.query('SELECT version,checksum,applied_at FROM durable_runtime.schema_migrations ORDER BY version')
    assert.deepEqual(afterLedger.rows, ledger)
    if (process.env.P120_SAFE_RESULTS) {
      await writeFile(process.env.P120_SAFE_RESULTS, JSON.stringify({ sourceRevision: process.env.P120_SOURCE_REVISION,
        baseRevision: 'c3adbe6cc1b49b01b1ecbc8684e8c3eb0f2bd146', cases,
        schemaAppliedByFixture: false, syntheticProviderPayload: true,
        workloadAuthenticationVerified: false, cliOutputVerified: false, startupWired: false,
        crossIncarnationNativeDedupVerified: false, publicationVerified: false }, null, 2), { mode: 0o600 })
    }
  } finally { await pool.end() }
})
async function seed() {
  const agentId = logicalId('agent', randomUUID()), workspace = randomUUID()
  const runtimeUnitId = logicalId('runtime-unit', randomUUID()), attemptId = logicalId('attempt', randomUUID())
  const sessions = [logicalId('session', randomUUID()), logicalId('session', randomUUID())].sort()
  const storage = randomUUID(), producerId = logicalId('producer', randomUUID())
  const incarnation = `fixture-${randomUUID()}`, podUid = `fixture-${randomUUID()}`
  const publicSessionId = `fixture_${randomUUID().replaceAll('-', '')}`
  const authority: ConsumerAuthority = { scope: `structured-output-${randomUUID()}`, owner: 'fixture-controller', term: counter('controller-term', '1') }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'claude')", [agentId])
    await client.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'fixture','READY')", [workspace, randomUUID()])
    await client.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase,execution_epoch) VALUES($1,'SUSPENDED','ABSENT',1)", [runtimeUnitId])
    await client.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision,updated_at) VALUES($1,0,'{}',0,clock_timestamp())", [runtimeUnitId])
    await client.query("INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,resource_profile_revision,effective_resources,status) VALUES($1,$2,1,'COLD',$3,$4,0,'{}','STOPPED')", [attemptId, runtimeUnitId, podUid, incarnation])
    await client.query("INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,'fixture-export')", [storage])
    await client.query("INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state) VALUES($1,$2,'fixture-export','/fixture','RO')", [storage, storage])
    for (const sessionId of sessions) {
      await client.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'CLOSED')", [sessionId, agentId, workspace])
      await client.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)', [runtimeUnitId, sessionId, storage])
    }
    await client.query("INSERT INTO durable_runtime.structured_session_aliases(public_session_id,session_id,workspace_id,provider,execution_host_id,location,original_create,created_by) VALUES($1,$2,$3,'claude','fixture-host','{}','{}','fixture-only')", [publicSessionId, sessions[0], workspace])
    await client.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,$2,1,clock_timestamp()+interval '5 minutes')", [authority.scope, authority.owner])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  // SAFETY: isolated synthetic fixture only; this cast supplies no authentication evidence.
  const workload = { attemptId, producerId, incarnation, podUid, executionEpoch: counter('execution-epoch', '1'),
    principalRef: 'fixture-not-authenticated', authenticationEvidenceRef: 'fixture-not-auth-proof' } as unknown as VerifiedWorkloadIdentity
  const producer = { workload, agentId, runtimeUnitId }
  await registerEventProducer(pool, producer)
  return { producer, stream: { producerId, incarnation: workload.incarnation }, authority, sessions, publicSessionId }
}
type Fixture = Awaited<ReturnType<typeof seed>>
function payload(f: Fixture): JsonValue {
  return { version: 1, kind: 'STRUCTURED_PROVIDER_OUTPUT', publicSessionId: f.publicSessionId, provider: 'claude',
    observedAt: '2026-10-14T13:33:00.000Z', source: { kind: 'PRODUCER' },
    mutation: { kind: 'item', itemId: 'provider-item-1', revision: 1,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'synthetic output' }] } } }
}
async function enqueueClaim(f: Fixture, sequence: number, body: JsonValue, targets = [f.sessions[0]]): Promise<EventClaim> {
  await enqueueRuntimeEvent(pool, f.producer, { eventId: logicalId('event', randomUUID()),
    sequence: counter('sequence:producer', String(sequence)), payload: body, targetSessionIds: targets })
  const result = await claimRuntimeEvent(pool, f.stream, f.authority, { claimDurationMs: 60000 })
  if (result.status !== 'CLAIMED') { assert.fail(`expected CLAIMED, got ${result.status}`) }
  return result.claim
}
async function outputs(f: Fixture) {
  return (await pool.query(`SELECT j.event_id,j.seq,j.body,j.source_key,o.id AS outbox_id,o.revision,
    o.event,j.xmin::text AS journal_xid,o.xmin::text AS outbox_xid
    FROM durable_runtime.session_events j JOIN durable_runtime.outbox_events o ON o.id=j.event_id
    WHERE j.session_id=$1 AND j.body->>'kind'='STRUCTURED_PROVIDER_OUTPUT' ORDER BY j.seq`, [f.sessions[0]])).rows
}
test('actual PG: structured output/outbox/DONE commit, replay/conflict and rejected target/body rollback', { concurrency: false }, async () => {
  const f = await seed(), original = payload(f)
  const first = await enqueueClaim(f, 1, original)
  // The original accepted event survives a changed current epoch and closed Session.
  await pool.query('UPDATE durable_runtime.runtime_units SET execution_epoch=2 WHERE id=$1', [f.producer.runtimeUnitId])
  const done = await processRuntimeEvent(pool, first, structuredOutputEventHandler)
  assert.equal(done.status, 'DONE')
  const rows = await outputs(f)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].body, original)
  assert.deepEqual(rows[0].event, original)
  assert.equal(rows[0].event_id, rows[0].outbox_id)
  assert.equal(rows[0].seq, rows[0].revision)
  assert.equal(rows[0].journal_xid, rows[0].outbox_xid)
  assert.deepEqual(JSON.parse(rows[0].source_key), ['v1', f.sessions[0], 'producer', 'STRUCTURED_PROVIDER_OUTPUT',
    f.stream.producerId, f.stream.incarnation, '1'])
  const committed = await pool.query(`SELECT q.state,q.xmin::text AS queue_xid,r.xmin::text AS receipt_xid
    FROM durable_runtime.runtime_event_queue q JOIN durable_runtime.rpc_receipts r
    ON r.session_scope='runtime-event:'||q.event_id::text AND r.operation_key=$2 AND r.method='runtime-event.process'
    WHERE q.event_id=$1`, [first.eventId, first.token])
  assert.equal(committed.rows[0].state, 'DONE')
  assert.equal(committed.rows[0].queue_xid, rows[0].journal_xid)
  assert.equal(committed.rows[0].receipt_xid, rows[0].journal_xid)
  assert.equal((await pool.query('SELECT lifecycle FROM durable_runtime.sessions WHERE id=$1', [f.sessions[0]])).rows[0].lifecycle, 'CLOSED')
  assert.equal((await processRuntimeEvent(pool, first, structuredOutputEventHandler)).status, 'DONE')
  assert.deepEqual(await outputs(f), rows)
  const native: JsonValue = { ...JSON.parse(JSON.stringify(original)), source: { kind: 'NATIVE', lineage: 'original-lineage', nativeEventId: 'original-event-17' } }
  const second = await enqueueClaim(f, 2, native)
  assert.equal((await processRuntimeEvent(pool, second, structuredOutputEventHandler)).status, 'DONE')
  const nativeRows = await outputs(f)
  const third = await enqueueClaim(f, 3, native)
  assert.equal((await processRuntimeEvent(pool, third, structuredOutputEventHandler)).status, 'DONE')
  assert.deepEqual(await outputs(f), nativeRows)
  const changed: JsonValue = { ...JSON.parse(JSON.stringify(native)), mutation: { kind: 'tombstone', itemId: 'provider-item-1', revision: 2 } }
  const conflict = await enqueueClaim(f, 4, changed)
  assert.equal((await processRuntimeEvent(pool, conflict, structuredOutputEventHandler)).status, 'RETRY')
  assert.deepEqual(await outputs(f), nativeRows)
  assert.equal((await pool.query('SELECT last_error FROM durable_runtime.runtime_event_queue WHERE event_id=$1', [conflict.eventId])).rows[0].last_error, 'JOURNAL_SOURCE_CONFLICT')
  for (const invalid of ['foreign-target', 'malformed-body']) {
    const bad = await seed()
    const body: JsonValue = invalid === 'foreign-target' ? payload(bad) : { ...JSON.parse(JSON.stringify(payload(bad))), mutation: { kind: 'item', itemId: 'i', revision: 1,
      body: { kind: 'question', question: 'q', options: null } } }
    const claim = await enqueueClaim(bad, 1, body, [bad.sessions[invalid === 'foreign-target' ? 1 : 0]])
    assert.equal((await processRuntimeEvent(pool, claim, structuredOutputEventHandler)).status, 'RETRY')
    assert.equal((await pool.query('SELECT count(*) FROM durable_runtime.session_events WHERE session_id=ANY($1::uuid[])', [bad.sessions])).rows[0].count, '0')
    assert.equal((await pool.query('SELECT count(*) FROM durable_runtime.outbox_events WHERE aggregate_id=ANY($1::text[])', [bad.sessions])).rows[0].count, '0')
    assert.equal((await pool.query("SELECT count(*) FROM durable_runtime.rpc_receipts WHERE session_scope=$1 AND method='runtime-event.process'", [`runtime-event:${claim.eventId}`])).rows[0].count, '0')
    const state = await pool.query('SELECT state,last_error FROM durable_runtime.runtime_event_queue WHERE event_id=$1', [claim.eventId])
    assert.equal(state.rows[0].state, 'RETRY')
    assert.equal(state.rows[0].last_error, invalid === 'foreign-target' ? 'STRUCTURED_OUTPUT_ALIAS_SCOPE' : 'STRUCTURED_OUTPUT_BODY')
  }
  cases.push('canonical output/outbox/DONE commit; same source replay; conflict; foreign target and malformed rollback')
})
