import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { runDurableMutation, type ReceiptIdentity } from '../db/atomic.ts'
import { appendSessionEvent } from '../journal/store.ts'
import { recordUnitIntent } from '../lifecycle/intent.ts'
import type { UnitIntentAuthority } from '../lifecycle/types.ts'
import { reserveSleep } from '../lifecycle/sleep.ts'
import { recordInputCancel } from '../input/cancel.ts'
import { pairedDeviceAttachmentPrincipal } from '../attachments/types.ts'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types.ts'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection.ts'
import { reserveCatalogAgentSessionInTransaction } from './agent-session.ts'
import type { PreparedCatalogAgentSession } from './agent-session-types.ts'
import type { CatalogAuthority } from './authority.ts'
import { inspectCatalogMembership } from './membership.ts'
import { readWorkspaceTabsInTransaction, readAllCatalogTabs } from './projection.ts'
import { resolveCatalogWorkspace, withCatalogReadSnapshot } from './read.ts'
import { prepareCatalogCall } from './request.ts'
import { captureCatalogJson } from './immutable.ts'

// Written, not executed. These cases exercise Catalog's real SQL entry and
// existing receipt/journal owners. P117's alias/create entry is not supplied or
// imitated here; the full 017 alias composition remains an integration gate.
if (process.env.ORCA_P117_CATALOG_PG_APPROVED !== 'root-composition' ||
  !(process.env.PGDATABASE ?? '').startsWith('orca_p116_')) {
  throw new Error('Explicit Root composition allocation and owned Catalog DB required')
}
const pool = createDurablePool({ max: 3 })
const owners = { recordUnitIntent, reserveSleep, recordInputCancel }
const query = (sql: string, values: readonly unknown[] = []) => withDurableTransaction(pool, tx => tx.query(sql, values))
const principal = pairedDeviceAttachmentPrincipal(randomUUID())
const backendId = `synthetic-composition:${randomUUID()}`, exportId = 'synthetic-export'

async function fixture(): Promise<PreparedCatalogAgentSession> {
  const workspaceId = logicalId('workspace', randomUUID()), groupId = `synthetic-group:${randomUUID()}`
  const publicId = `synthetic-existing:${workspaceId}`
  const now = Date.now()
  const workspacePayload: FolderWorkspace = { id: publicId, projectGroupId: groupId,
    name: 'synthetic-existing', folderPath: `/synthetic/${workspaceId}`, comment: '', linkedTask: null,
    createdAt: now, updatedAt: now, lastActivityAt: now, sortOrder: 0,
    isArchived: false, isUnread: false, isPinned: false }
  const sessionId = logicalId('session', randomUUID()), unitId = logicalId('runtime-unit', randomUUID())
  const publicSessionId = `structured_${randomUUID().replaceAll('-', '_')}`
  // Synthetic authority describes an existing fixture Workspace only; no issuer.
  const authority = { principalId: principal, repositoryIds: [], projectGroupIds: [],
    workspacePublicIds: [publicId] } as unknown as CatalogAuthority
  await withDurableTransaction(pool, async tx => {
    await tx.query('INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)',
      [groupId, JSON.stringify({ id: groupId })])
    await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'synthetic-existing','READY')",
      [workspaceId, publicId])
    await tx.query(`INSERT INTO durable_runtime.catalog_workspace_metadata
      (workspace_id,kind,project_group_id,reserved_path,payload,create_request)
      VALUES($1,'FOLDER_WORKSPACE',$2,$3,$4,'{}')`,
      [workspaceId, groupId, `/synthetic/${workspaceId}`, JSON.stringify(workspacePayload)])
    await tx.query('INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES($1,$2)',
      [`workspace:${workspaceId}`, randomUUID()])
  })
  const membership = await withDurableTransaction(pool, tx => inspectCatalogMembership(tx, workspaceId))
  return { authority, workspace: { workspace_id: workspaceId, public_id: publicId, repo_id: null, project_group_id: groupId },
    membership, unitPeers: [], publicSessionId, operationKey: `synthetic-operation:${randomUUID()}`,
    runtime: { workspace: { id: workspaceId }, sessionId,
      agent: { id: logicalId('agent', randomUUID()), provider: 'claude', create: true },
      // Same isolated opaque-brand assertion as lifecycle/verification-fixtures.mts;
      // this fixture does not issue production authority or add an auth factory.
      unit: { id: unitId, create: true, authority: { principalId: principal, runtimeUnitId: unitId,
        scope: `workspace:${workspaceId}` } as unknown as UnitIntentAuthority },
      storage: { id: logicalId('storage-binding', randomUUID()), backendId, exportId,
        canonicalDirectory: `/synthetic/homes/${sessionId}`, createUnverified: true },
      policy: { operationDeadlineMs: 10000, idleDurationMs: 60000 } },
    tab: { id: logicalId('tab', randomUUID()), uiOrder: 0, payload: { type: 'agent-session',
      id: structuredAgentSessionTabId(publicSessionId), title: 'Synthetic structured session',
      sessionId: publicSessionId, agent: 'claude', isActive: true } },
    originalRequest: { worktree: publicId, agent: 'claude', resumeFrom: null, config: { marker: 'before' } } }
}

