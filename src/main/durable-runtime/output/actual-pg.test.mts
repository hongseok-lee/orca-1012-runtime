import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type { Pool, PoolClient } from 'pg'
import { createDurablePool, DurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { prepareInputRequest } from '../input/canonical.ts'
import { appendInputComponent } from '../input/append.ts'
import { appendSessionEvent } from '../journal/store.ts'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import { fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation.ts'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key.ts'
import { readCommittedSessionJournal, projectCommittedInputIdentity, type VerifiedJournalReadScope } from './index.ts'

assert.match(process.env.PGDATABASE ?? '', /^orca_p120_[a-z0-9_]+$/)
const pool = createDurablePool({ max: 6, application_name: 'orca-p120-journal-first-fixtures',
  connectionTimeoutMillis: 5000, statement_timeout: 15000 })
const principal = fingerprintAttachmentPrincipal('a'.repeat(64))
const other = fingerprintAttachmentPrincipal('b'.repeat(64))
const cases: string[] = []
before(async () => {
  // Schema is an explicit handoff premise. No fixture DDL or dev migration application.
  const result = await pool.query(`SELECT to_regclass('durable_runtime.structured_session_aliases') AS aliases,
    to_regclass('durable_runtime.structured_submissions') AS submissions`)
  assert.ok(result.rows[0].aliases && result.rows[0].submissions, 'exact 017 schema handoff is required')
})
after(async () => {
  try {
    if (process.env.P120_SAFE_RESULTS) { await writeFile(process.env.P120_SAFE_RESULTS, JSON.stringify({
      recordedAt: new Date().toISOString(), sourceRevision: process.env.P120_SOURCE_REVISION,
      baseRevision: '02bfba1aa971d9449cad41103211e8a3d3503451',
      schema017Revision: 'a24db99ed3184bb9cbd3b7fe70f8c85bfea8bf37',
      inputRevision: '4d1cabbc93ea33289a708196951b8d2a92a1bfdf', cases,
      schemaAppliedByFixture: false, upperAuthenticationVerified: false, publicHandlerConnected: false,
      providerEchoAliased: false, physicalAuthenticationVerified: false
    }, null, 2), { mode: 0o600 }) }
  } finally { await pool.end() }
})
function check(name: string, run: () => Promise<void>) {
  test(name, { concurrency: false }, async () => { await run(); cases.push(name) })
}
async function seed(): Promise<VerifiedJournalReadScope> {
  const sessionId = logicalId('session', randomUUID())
  const workspaceId = logicalId('workspace', randomUUID())
  const agentId = randomUUID()
  const publicSessionId = `session_${randomUUID().replaceAll('-', '')}`
  await pool.query(`INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'codex')`, [agentId])
  await pool.query(`INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'fixture','READY')`, [workspaceId, randomUUID()])
  await pool.query(`INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle,session_fence) VALUES($1,$2,$3,'OPEN',1)`, [sessionId, agentId, workspaceId])
  await pool.query(`INSERT INTO durable_runtime.structured_session_aliases(public_session_id,session_id,workspace_id,
    provider,execution_host_id,location,original_create,created_by) VALUES($1,$2,$3,'codex','fixture-host','{}','{}',$4)`,
    [publicSessionId, sessionId, workspaceId, other])
  // Test-only brand. Alias created_by differs deliberately; upper authorization is a fixture premise.
  return { principal, publicSessionId, sessionId, workspaceId } as VerifiedJournalReadScope
}
async function input(client: PoolClient, scope: VerifiedJournalReadScope, sender = principal, key: string = randomUUID(), structured = true) {
  const tx = new DurableTransaction(client)
  await lockAggregates(tx, { sessionIds: [scope.sessionId] })
  const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: '  exact original\n' }] }
  const prepared = prepareInputRequest({ authority: { principal: sender, sessionId: scope.sessionId, scope: { kind: 'SESSION' } },
    method: 'agentSession.send', operationKey: key, inputKind: 'GENERAL', sessionFence: counter('session-fence', '1'),
    payload: { body }, attachments: [] })
  const appended = await appendInputComponent(tx, prepared)
  const event = await appendSessionEvent(tx, { sessionId: scope.sessionId,
    source: { kind: 'PRODUCER', sourceKind: 'INPUT_SUBMISSION', producerId: scope.sessionId,
      incarnation: 'durable-input-v1', producerSeq: counter('sequence:producer', appended.inputSequence) },
    body: { kind: 'INPUT_SUBMISSION', ...appended, originalPayloadHash: prepared.identity.payloadHash } })
  if (structured) {
    await client.query(`INSERT INTO durable_runtime.structured_submissions(input_id,message_id,session_id,principal_id,
      client_message_id,wire_payload_fingerprint,wire_fence,journal_epoch,journal_sequence,submitted_at)
      VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9)`, [appended.inputId, appended.messageId, scope.sessionId, sender, key,
      structuredAgentSessionPayloadFingerprint({ method: 'agentSession.send', sessionId: scope.publicSessionId, fields: { body } }),
      event.journalEpoch, event.sequence, event.recordedAt])
  }
  tx.close()
  return { ...appended, key }
}
async function commitInput(scope: VerifiedJournalReadScope, sender = principal, key: string = randomUUID(), structured = true) {
  const client = await pool.connect()
  try { await client.query('BEGIN'); const result = await input(client, scope, sender, key, structured); await client.query('COMMIT'); return result }
  catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}
