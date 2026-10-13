import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { applyMigrations, readMigrations } from '../db/migrate.ts'
import { recordUnitIntent } from '../lifecycle/intent.ts'
import { reserveSleep } from '../lifecycle/sleep.ts'
import { recordInputCancel } from '../input/cancel.ts'
import type { InputAuthority } from '../input/types.ts'
import type { CatalogAuthority } from './authority.ts'
import type { PreparedCatalogLaunch } from './launch.ts'
import { registerCatalogProject } from './register.ts'
import { prepareCatalogCall } from './request.ts'
import { reserveCatalogWorkspace, createCatalogTerminal } from './create.ts'
import { readCatalogSnapshot, withCatalogReadSnapshot, resolveCatalogWorkspace } from './read.ts'
import { readAllCatalogTabs } from './projection.ts'
import { closeCatalogTab } from './close.ts'
import { reserveCatalogSleep } from './sleep.ts'
import { selectSuggestedCreatureName } from '../../../shared/worktree-name-suggestion.ts'
import { CatalogError } from './errors.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { assertNewInputState } from '../input/authority.ts'
import { pairedDeviceAttachmentPrincipal } from '../attachments/types.ts'
import { lockAggregates } from '../db/locks.ts'
import { applyCatalogBindingObservation, type PreparedCatalogBindingObservation } from './binding.ts'
import type { PreparedMemberActivity } from '../lifecycle/sleep.ts'
import type { Pool } from 'pg'

// WRITTEN, NOT EXECUTED. Root recovery notice and root-composed dependency pins
// are prerequisites. This guard is not authentication or a substitute for approval.
if (process.env.ORCA_P116_PG_APPROVED !== 'root-recovered' ||
  !(process.env.PGDATABASE ?? '').startsWith('orca_p116_')) {throw new Error('Fresh owned Catalog DB and root recovery notice required')}
const pool = createDurablePool({ max: 6 })
const owners = { recordUnitIntent, reserveSleep, recordInputCancel }
const query = (sql: string, values: readonly unknown[] = []) => withDurableTransaction(pool, tx => tx.query(sql, values))
const repoId = `synthetic-repo:${randomUUID()}`, groupId = `synthetic-group:${randomUUID()}`
// Synthetic fixture authorities only. No production issuer exists in Catalog.
const principal = pairedDeviceAttachmentPrincipal(randomUUID())
const authority = { principalId: principal, repositoryIds: [repoId], projectGroupIds: [groupId], workspacePublicIds: [] } as unknown as CatalogAuthority
const context = { authority, capabilities: [] }
const used: string[] = []

function fixture(): PreparedCatalogLaunch {
  const name = selectSuggestedCreatureName(used, () => 0)
  const workspaceId = randomUUID(), path = `/synthetic/p116/workspaces/${name}`, publicId = `${repoId}::${path}`
  const parentTabId = `synthetic-tab-${randomUUID()}`, leafId = randomUUID(), tabId = randomUUID(), sessionId = randomUUID(), unitId = randomUUID()
  const git = { path, head: '', branch: name, isBare: false, isMainWorktree: false }
  return {
    workspace: { id: workspaceId, publicId, kind: 'GIT', repoId, projectGroupId: groupId,
      reservedPath: path, reservedName: name, generatedName: true, nameChoice: 0,
      aliases: [`synthetic-alias:${workspaceId}`], payload: { ...git, id: publicId, repoId,
        displayName: 'Synthetic user label', comment: '', linkedIssue: null, linkedPR: null, linkedLinearIssue: null,
        isArchived: false, isUnread: false, isPinned: false, sortOrder: 0, lastActivityAt: 0,
        parentWorktreeId: null, childWorktreeIds: [], lineage: null, git } },
    tab: { id: tabId, publicId: `${parentTabId}::${leafId}`, parentTabId, leafId,
      terminalHandle: `synthetic-logical-handle:${tabId}`, uiOrder: 0,
      payload: { type: 'terminal', id: `${parentTabId}::${leafId}`, parentTabId, leafId,
        title: 'Synthetic shell', isActive: true, status: 'pending-handle', terminal: null } },
    sessionId, agent: { id: randomUUID(), provider: 'shell', create: true },
    unit: { id: unitId, create: true, authority: { principalId: authority.principalId, runtimeUnitId: unitId, scope: `workspace:${workspaceId}` } },
    storage: { id: randomUUID(), createUnverified: true, backendId: 'synthetic-backend', exportId: 'synthetic-export',
      canonicalDirectory: `/synthetic/p116/homes/${sessionId}` },
    launchRequest: { command: 'echo synthetic', env: { SYNTHETIC: 'before' } },
    policy: { operationDeadlineMs: 10000, idleDurationMs: 60000 }
  } as unknown as PreparedCatalogLaunch
}
function closeAuthority(launch: PreparedCatalogLaunch): InputAuthority {
  return { principal, sessionId: launch.sessionId, scope: { kind: 'SESSION' } }
}
function createCall(launch: PreparedCatalogLaunch, key: string) {
  return prepareCatalogCall('worktree.create', { repo: repoId, name: launch.workspace.reservedName,
    nameWasGenerated: true, displayName: 'Synthetic user label', clientMutationId: key }, context)
}

