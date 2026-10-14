import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { withDurableTransaction } from '../db/connection.ts'
import { readMigrations } from '../db/migrate.ts'
import { fileURLToPath } from 'node:url'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection.ts'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { recordUnitIntent } from '../lifecycle/intent.ts'
import { reserveSleep } from '../lifecycle/sleep.ts'
import { recordInputCancel } from '../input/cancel.ts'
import { inspectCatalogMembership } from '../catalog/membership.ts'
import type { CatalogAuthority } from '../catalog/authority.ts'
import type { UnitIntentAuthority } from '../lifecycle/types.ts'
import { pairedDeviceAttachmentPrincipal } from '../attachments/types.ts'
import type { JsonSnapshot } from './snapshot.ts'
import { prepareStructuredWire } from './wire.ts'
import type { VerifiedStructuredAuthentication, VerifiedStructuredTargetAccess } from './authority.ts'
import type { DurableStructuredCreateCall, DurableStructuredSendCall, VerifiedStructuredAttachmentResolution } from './durable-types.ts'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'

// Synthetic authorities below are fixture inputs only. No authentication issuer,
// provider, native binding, public handler, filesystem or Pod is exercised here.
export const owners = { recordUnitIntent, reserveSleep, recordInputCancel }
export const capabilities = [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY, AGENT_SESSION_PENDING_SEND_RESULT_RUNTIME_CAPABILITY]
export const sql = (pool: Pool, text: string, values: readonly unknown[] = []) =>
  withDurableTransaction(pool, tx => tx.query(text, values))
export function device() {
  const id = randomUUID()
  return { id, principal: pairedDeviceAttachmentPrincipal(id) }
}
export type FixtureDevice = ReturnType<typeof device>
export type Fixture = Awaited<ReturnType<typeof fixture>>

export async function requireExactOwnedSchema(pool: Pool): Promise<void> {
  const migrations = await readMigrations(fileURLToPath(new URL('../db/migrations/', import.meta.url)))
  assert.equal(migrations.length, 17)
  assert.equal(migrations[16].version, '017-structured-session-wire.sql')
  const applied = await sql(pool, 'SELECT version,checksum FROM durable_runtime.schema_migrations ORDER BY version')
  assert.deepEqual(applied.rows, migrations.map(({ version, checksum }) => ({ version, checksum })))
  // This verifier neither migrates nor resets a dataset. Root/DB owner prepares it.
}
function envelope(method: string, publicId: string, key: string, fields: Record<string, unknown>, fence: number | null) {
  return { sessionId: publicId, clientOperationId: key, expectedRuntimeFence: fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({ method, sessionId: publicId, fields }) }
}
function syntheticUpper(method: 'agentSession.create' | 'agentSession.send', params: unknown, who: FixtureDevice) {
  const wire = prepareStructuredWire(method, params, capabilities)
  assert.equal(wire.ok, true)
  if (!wire.ok) { throw new Error('Synthetic wire preparation failed') }
  return {
    authentication: { kind: 'PAIRED_DEVICE', pairedDeviceId: who.id } as unknown as VerifiedStructuredAuthentication,
    targetAccess: { principal: who.principal, method, target: wire.value.target } as unknown as VerifiedStructuredTargetAccess
  }
}

/** Existing authorized Workspace fixture; the wrapper does not create a Workspace. */
export async function fixture(pool: Pool, publicId = `synthetic-public-${randomUUID()}`, who = device()) {
  const workspaceId = logicalId('workspace', randomUUID()), workspacePublicId = `synthetic-folder:${randomUUID()}`
  const group = `synthetic-group:${randomUUID()}`, backend = `synthetic-backend:${randomUUID()}`, exportId = 'synthetic-export'
  const path = `/synthetic/p117/workspace/${workspaceId}`
  const payload = { id: workspacePublicId, projectGroupId: group, name: 'Synthetic folder', folderPath: path,
    comment: '', linkedTask: null, createdAt: 1, updatedAt: 1, lastActivityAt: 0, sortOrder: 0,
    isArchived: false, isUnread: false, isPinned: false }
  await withDurableTransaction(pool, async tx => {
    await tx.query('INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)', [group,
      JSON.stringify({ id: group, name: 'Synthetic group', parentPath: null, parentGroupId: null, color: null,
        isCollapsed: false, tabOrder: 0, createdAt: 1, updatedAt: 1, createdFrom: 'manual' })])
    await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'Synthetic folder','READY')", [workspaceId, workspacePublicId])
    await tx.query(`INSERT INTO durable_runtime.catalog_workspace_metadata
      (workspace_id,kind,project_group_id,reserved_path,payload,create_request)
      VALUES($1,'FOLDER_WORKSPACE',$2,$3,$4,'{}')`, [workspaceId, group, path, JSON.stringify(payload)])
    await tx.query('INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2)', [backend, exportId])
    await tx.query("INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES('catalog',$1) ON CONFLICT(scope) DO NOTHING", [randomUUID()])
    await tx.query('INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES($1,$2)',
      [`workspace:${workspaceId}`, randomUUID()])
  })
  const membership = await withDurableTransaction(pool, tx => inspectCatalogMembership(tx, workspaceId))
  const sessionId = logicalId('session', randomUUID()), unitId = logicalId('runtime-unit', randomUUID())
  const agentId = logicalId('agent', randomUUID()), tabId = logicalId('tab', randomUUID())
  const storageId = logicalId('storage-binding', randomUUID()), key = `synthetic-create:${randomUUID()}`
  const fields = { worktree: `id:${workspacePublicId}`, agent: 'claude' }
  const params = { ...fields, envelope: envelope('agentSession.create', publicId, key, fields, null) }
  const call: DurableStructuredCreateCall = {
    pool, params, capabilities: [...capabilities], ...syntheticUpper('agentSession.create', params, who), entries: { ...owners },
    configuration: {
      location: { workspaceId: workspacePublicId, executionHostId: 'synthetic-host', wslDistro: null, workspaceKind: 'folder' },
      reservation: {
        authority: { principalId: who.principal, repositoryIds: [], projectGroupIds: [group], workspacePublicIds: [workspacePublicId] } as unknown as CatalogAuthority,
        workspace: { workspace_id: workspaceId, public_id: workspacePublicId, repo_id: null, project_group_id: group },
        membership, unitPeers: [], publicSessionId: publicId, operationKey: key,
        runtime: { workspace: { id: workspaceId }, sessionId, agent: { id: agentId, provider: 'claude', create: true },
          unit: { id: unitId, create: true, authority: { principalId: who.principal, runtimeUnitId: unitId,
            scope: `workspace:${workspaceId}` } as unknown as UnitIntentAuthority },
          storage: { id: storageId, createUnverified: true, backendId: backend, exportId,
            canonicalDirectory: `/synthetic/p117/home/${sessionId}` },
          policy: { operationDeadlineMs: 10000, idleDurationMs: 60000 } },
        tab: { id: tabId, uiOrder: 0, payload: { type: 'agent-session', id: structuredAgentSessionTabId(publicId),
          title: 'Synthetic agent', sessionId: publicId, agent: 'claude', isActive: true } },
        originalRequest: { ...fields }
      }
    }
  }
  return { call, who, publicId, workspaceId, workspacePublicId, sessionId, unitId, agentId, tabId, storageId }
}
export function sendCall(f: Fixture, key: string, who = f.who,
  body: JsonSnapshot = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Synthetic original body' }] },
  entries: VerifiedStructuredAttachmentResolution['entries'] = []): DurableStructuredSendCall {
  const params = { body, envelope: envelope('agentSession.send', f.publicId, key, { body }, 1) }
  return { pool: f.call.pool, params, capabilities: [...capabilities], ...syntheticUpper('agentSession.send', params, who),
    workspace: { workspaceId: f.workspaceId, workspacePublicId: f.workspacePublicId, provider: 'claude', executionHostId: 'synthetic-host' },
    attachments: { principal: who.principal, entries } as unknown as VerifiedStructuredAttachmentResolution }
}