check('commit becomes visible; uncommitted and rolled-back original input does not', async () => {
  const scope = await seed()
  const client = await pool.connect()
  try {
    await client.query('BEGIN'); await input(client, scope)
    const pending = await readCommittedSessionJournal(pool, scope, {})
    assert.equal(pending.kind, 'PAGE')
    if (pending.kind === 'PAGE') { assert.equal(pending.events.length, 0); assert.equal(pending.head.sequence, 0) }
    await client.query('COMMIT')
    const committed = await readCommittedSessionJournal(pool, scope, {})
    assert.equal(committed.kind, 'PAGE')
    if (committed.kind === 'PAGE') { assert.equal(committed.inputs.length, 1); assert.equal(committed.events.length, 1) }
    await client.query('BEGIN'); await input(client, scope); await client.query('ROLLBACK')
    assert.deepEqual(await readCommittedSessionJournal(pool, scope, {}), committed)
  } finally { client.release() }
})
check('REPEATABLE READ head and page cursor remain on one snapshot across concurrent commit', async () => {
  const scope = await seed()
  await commitInput(scope)
  const wrapper = { async connect() {
    const client = await pool.connect()
    const query = client.query.bind(client)
    const proxy = { query: async (sql: string, values?: unknown[]) => {
      const result = await query(sql, values)
      if (sql.includes('structured_session_aliases')) { await commitInput(scope) }
      return result
    }, release: client.release.bind(client) }
    return proxy as unknown as PoolClient
  } } as unknown as Pool
  const first = await readCommittedSessionJournal(wrapper, scope, { limit: 1 })
  assert.equal(first.kind, 'PAGE')
  if (first.kind !== 'PAGE') { return }
  assert.equal(first.head.sequence, 1); assert.equal(first.cursor.sequence, 1); assert.equal(first.hasMore, false)
  const second = await readCommittedSessionJournal(pool, scope, { limit: 1 })
  assert.equal(second.kind, 'PAGE')
  if (second.kind !== 'PAGE') { return }
  assert.equal(second.head.sequence, 2); assert.equal(second.cursor.sequence, 1); assert.equal(second.hasMore, true)
  const next = await readCommittedSessionJournal(pool, scope, { cursor: second.cursor })
  assert.equal(next.kind, 'PAGE')
  if (next.kind === 'PAGE') { assert.deepEqual(next.events.map((event) => event.sequence), [2]); assert.equal(next.cursor.sequence, 2) }
})
check('own receipt identity, other principal same key, legacy and same-body different op remain separate', async () => {
  const scope = await seed()
  await commitInput(scope, principal, 'same-key')
  const foreign = await commitInput(scope, other, 'same-key')
  const legacy = await commitInput(scope, principal, 'legacy-key', false)
  await commitInput(scope, principal, 'other-op')
  const page = await readCommittedSessionJournal(pool, scope, {})
  assert.equal(page.kind, 'PAGE')
  if (page.kind !== 'PAGE') { return }
  const projected = projectCommittedInputIdentity(page)
  assert.deepEqual(projected.items.map((item) => item.itemId), [agentJournalSubmissionKey('same-key'), `input:${foreign.inputId}`,
    `input:${legacy.inputId}`, agentJournalSubmissionKey('other-op')])
  assert.equal(projected.submissions.length, 2)
  assert.equal(projected.items.length, 4)
  assert.deepEqual(projected.items[0].body, projected.items[1].body)
})
check('Pod-zero and actual attempt metadata replacement keep journal epoch and reads have no effects', async () => {
  const scope = await seed()
  await commitInput(scope)
  await pool.query(`UPDATE durable_runtime.sessions SET lifecycle='CLOSED' WHERE id=$1`, [scope.sessionId])
  const unit = randomUUID(); const binding = randomUUID()
  await pool.query(`INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'SUSPENDED','ABSENT')`, [unit])
  await pool.query(`INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision)
    VALUES($1,0,'{}',0)`, [unit])
  await pool.query(`INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$1)`, [unit])
  await pool.query(`INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state)
    VALUES($1,$2,$2,'/fixture-only','UNVERIFIED')`, [binding, unit])
  await pool.query(`INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)`, [unit, scope.sessionId, binding])
  const baseline = await readCommittedSessionJournal(pool, scope, {})
  for (const epoch of [1, 2]) {
    const attempt = randomUUID()
    await pool.query(`INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,resource_profile_revision,
      effective_resources,status,pod_uid) VALUES($1,$2,$3,'COLD',0,'{}','FIXTURE_STOPPED',$4)`, [attempt, unit, epoch, `fixture-pod-${epoch}`])
    await pool.query(`UPDATE durable_runtime.runtime_units SET execution_epoch=$2,active_attempt_id=$3 WHERE id=$1`, [unit, epoch, attempt])
    assert.deepEqual(await readCommittedSessionJournal(pool, scope, {}), baseline)
  }
  const state = async () => (await pool.query(`SELECT to_jsonb(s) AS session,to_jsonb(u) AS unit,
    (SELECT count(*)::text FROM durable_runtime.rpc_receipts) AS receipts,
    (SELECT count(*)::text FROM durable_runtime.outbox_events) AS outbox
    FROM durable_runtime.sessions s JOIN durable_runtime.runtime_members m ON m.session_id=s.id
    JOIN durable_runtime.runtime_units u ON u.id=m.runtime_unit_id WHERE s.id=$1`, [scope.sessionId])).rows
  const before = await state()
  await readCommittedSessionJournal(pool, scope, {})
  assert.deepEqual(await state(), before)
})
check('raw unknown kinds count toward continuity; prefix, middle gap, ahead and epoch resets are distinct', async () => {
  async function rows(sequences: number[]) {
    const scope = await seed()
    for (const sequence of sequences) { await pool.query(`INSERT INTO durable_runtime.session_events(session_id,journal_epoch,seq,event_id,source_key,body)
      VALUES($1,0,$2,$3,$4,$5)`, [scope.sessionId, sequence, randomUUID(), `fixture:${scope.sessionId}:${sequence}`, { kind: 'FUTURE_KIND', version: 99 }]) }
    await pool.query('UPDATE durable_runtime.sessions SET next_event_seq=$2 WHERE id=$1', [scope.sessionId, sequences.at(-1)! + 1])
    return scope
  }
  const contiguous = await rows([1, 2])
  const raw = await readCommittedSessionJournal(pool, contiguous, {})
  assert.equal(raw.kind, 'PAGE')
  if (raw.kind === 'PAGE') { assert.equal(raw.events.length, 2); assert.equal(projectCommittedInputIdentity(raw).unprojectedEvents.length, 2) }
  const gap = await readCommittedSessionJournal(pool, await rows([1, 3]), {})
  assert.equal(gap.kind === 'RESET' && gap.reason, 'journal_gap')
  // Existing retention-shaped prefix, not deletion/retention policy implemented by this reader.
  const prefix = await readCommittedSessionJournal(pool, await rows([3]), {})
  assert.equal(prefix.kind === 'RESET' && prefix.reason, 'cursor_compacted')
  const ahead = await readCommittedSessionJournal(pool, contiguous, { cursor: { epoch: '0', sequence: 3 } })
  assert.equal(ahead.kind === 'RESET' && ahead.reason, 'cursor_ahead')
  const changed = await readCommittedSessionJournal(pool, contiguous, { cursor: { epoch: '1', sequence: 0 } })
  assert.equal(changed.kind === 'RESET' && changed.reason, 'epoch_changed')
})
check('alias mismatch and real PG query error are errors rather than empty history', async () => {
  const scope = await seed()
  await assert.rejects(readCommittedSessionJournal(pool, { ...scope, workspaceId: logicalId('workspace', randomUUID()) }, {}), { code: 'JOURNAL_ALIAS_MISMATCH' })
  const wrapper = { async connect() {
    const client = await pool.connect(); const query = client.query.bind(client)
    return { query: (sql: string, values?: unknown[]) => sql.includes('structured_session_aliases')
      ? query('SELECT * FROM durable_runtime.p120_deliberately_missing_relation') : query(sql, values),
      release: client.release.bind(client) } as unknown as PoolClient
  } } as unknown as Pool
  await assert.rejects(readCommittedSessionJournal(wrapper, scope, {}), { code: '42P01' })
})