function receipt(prepared: PreparedCatalogAgentSession): ReceiptIdentity {
  return { key: { principalId: principal, sessionScope: `synthetic-structured:${prepared.publicSessionId}`,
    method: 'synthetic.catalog-composition', operationKey: prepared.operationKey }, payloadHash: 'c'.repeat(64) }
}

async function counts(prepared: PreparedCatalogAgentSession) {
  const runtime = prepared.runtime
  return (await query(`SELECT
    (SELECT count(*)::integer FROM durable_runtime.sessions WHERE id=$1) AS sessions,
    (SELECT count(*)::integer FROM durable_runtime.agents WHERE id=$2) AS agents,
    (SELECT count(*)::integer FROM durable_runtime.runtime_units WHERE id=$3) AS units,
    (SELECT count(*)::integer FROM durable_runtime.storage_bindings WHERE id=$4) AS bindings,
    (SELECT count(*)::integer FROM durable_runtime.runtime_members WHERE session_id=$1) AS members,
    (SELECT count(*)::integer FROM durable_runtime.tabs WHERE id=$5) AS tabs,
    (SELECT count(*)::integer FROM durable_runtime.session_events WHERE session_id=$1) AS events,
    (SELECT count(*)::integer FROM durable_runtime.operations WHERE runtime_unit_id=$3) AS operations,
    (SELECT count(*)::integer FROM durable_runtime.runtime_audit_events WHERE runtime_unit_id=$3) AS unit_audits,
    (SELECT count(*)::integer FROM durable_runtime.outbox_events WHERE aggregate_id=$3) AS unit_outbox,
    (SELECT count(*)::integer FROM durable_runtime.rpc_receipts WHERE operation_key=$6) AS receipts`,
  [runtime.sessionId, runtime.agent.id, runtime.unit.id, runtime.storage.id, prepared.tab.id, prepared.operationKey])).rows[0]
}

