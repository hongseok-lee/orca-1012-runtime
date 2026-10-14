import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { saveAttachmentImage } from '../attachments/store.ts'
import { attachmentUploadId, fingerprintAttachmentPrincipal } from '../attachments/types.ts'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { lockAggregates } from '../db/locks.ts'
import { prepareInputRequest } from '../input/canonical.ts'
import { appendInputComponent } from '../input/append.ts'
import { appendSessionEvent } from '../journal/store.ts'
import { readCommittedSessionJournal, projectCommittedInputIdentity, type VerifiedJournalReadScope } from './index.ts'

// New focused fixture only; never imports/runs the already-passed 5 pure or 6 PG cases.
assert.match(process.env.PGDATABASE ?? '', /^orca_p120_[a-z0-9_]+$/)
const pool = createDurablePool({ max: 3, application_name: 'orca-p120-terminal-media-focused',
  connectionTimeoutMillis: 5000, statement_timeout: 15000 })
after(async () => { await pool.end() })
test('terminal media uses only immutable alias/hash metadata and retains repeated original positions', { concurrency: false }, async () => {
  const principal = fingerprintAttachmentPrincipal('d'.repeat(64))
  const sessionId = logicalId('session', randomUUID()); const workspaceId = logicalId('workspace', randomUUID())
  const agent = randomUUID(); const handle = `p120-terminal:${randomUUID()}`; const publicSessionId = `legacy_${randomUUID().replaceAll('-', '')}`
  // P104's normal writer creates fixture data in the isolated owned DB. The reader never reads these bytes.
  const attachment = await withDurableTransaction(pool, (tx) => saveAttachmentImage(tx, {
    id: attachmentUploadId(randomUUID()), principal, aliasRoot: '/p120-owned-media-fixture',
    contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  }))
  await pool.query(`INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'codex')`, [agent])
  await pool.query(`INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'fixture','READY')`, [workspaceId, randomUUID()])
  await pool.query(`INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle,session_fence) VALUES($1,$2,$3,'OPEN',1)`, [sessionId, agent, workspaceId])
  await pool.query(`INSERT INTO durable_runtime.tabs(id,workspace_id,session_id,kind,terminal_handle,ui_order,lifecycle)
    VALUES($1,$2,$3,'AGENT',$4,0,'OPEN')`, [randomUUID(), workspaceId, sessionId, handle])
  await pool.query(`INSERT INTO durable_runtime.structured_session_aliases(public_session_id,session_id,workspace_id,
    provider,execution_host_id,location,original_create,created_by) VALUES($1,$2,$3,'codex','fixture-host','{}','{}',$4)`,
    [publicSessionId, sessionId, workspaceId, principal])
  const chunks = [{ ingressId: 'original-one', text: '  first\n', attachments: [{ attachmentId: 'repeated' }, { attachmentId: 'repeated' }] },
    { ingressId: 'original-two', text: ' second  ', attachments: [{ attachmentId: 'repeated' }] }]
  const payload = { version: 1, text: chunks.map((chunk) => chunk.text).join(''), chunks,
    wire: { version: 1, source: 'UNARY', terminal: handle, action: { text: '\r', enter: false,
      interrupt: false, inputKind: null, expectedIncarnationId: null, agentPrompt: false, resolvedLaunchDraft: null },
    inputBytes: null, attachments: [] }, originalIngressId: 'original-cr' }
  const originalAttachments = Array.from({ length: 3 }, () => ({ aliasPath: attachment.aliasPath, contentHash: attachment.contentHash }))
  const prepared = prepareInputRequest({ authority: { principal, sessionId, scope: { kind: 'TERMINAL', terminalHandle: handle } },
    method: 'terminal.send', operationKey: JSON.stringify(['UNARY', 'original-connection', 'original-rpc']),
    inputKind: 'GENERAL', sessionFence: counter('session-fence', '1'), payload, attachments: originalAttachments })
  const appended = await withDurableTransaction(pool, async (tx) => {
    await lockAggregates(tx, { sessionIds: [sessionId] })
    const input = await appendInputComponent(tx, prepared)
    await appendSessionEvent(tx, { sessionId, source: { kind: 'PRODUCER', sourceKind: 'INPUT_SUBMISSION',
      producerId: sessionId, incarnation: 'durable-input-v1', producerSeq: counter('sequence:producer', input.inputSequence) },
    body: { kind: 'INPUT_SUBMISSION', ...input, originalPayloadHash: prepared.identity.payloadHash } })
    return input
  })
  const statements: string[] = []
  const readPool = { async connect() {
    const client = await pool.connect(); const query = client.query.bind(client)
    return { query: (sql: string, values?: unknown[]) => { statements.push(sql); return query(sql, values) },
      release: client.release.bind(client) } as unknown as PoolClient
  } } as unknown as Pool
  const scope = { principal, sessionId, workspaceId, publicSessionId } as VerifiedJournalReadScope
  const page = await readCommittedSessionJournal(readPool, scope, {})
  assert.equal(page.kind, 'PAGE')
  if (page.kind !== 'PAGE') { return }
  assert.deepEqual(page.inputs[0].original, prepared.original)
  assert.deepEqual(page.inputs[0].attachments.map((x) => ({ position: x.position, aliasPath: x.aliasPath,
    contentHash: x.contentHash, mediaType: x.mediaType, aliasPrincipal: x.aliasPrincipal })),
  originalAttachments.map((x, i) => ({ ...x, position: String(i), mediaType: 'image/png', aliasPrincipal: principal })))
  const projected = projectCommittedInputIdentity(page)
  assert.equal(projected.items[0].itemId, `input:${appended.inputId}`)
  assert.deepEqual(projected.items[0].body, { kind: 'message', role: 'user', blocks: [
    { type: 'text', text: chunks[0].text }, { type: 'image-ref', path: attachment.aliasPath },
    { type: 'image-ref', path: attachment.aliasPath }, { type: 'text', text: chunks[1].text }, { type: 'image-ref', path: attachment.aliasPath }
  ] })
  assert.deepEqual(projected.submissions, [])
  assert.ok(statements.some((sql) => sql.includes('b.media_type') && sql.includes('attachment_aliases')))
  assert.ok(statements.every((sql) => !sql.includes('content_bytes') && !/\b(INSERT|UPDATE|DELETE)\b/.test(sql)))
})