await test('new Catalog PG composition boundaries (not prior intake/COMMIT suite)', async t => {
  try {
    const schema = await query("SELECT to_regnamespace('durable_runtime') AS existing")
    const migrations = await readMigrations(fileURLToPath(new URL('../db/migrations/', import.meta.url)))
    assert.equal(migrations.length, 14)
    assert.ok(migrations[13].version.startsWith('014-'))
    if (schema.rows[0].existing === null) {
      await applyMigrations(pool, migrations)
      await query("INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES('synthetic-backend','synthetic-export')")
    } else {
      // Reuse only this first-run setup after registration rolled back. No reset,
      // repeated DDL or passing Catalog cases are hidden by this fixture boundary.
      assert.equal(process.env.ORCA_P116_SCHEMA_REUSE, process.env.PGDATABASE)
      const applied = await query('SELECT version,checksum FROM durable_runtime.schema_migrations ORDER BY version')
      assert.deepEqual(applied.rows, migrations.map(({ version, checksum }) => ({ version, checksum })))
      const empty = await query(`SELECT (SELECT count(*)::integer FROM durable_runtime.workspaces) AS workspaces,
        (SELECT count(*)::integer FROM durable_runtime.catalog_repositories) AS repositories`)
      assert.deepEqual(empty.rows[0], { workspaces: 0, repositories: 0 })
    }
    await registerCatalogProject(pool, authority, { mutationId: 'synthetic-registration',
      group: { id: groupId, name: 'Synthetic group', parentPath: null, parentGroupId: null, color: null,
        isCollapsed: false, tabOrder: 0, createdAt: 1, updatedAt: 1, createdFrom: 'manual' },
      repo: { id: repoId, path: '/synthetic/p116/repo', displayName: 'Synthetic repo', badgeColor: '#ffffff',
        addedAt: 1, kind: 'git', projectGroupId: groupId, executionHostId: 'runtime:synthetic-runtime' },
      ui: { lastActiveRepoId: null, lastActiveWorktreeId: null, activeView: 'terminal', sidebarWidth: 240,
        rightSidebarOpen: false, rightSidebarTab: 'explorer', rightSidebarExplorerView: 'files', rightSidebarWidth: 320,
        groupBy: 'none', sortBy: 'smart', projectOrderBy: 'manual', showActiveOnly: false, hideDefaultBranchWorkspace: false,
        filterRepoIds: [], collapsedGroups: [], uiZoomLevel: 0, editorFontZoomLevel: 0,
        worktreeCardProperties: [], statusBarItems: [], statusBarVisible: true, dismissedUpdateVersion: null, lastUpdateCheckAt: null } })

    const first = fixture()
    await t.test('concurrent same-key create and caller retry retain one stable object and unverified storage', async () => {
      const call = createCall(first, 'synthetic-create')
      const results = await Promise.all([reserveCatalogWorkspace(pool, call, first, owners), reserveCatalogWorkspace(pool, call, first, owners)])
      assert.ok(results.every(result => result.status === 'COMMITTED' || result.status === 'REPLAYED'))
      assert.deepEqual(results[0].status === 'UNCERTAIN' ? null : results[0].receipt.response,
        results[1].status === 'UNCERTAIN' ? null : results[1].receipt.response)
      const again = await reserveCatalogWorkspace(pool, call, first, owners) // Caller lost the response; same durable key.
      assert.equal(again.status, 'REPLAYED')
      const stored = await query(`SELECT w.public_id,u.phase,u.active_attempt_id,b.identity_verified_at,b.identity_proof_ref
        FROM durable_runtime.workspaces w JOIN durable_runtime.runtime_members m ON m.session_id=$2
        JOIN durable_runtime.runtime_units u ON u.id=m.runtime_unit_id
        JOIN durable_runtime.storage_bindings b ON b.id=m.storage_binding_id WHERE w.id=$1`, [first.workspace.id, first.sessionId])
      assert.equal(stored.rows.length, 1); assert.equal(stored.rows[0].public_id, first.workspace.publicId)
      assert.equal(stored.rows[0].phase, 'ABSENT'); assert.equal(stored.rows[0].active_attempt_id, null)
      assert.equal(stored.rows[0].identity_verified_at, null); assert.equal(stored.rows[0].identity_proof_ref, null)
      const wrong = prepareCatalogCall('worktree.create', { repo: repoId, name: first.workspace.reservedName,
        displayName: 'different', clientMutationId: 'synthetic-create' }, context)
      await assert.rejects(reserveCatalogWorkspace(pool, wrong, first, owners), error => error instanceof Error && 'code' in error && error.code === 'RECEIPT_PAYLOAD_CONFLICT')
      used.push(first.workspace.reservedName)
    })

    await t.test('alias resolver uses the same object and read-only tab snapshots do not mark activity', async () => {
      const found = await withCatalogReadSnapshot(pool, tx => resolveCatalogWorkspace(tx, first.workspace.aliases[0], authority))
      assert.equal(found.workspace_id, first.workspace.id)
      const before = await readCatalogSnapshot(pool, authority)
      const all = await readAllCatalogTabs(pool, prepareCatalogCall('session.tabs.listAll', undefined, context))
      const snapshot = all.snapshots.find(row => row.worktree === first.workspace.publicId)!
      assert.equal(snapshot.tabs.length, 1); assert.equal(snapshot.tabs[0].type, 'terminal')
      assert.deepEqual((await readCatalogSnapshot(pool, authority)).heads, before.heads)
      assert.equal((await query('SELECT last_work_event_at FROM durable_runtime.runtime_units WHERE id=$1', [first.unit.id])).rows[0].last_work_event_at, null)
    })

    await t.test('nested launch request mutated after first await stays detached and create failure rolls back all aggregates', async () => {
      const next = fixture(), call = createCall(next, 'synthetic-nested-capture')
      const running = reserveCatalogWorkspace(pool, call, next, owners)
      ;(next.launchRequest.env as Record<string, string>).SYNTHETIC = 'after'
      await running
      assert.equal((await query("SELECT launch_request->'env'->>'SYNTHETIC' AS value FROM durable_runtime.catalog_tab_metadata WHERE tab_id=$1", [next.tab.id])).rows[0].value, 'before')
      used.push(next.workspace.reservedName)
      const rejected = fixture()
      const broken = { ...owners, recordUnitIntent: (async (...args: Parameters<typeof recordUnitIntent>) => {
        await recordUnitIntent(...args); throw new CatalogError('SYNTHETIC_AFTER_INTENT_ROLLBACK')
      }) as typeof recordUnitIntent }
      await assert.rejects(reserveCatalogWorkspace(pool, createCall(rejected, 'synthetic-create-rollback'), rejected, broken))
      for (const [table, id] of [['workspaces', rejected.workspace.id], ['sessions', rejected.sessionId],
        ['agents', rejected.agent.id], ['runtime_units', rejected.unit.id], ['storage_bindings', rejected.storage.id], ['tabs', rejected.tab.id]]) {
        assert.equal((await query(`SELECT count(*)::text AS n FROM durable_runtime.${table} WHERE id=$1`, [id])).rows[0].n, '0')
      }
    })

    await t.test('retired generated name is included in the namespace choice and stale preparation rolls back', async () => {
      await query('UPDATE durable_runtime.catalog_name_reservations SET retired=true WHERE workspace_id=$1', [first.workspace.id])
      const candidate = fixture()
      const stale = { ...candidate, workspace: { ...candidate.workspace, reservedName: first.workspace.reservedName } } as PreparedCatalogLaunch
      await assert.rejects(reserveCatalogWorkspace(pool, createCall(stale, 'synthetic-retired-name'), stale, owners),
        error => error instanceof Error && 'code' in error && error.code === 'CATALOG_PREPARED_NAME_STALE_RETRYABLE')
      assert.equal((await query('SELECT count(*)::text AS n FROM durable_runtime.workspaces WHERE id=$1', [candidate.workspace.id])).rows[0].n, '0')
      assert.equal((await query('SELECT retired FROM durable_runtime.catalog_name_reservations WHERE workspace_id=$1', [first.workspace.id])).rows[0].retired, true)
    })

    await t.test('pin invalidated while Pool checkout waits cannot commit SUSPENDED', async () => {
      const launch = fixture()
      await reserveCatalogWorkspace(pool, createCall(launch, 'synthetic-pin-race-create'), launch, owners)
      used.push(launch.workspace.reservedName)
      const attemptId = logicalId('attempt', randomUUID())
      await query(`INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,resource_profile_revision,effective_resources,status)
        VALUES($1,$2,1,'COLD','synthetic-pin-pod',0,'{}','synthetic-fixture')`, [attemptId, launch.unit.id])
      await query('UPDATE durable_runtime.runtime_units SET active_attempt_id=$2,execution_epoch=1,revision=revision+1 WHERE id=$1', [launch.unit.id, attemptId])
      const unit = (await query('SELECT revision,intent_revision FROM durable_runtime.runtime_units WHERE id=$1', [launch.unit.id])).rows[0]
      let valid = true, release!: () => void, entered!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const checkout = new Promise<void>(resolve => { entered = resolve })
      const waitingPool = { connect: async () => { entered(); await gate; return pool.connect() } } as unknown as Pool
      const evidence = Object.freeze({ sessionId: launch.sessionId, attemptId, podUid: 'synthetic-pin-pod', executionEpoch: '1',
        observedAt: new Date(), producerCommittedWatermark: '0', observedWatermark: '0', sourceEvidenceRef: 'synthetic-pin-evidence',
        activeTurn: false, activeTool: false, backgroundWriter: false, inFlightDispatch: false }) as unknown as PreparedMemberActivity
      const pending = reserveCatalogSleep(waitingPool, prepareCatalogCall('worktree.sleep', { worktree: launch.workspace.publicId }, context), {
        preparedAttemptId: attemptId, request: { unitId: launch.unit.id, actorId: authority.principalId,
          discoveredMembers: [launch.sessionId], expectedRevision: unit.revision, expectedIntentRevision: unit.intent_revision,
          policy: launch.policy, activityFreshnessMs: 10000,
          activity: Object.freeze({ member: () => evidence, pinValid: (candidate: PreparedMemberActivity) => valid && candidate === evidence }) }
      }, owners)
      await checkout
      valid = false
      release()
      const outcome = await pending
      assert.notEqual(outcome.status, 'UNCERTAIN')
      if (outcome.status !== 'UNCERTAIN') {assert.deepEqual((outcome.receipt.response as { reservation: unknown }).reservation,
        { status: 'DEFERRED', reason: 'WRITER_UNVERIFIABLE' })}
      assert.equal((await query('SELECT desired_mode FROM durable_runtime.runtime_units WHERE id=$1', [launch.unit.id])).rows[0].desired_mode, 'RUNNING')
    })

    await t.test('same-TX cancel plus tombstone rollback, one Session close in a shared Unit, and no fabricated physical stop', async () => {
      const second = fixture()
      const shared = { ...second, workspace: first.workspace, unit: { ...first.unit, create: false },
        tab: { ...second.tab, uiOrder: 1, payload: { ...second.tab.payload, isActive: false } } } as PreparedCatalogLaunch
      await createCatalogTerminal(pool, prepareCatalogCall('session.tabs.createTerminal', {
        worktree: first.workspace.publicId, clientMutationId: 'synthetic-second-session', launchToken: 'synthetic-opaque-token'
      }, context), shared, owners)
      const message = randomUUID(), attempt = randomUUID(), delivery = randomUUID()
      await query("INSERT INTO durable_runtime.messages(id,session_id,seq,body_or_blob_ref,intake_status) VALUES($1,$2,1,'{}','EFFECT_POSSIBLE')", [message, first.sessionId])
      await query(`INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,resource_profile_revision,effective_resources,status)
        VALUES($1,$2,1,'COLD',0,'{}','synthetic-fixture')`, [attempt, first.unit.id])
      await query('UPDATE durable_runtime.runtime_units SET active_attempt_id=$2,execution_epoch=1,revision=revision+1 WHERE id=$1', [first.unit.id, attempt])
      await query(`INSERT INTO durable_runtime.delivery_attempts(id,message_id,session_id,runtime_unit_id,attempt_id,execution_epoch,state,effect_possible_at)
        VALUES($1,$2,$3,$4,$5,1,'EFFECT_POSSIBLE',clock_timestamp())`, [delivery, message, first.sessionId, first.unit.id, attempt])
      const call = prepareCatalogCall('terminal.close', { terminal: first.tab.terminalHandle }, context)
      const scope = { inputAuthorities: [closeAuthority(first)] }
      const before = (await query('SELECT count(*)::text AS n FROM durable_runtime.outbox_events')).rows[0].n
      const broken = { ...owners, recordInputCancel: (async (...args: Parameters<typeof recordInputCancel>) => {
        await recordInputCancel(...args); throw new CatalogError('SYNTHETIC_AFTER_CANCEL_ROLLBACK')
      }) as typeof recordInputCancel }
      await assert.rejects(closeCatalogTab(pool, call, first.workspace.publicId, scope, broken))
      assert.equal((await query('SELECT lifecycle FROM durable_runtime.tabs WHERE id=$1', [first.tab.id])).rows[0].lifecycle, 'OPEN')
      assert.equal((await query('SELECT cancel_requested_at FROM durable_runtime.messages WHERE id=$1', [message])).rows[0].cancel_requested_at, null)
      assert.equal((await query('SELECT count(*)::text AS n FROM durable_runtime.cancel_intents')).rows[0].n, '0')
      assert.equal((await query('SELECT count(*)::text AS n FROM durable_runtime.outbox_events')).rows[0].n, before)
      const closed = await closeCatalogTab(pool, call, first.workspace.publicId, scope, owners)
      assert.notEqual(closed.status, 'UNCERTAIN')
      if (closed.status !== 'UNCERTAIN') {assert.deepEqual((closed.receipt.response as { close: { ptyKilled: boolean } }).close.ptyKilled, false)}
      assert.equal((await query('SELECT lifecycle FROM durable_runtime.sessions WHERE id=$1', [first.sessionId])).rows[0].lifecycle, 'CLOSING')
      assert.equal((await query('SELECT lifecycle FROM durable_runtime.sessions WHERE id=$1', [shared.sessionId])).rows[0].lifecycle, 'OPEN')
      assert.equal((await query('SELECT desired_mode FROM durable_runtime.runtime_units WHERE id=$1', [first.unit.id])).rows[0].desired_mode, 'RUNNING')
      assert.equal((await query("SELECT count(*)::text AS n FROM durable_runtime.outbox_events WHERE event->>'kind'='INTERRUPT_FIXED_DELIVERY'")).rows[0].n, '1')
      await assert.rejects(withDurableTransaction(pool, async tx => {
        await lockAggregates(tx, { sessionIds: [first.sessionId], runtimeUnitIds: [first.unit.id] })
        await assertNewInputState(tx, closeAuthority(first), '0', first.unit.id)
      }))
      assert.equal((await reserveCatalogWorkspace(pool, createCall(first, 'synthetic-create'), first, owners)).status, 'REPLAYED')
    })

    await t.test('latest P113 CLOSING sleep is DEFERRED, not a fabricated successful stop', async () => {
      const unit = (await query('SELECT revision,intent_revision FROM durable_runtime.runtime_units WHERE id=$1', [first.unit.id])).rows[0]
      const members = (await query('SELECT session_id FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1 ORDER BY session_id', [first.unit.id])).rows.map(row => logicalId('session', row.session_id))
      const reservation = await reserveCatalogSleep(pool, prepareCatalogCall('worktree.sleep', { worktree: first.workspace.publicId }, context), {
        preparedAttemptId: null, request: { unitId: first.unit.id, actorId: authority.principalId,
          discoveredMembers: members, expectedRevision: unit.revision, expectedIntentRevision: unit.intent_revision,
          policy: first.policy, activityFreshnessMs: 1000, activity: null }
      }, owners)
      assert.notEqual(reservation.status, 'UNCERTAIN')
      if (reservation.status !== 'UNCERTAIN') {assert.deepEqual((reservation.receipt.response as { reservation: unknown }).reservation,
        { status: 'DEFERRED', reason: 'SESSION_CLOSING' })}
    })

    await t.test('stale physical tuple fails; exact synthetic retirement never resurrects a CLOSED Tab', async () => {
      // Synthetic persisted observations exercise the Catalog guard only. They do
      // not qualify physical-proof issuance, a provider, Pod, PTY or live transport.
      const attempt = (await query('SELECT active_attempt_id FROM durable_runtime.runtime_units WHERE id=$1', [first.unit.id])).rows[0].active_attempt_id
      const publicationEpoch = (await query('SELECT publication_epoch FROM durable_runtime.catalog_heads WHERE scope=$1', [`workspace:${first.workspace.id}`])).rows[0].publication_epoch
      await query('UPDATE durable_runtime.attempts SET pod_uid=$2 WHERE id=$1', [attempt, 'synthetic-pod'])
      await query(`UPDATE durable_runtime.catalog_tab_metadata SET
        payload=payload||$2::jsonb,binding_revision=binding_revision+1 WHERE tab_id=$1`, [first.tab.id,
        JSON.stringify({ ptyId: 'synthetic-pty', incarnationId: 'synthetic-incarnation', status: 'ready', terminal: first.tab.terminalHandle })])
      const observation = Object.freeze({ workspaceSelector: first.workspace.publicId, publicTabId: first.tab.publicId,
        publicationEpoch, expectedBindingRevision: '1', runtimeUnitId: first.unit.id, attemptId: attempt,
        executionEpoch: '1', podUid: 'synthetic-pod', terminalHandle: first.tab.terminalHandle,
        ptyId: 'synthetic-pty', incarnationId: 'synthetic-incarnation', kind: 'STOPPED', evidenceRef: 'synthetic-evidence' }) as PreparedCatalogBindingObservation
      const lifecycleCall = prepareCatalogCall('session.tabs.closeLifecycle', { worktree: first.workspace.publicId,
        tabId: first.tab.parentTabId, leafId: first.tab.leafId, publicationEpoch, terminal: first.tab.terminalHandle, reason: 'pty-exit' }, context)
      const stale = Object.freeze({ ...observation, incarnationId: 'synthetic-stale-incarnation' })
      await assert.rejects(applyCatalogBindingObservation(pool, lifecycleCall, stale,
        { isPinned: candidate => candidate === stale }))
      await applyCatalogBindingObservation(pool, lifecycleCall, observation, { isPinned: candidate => candidate === observation })
      assert.equal((await query('SELECT lifecycle FROM durable_runtime.tabs WHERE id=$1', [first.tab.id])).rows[0].lifecycle, 'CLOSED')
      assert.equal((await query("SELECT payload->'ptyId' AS pty FROM durable_runtime.catalog_tab_metadata WHERE tab_id=$1", [first.tab.id])).rows[0].pty, null)
    })
  } finally { await pool.end() }
})