await test('Catalog agent-session same-transaction entry: first focused cases, not alias/RPC qualification', async t => {
  try {
    // Requires actual root-composed 013/014 source/schema; never installs, resets
    // or weakens migrations from this suite.
    assert.equal((await query("SELECT to_regclass('durable_runtime.catalog_heads') IS NOT NULL AS ready")).rows[0].ready, true)
    await query('INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2)', [backendId, exportId])
    await query("INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES('catalog',$1) ON CONFLICT(scope) DO NOTHING", [randomUUID()])

    await t.test('non-UUID public ID commits logical graph, fence one, event and outer receipt; replay has no effect', async () => {
      const prepared = await fixture(), identity = receipt(prepared)
      const workspaceCount = (await query('SELECT count(*)::text AS n FROM durable_runtime.workspaces')).rows[0].n
      let calls = 0
      const body = async (tx: Parameters<typeof reserveCatalogAgentSessionInTransaction>[0]) => {
        calls++
        const result = await reserveCatalogAgentSessionInTransaction(tx, prepared, owners)
        assert.equal(tx.isLockHeld(1, prepared.runtime.sessionId), true)
        const event = await appendSessionEvent(tx, { sessionId: prepared.runtime.sessionId,
          source: { kind: 'PRODUCER', sourceKind: 'synthetic-composition', producerId: randomUUID(),
            incarnation: randomUUID(), producerSeq: counter('sequence:producer', '1') },
          body: { kind: 'STRUCTURED_SESSION_CREATED', version: 1, publicSessionId: prepared.publicSessionId } })
        return captureCatalogJson({ ...result, eventId: event.eventId })
      }
      const outcome = await runDurableMutation(pool, { ...identity, locks: {} }, body)
      assert.equal(outcome.status, 'COMMITTED')
      const beforeReplay = await counts(prepared)
      assert.equal((await runDurableMutation(pool, { ...identity, locks: {} }, body)).status, 'REPLAYED')
      assert.equal(calls, 1); assert.deepEqual(await counts(prepared), beforeReplay)
      const physical = (await query(`SELECT s.session_fence,t.kind,t.terminal_handle,t.leaf_id,t.pane_key,
        u.phase,u.active_attempt_id,b.access_state,b.identity_verified_at,b.identity_proof_ref
        FROM durable_runtime.sessions s JOIN durable_runtime.tabs t ON t.session_id=s.id
        JOIN durable_runtime.runtime_members m ON m.session_id=s.id
        JOIN durable_runtime.runtime_units u ON u.id=m.runtime_unit_id
        JOIN durable_runtime.storage_bindings b ON b.id=m.storage_binding_id WHERE s.id=$1`, [prepared.runtime.sessionId])).rows[0]
      assert.deepEqual(physical, { session_fence: '1', kind: 'agent-session', terminal_handle: null, leaf_id: null,
        pane_key: null, phase: 'ABSENT', active_attempt_id: null, access_state: 'UNVERIFIED',
        identity_verified_at: null, identity_proof_ref: null })
      assert.equal(beforeReplay.sessions, 1); assert.equal(beforeReplay.tabs, 1)
      assert.equal(beforeReplay.members, 1); assert.equal(beforeReplay.events, 1); assert.equal(beforeReplay.operations, 1)
      assert.equal(beforeReplay.receipts, 1)
      assert.equal((await query('SELECT count(*)::text AS n FROM durable_runtime.workspaces')).rows[0].n, workspaceCount)
      const snapshot = await withCatalogReadSnapshot(pool, async tx => readWorkspaceTabsInTransaction(tx,
        await resolveCatalogWorkspace(tx, prepared.workspace.public_id, prepared.authority)))
      const all = await readAllCatalogTabs(pool, prepareCatalogCall('session.tabs.listAll', undefined,
        { authority: prepared.authority, capabilities: [] }))
      assert.deepEqual(all.snapshots[0], snapshot)
      const response = outcome.receipt.response as Record<string, unknown>
      assert.equal(response.publicationEpoch, snapshot.publicationEpoch)
      assert.equal(response.snapshotVersion, snapshot.snapshotVersion)
      assert.equal(snapshot.tabs[0].id, structuredAgentSessionTabId(prepared.publicSessionId))
      assert.equal(snapshot.tabs[0].type, 'agent-session')
    })

    await t.test('failure after Catalog head and first journal event rolls back the graph and receipt together', async () => {
      const prepared = await fixture()
      const headBefore = (await query('SELECT scope,revision FROM durable_runtime.catalog_heads ORDER BY scope')).rows
      const catalogOutboxBefore = (await query("SELECT count(*)::text AS n FROM durable_runtime.outbox_events WHERE aggregate_kind='catalog'")).rows[0].n
      const auditBefore = (await query('SELECT count(*)::text AS n FROM durable_runtime.runtime_audit_events')).rows[0].n
      await assert.rejects(runDurableMutation(pool, { ...receipt(prepared), locks: {} }, async tx => {
        await reserveCatalogAgentSessionInTransaction(tx, prepared, owners)
        await appendSessionEvent(tx, { sessionId: prepared.runtime.sessionId,
          source: { kind: 'PRODUCER', sourceKind: 'synthetic-composition', producerId: randomUUID(),
            incarnation: randomUUID(), producerSeq: counter('sequence:producer', '1') },
          body: { kind: 'STRUCTURED_SESSION_CREATED', version: 1, publicSessionId: prepared.publicSessionId } })
        throw new Error('SYNTHETIC_AFTER_EVENT_ROLLBACK')
      }))
      assert.ok(Object.values(await counts(prepared)).every(value => value === 0))
      assert.deepEqual((await query('SELECT scope,revision FROM durable_runtime.catalog_heads ORDER BY scope')).rows, headBefore)
      assert.equal((await query("SELECT count(*)::text AS n FROM durable_runtime.outbox_events WHERE aggregate_kind='catalog'")).rows[0].n, catalogOutboxBefore)
      assert.equal((await query('SELECT count(*)::text AS n FROM durable_runtime.runtime_audit_events')).rows[0].n, auditBefore)
    })

    await t.test('nested prepared DTO and owner callback receiver are fixed before the first SQL await', async () => {
      const prepared = await fixture()
      const entries = { ...owners }
      await runDurableMutation(pool, { ...receipt(prepared), locks: {} }, async tx => {
        const running = reserveCatalogAgentSessionInTransaction(tx, prepared, entries)
        ;(prepared.originalRequest.config as Record<string, unknown>).marker = 'after'
        ;(prepared.tab.payload as { title: string }).title = 'after'
        entries.recordUnitIntent = async () => { throw new Error('SYNTHETIC_LATE_CALLBACK') }
        return captureCatalogJson(await running)
      })
      const row = (await query("SELECT payload->>'title' AS title,launch_request->'config'->>'marker' AS marker FROM durable_runtime.catalog_tab_metadata WHERE tab_id=$1", [prepared.tab.id])).rows[0]
      assert.deepEqual(row, { title: 'Synthetic structured session', marker: 'before' })
    })

    await t.test('deleted existing Workspace is rejected without publishing new rows', async () => {
      const prepared = await fixture()
      await query('UPDATE durable_runtime.workspaces SET deleted_at=clock_timestamp() WHERE id=$1', [prepared.workspace.workspace_id])
      await assert.rejects(runDurableMutation(pool, { ...receipt(prepared), locks: {} }, async tx =>
        captureCatalogJson(await reserveCatalogAgentSessionInTransaction(tx, prepared, owners))))
      assert.ok(Object.values(await counts(prepared)).every(value => value === 0))
    })

    await t.test('changed shared Unit peers are rejected rather than adding a new lower-rank lock', async () => {
      const prepared = await fixture(), peer = logicalId('session', randomUUID()), peerAgent = logicalId('agent', randomUUID())
      const peerWorkspace = await fixture()
      await withDurableTransaction(pool, async tx => {
        await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'claude')", [peerAgent])
        await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [peer, peerAgent, peerWorkspace.workspace.workspace_id])
        await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT')", [prepared.runtime.unit.id])
        await tx.query("INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state) VALUES($1,$2,$3,$4,'UNVERIFIED')",
          [prepared.runtime.storage.id, backendId, exportId, prepared.runtime.storage.canonicalDirectory])
        await tx.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)',
          [prepared.runtime.unit.id, peer, prepared.runtime.storage.id])
      })
      const stale = { ...prepared, runtime: { ...prepared.runtime, unit: { ...prepared.runtime.unit, create: false },
        storage: { ...prepared.runtime.storage, createUnverified: false } } }
      await assert.rejects(runDurableMutation(pool, { ...receipt(stale), locks: {} }, async tx =>
        captureCatalogJson(await reserveCatalogAgentSessionInTransaction(tx, stale, owners))))
      assert.equal((await counts(stale)).sessions, 0); assert.equal((await counts(stale)).tabs, 0)
      assert.equal((await counts(stale)).receipts, 0)
    })

    await t.test('existing public ID grammar and physical-handle exclusion reject invalid preparation', async () => {
      for (const change of [
        (p: PreparedCatalogAgentSession) => ({ ...p, publicSessionId: 'bad/id' }),
        (p: PreparedCatalogAgentSession) => ({ ...p, tab: { ...p.tab, payload: { ...p.tab.payload, providerHandle: 'forbidden' } } })
      ]) {
        const prepared = change(await fixture())
        await assert.rejects(runDurableMutation(pool, { ...receipt(prepared), locks: {} }, async tx =>
          captureCatalogJson(await reserveCatalogAgentSessionInTransaction(tx, prepared, owners))))
        assert.ok(Object.values(await counts(prepared)).every(value => value === 0))
      }
    })

    await t.test('new active agent-session Tab clears the prior logical active Tab in the same Workspace', async () => {
      const first = await fixture()
      await runDurableMutation(pool, { ...receipt(first), locks: {} }, async tx =>
        captureCatalogJson(await reserveCatalogAgentSessionInTransaction(tx, first, owners)))
      const another = await fixture()
      const membership = await withDurableTransaction(pool, tx => inspectCatalogMembership(tx, first.workspace.workspace_id))
      const prepared = { ...another, authority: first.authority, workspace: first.workspace, membership,
        runtime: { ...another.runtime, workspace: { id: first.workspace.workspace_id },
          unit: { ...another.runtime.unit, authority: { ...another.runtime.unit.authority,
            scope: `workspace:${first.workspace.workspace_id}` } } } }
      await runDurableMutation(pool, { ...receipt(prepared), locks: {} }, async tx =>
        captureCatalogJson(await reserveCatalogAgentSessionInTransaction(tx, prepared, owners)))
      const snapshot = await withCatalogReadSnapshot(pool, async tx => readWorkspaceTabsInTransaction(tx,
        await resolveCatalogWorkspace(tx, prepared.workspace.public_id, prepared.authority)))
      assert.equal(snapshot.tabs.length, 2)
      assert.equal(snapshot.activeTabId, prepared.tab.payload.id)
      assert.equal(snapshot.tabs.find(tab => tab.id === first.tab.payload.id)?.isActive, false)
      assert.equal(snapshot.tabs.filter(tab => tab.isActive).length, 1)
    })
  } finally { await pool.end() }
})