/** Fixture-only transport interposition. Every query/result/COMMIT remains real PG. */
export function instrumentPool(pool: Pool, beforeQuery: (text: string, values: unknown[]) => Promise<void> = async () => {},
  afterQuery: (text: string) => Promise<void> = async () => {}) {
  const controls: string[] = []
  const wrapped = { connect: async () => {
    const client = await pool.connect()
    return new Proxy(client, { get(target, property) {
      if (property === 'query') {
        return async (text: string, values: unknown[] = []) => {
          if (/^(BEGIN|COMMIT|ROLLBACK)\b/.test(text)) { controls.push(text.split(' ')[0]) }
          const captured = [...values]
          await beforeQuery(text, captured)
          const result = await target.query(text, captured)
          await afterQuery(text)
          return result
        }
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } }) as PoolClient
  } } as unknown as Pool
  return { pool: wrapped, controls }
}
export function barrier(participants: number) {
  let arrived = 0, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  return async () => {
    if (++arrived === participants) { release() }
    await gate
  }
}
export function checkoutGate(pool: Pool) {
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const checkout = new Promise<void>(resolve => { entered = resolve })
  let first = true
  return { entered: checkout, release, pool: { connect: async () => {
    if (first) { first = false; entered(); await gate }
    return pool.connect()
  } } as unknown as Pool }
}
export async function sessionState(pool: Pool, f: Fixture) {
  const row = await sql(pool, `SELECT
    (SELECT count(*)::integer FROM durable_runtime.input_components WHERE session_id=$1) AS inputs,
    (SELECT count(*)::integer FROM durable_runtime.messages WHERE session_id=$1) AS messages,
    (SELECT count(*)::integer FROM durable_runtime.structured_submissions WHERE session_id=$1) AS submissions,
    (SELECT count(*)::integer FROM durable_runtime.session_events WHERE session_id=$1) AS events,
    (SELECT count(*)::integer FROM durable_runtime.outbox_events WHERE aggregate_id=$2) AS outbox,
    (SELECT count(*)::integer FROM durable_runtime.rpc_receipts WHERE session_scope=$3) AS receipts,
    (SELECT row_to_json(s) FROM durable_runtime.sessions s WHERE id=$1) AS session,
    (SELECT row_to_json(u) FROM durable_runtime.runtime_units u WHERE id=$2) AS unit`,
  [f.sessionId, f.unitId, JSON.stringify(['structured-session', f.publicId])])
  return row.rows[0]
}
export async function requireNoCreateEffects(pool: Pool, f: Fixture) {
  for (const [table, id] of [['agents', f.agentId], ['sessions', f.sessionId], ['runtime_units', f.unitId],
    ['storage_bindings', f.storageId], ['tabs', f.tabId]]) {
    assert.equal((await sql(pool, `SELECT count(*)::integer AS n FROM durable_runtime.${table} WHERE id=$1`, [id])).rows[0].n, 0)
  }
  const state = await sessionState(pool, f)
  assert.deepEqual([state.inputs, state.messages, state.submissions, state.events, state.outbox], [0, 0, 0, 0, 0])
  assert.equal((await sql(pool, 'SELECT count(*)::integer AS n FROM durable_runtime.operations WHERE runtime_unit_id=$1', [f.unitId])).rows[0].n, 0)
  assert.equal((await sql(pool, 'SELECT count(*)::integer AS n FROM durable_runtime.catalog_tab_metadata WHERE tab_id=$1', [f.tabId])).rows[0].n, 0)
}
