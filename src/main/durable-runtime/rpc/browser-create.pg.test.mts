import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool, PoolClient } from 'pg'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { createCatalogBrowserCreateRpc } from './browser-create.ts'
import { captureDurableCatalogReadConfig } from './config.ts'
import { deferred, fixtureConfig, fixtureContext, fixtureRuntime, syntheticFingerprint } from './fixture-support.mts'
import { closeCatalogTab } from '../catalog/close.ts'
import { prepareCatalogCall } from '../catalog/request.ts'
import { captureCatalogReadContext } from './context.ts'
import { recordUnitIntent } from '../lifecycle/intent.ts'
import { reserveSleep } from '../lifecycle/sleep.ts'
import { recordInputCancel } from '../input/cancel.ts'
import { createOrcadCatalogBrowserPublication } from '../../orcad/orcad-catalog-browser-publication.ts'

if (process.env.ORCA_PUBLIC_BROWSER_PG_APPROVED !== 'root-source-reviewed' ||
    !(process.env.PGDATABASE ?? '').startsWith('orca_public_browser_')) {
  throw new Error('Root Browser create allocation and migrated isolated DB required')
}

await test('PG 예약 뒤 합성 중앙 Browser create, 원행 보존과 closed/uncertain 경계를 확인합니다', async () => {
  const pool = createDurablePool({ max: 3, statement_timeout: 10000 })
  const query = (sql: string, values: readonly unknown[] = []) => withDurableTransaction(pool, tx => tx.query(sql, values))
  const workspaceId = logicalId('workspace', randomUUID())
  const folderId = `synthetic-public-browser:${workspaceId}`
  const publicId = `folder:${folderId}`
  const groupId = `synthetic-public-browser-group:${randomUUID()}`
  const owner = fixtureRuntime()
  type CreateParams = Parameters<typeof owner.runtime.browserTabCreate>[0]
  type Caller = Parameters<typeof owner.runtime.browserTabCreate>[1]
  const calls: { params: CreateParams; caller: Caller }[] = []
  let closeCalls = 0, mode: 'normal' | 'failure' | 'mismatch' | 'close' = 'normal'
  let mutationTransactions = 0, delayed = true, uncertainCommit = false
  let replaySeed = false
  const gate = deferred<void>()
  const entered = deferred<void>()
  const nativeFailure = new Error('Synthetic central Browser failure')
  const owners = { recordUnitIntent, reserveSleep, recordInputCancel }
  const closeLogical = (page: string, closePool = pool) => {
    const config = captureDurableCatalogReadConfig({ ...fixtureConfig(closePool), workspacePublicIds: [publicId] })
    const call = prepareCatalogCall('session.tabs.close', { worktree: publicId, tabId: page },
      captureCatalogReadContext(config, fixtureContext(owner.runtime)))
    return closeCatalogTab(closePool, call, publicId, { inputAuthorities: [] }, owners)
  }
  let holdPublicationCommit = false, guardBackendPid = 0
  const publicationCommitEntered = deferred<void>(), publicationCommitRelease = deferred<void>()
  const protectedTables = ['agents', 'sessions', 'runtime_units', 'runtime_members', 'operations', 'attempts',
    'execution_grants', 'storage_bindings', 'storage_write_grants', 'storage_mounts', 'resource_profiles']
  const protectedState = async () => {
    const state: Record<string, unknown> = {}
    for (const table of protectedTables) {
      state[table] = (await query(`SELECT to_jsonb(r) AS row FROM durable_runtime.${table} r ORDER BY to_jsonb(r)::text`)).rows
    }
    return state
  }
  const tab = async (page: string) => (await query(`SELECT t.*,m.public_tab_id,m.payload,m.launch_request FROM
    durable_runtime.tabs t JOIN durable_runtime.catalog_tab_metadata m ON m.tab_id=t.id WHERE m.public_tab_id=$1`, [page])).rows[0]
  const receipts = async (page: string) => (await query(`SELECT * FROM durable_runtime.rpc_receipts
    WHERE response=$1::jsonb ORDER BY operation_key`, [JSON.stringify({ browserPageId: page })])).rows
  const nativeCreate = async function (this: typeof owner.runtime, params: CreateParams, caller: Caller) {
    assert.equal(this, owner.runtime)
    assert.equal(mutationTransactions, 0, 'native must run after SQL transaction commit/release')
    assert.ok(params.page)
    const stored = await tab(params.page)
    assert.equal(stored.kind, 'browser')
    assert.equal(stored.lifecycle, 'OPEN')
    assert.equal(stored.workspace_id, workspaceId)
    assert.equal(stored.public_tab_id, params.page)
    assert.ok((await receipts(params.page)).length > 0, 'committed receipt must precede native')
    calls.push({ params: { ...params }, caller: caller === undefined ? undefined : { ...caller } })
    if (mode === 'failure') { throw nativeFailure }
    if (mode === 'close') {
      await closeLogical(params.page)
    }
    return { browserPageId: mode === 'mismatch' ? 'synthetic-wrong-native-page' : params.page }
  }
  Object.defineProperty(owner.runtime, 'browserTabCreate', { configurable: true, value: nativeCreate })
  Object.defineProperty(owner.runtime, 'browserTabClose', { value() { closeCalls++; throw new Error('Unproven generation close') } })
  // Per-client SQL fault injection only. Actual factory and reservation core stay unchanged.
  const carrier: Pool = Object.create(pool)
  const borrowed = new Proxy(carrier, { get(_target, property) {
    if (property !== 'connect') {
      const value = Reflect.get(pool, property, pool)
      return typeof value === 'function' ? value.bind(pool) : value
    }
    return async () => {
      if (delayed) { delayed = false; entered.resolve(); await gate.promise }
      const client = await pool.connect()
      if (holdPublicationCommit) { guardBackendPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid }
      let mutation = false
      const clientCarrier: PoolClient = Object.create(client)
      return new Proxy(clientCarrier, { get(_clientTarget, key) {
        if (key !== 'query') {
          const value = Reflect.get(client, key, client)
          return typeof value === 'function' ? value.bind(client) : value
        }
        return async (sql: string, values: unknown[] = []) => {
          if (sql === 'BEGIN ISOLATION LEVEL READ COMMITTED') { mutation = true; mutationTransactions++ }
          if (replaySeed && mutation && sql.startsWith('SELECT payload_hash,response,committed_at,intake_at')) {
            replaySeed = false
            // Browser's legacy public params have no stable retry key. Seed a same-key
            // existing receipt at the SQL seam to cover the core's replay branch;
            // this is NOT proof that a new public invocation can reuse its old key.
            await client.query(`INSERT INTO durable_runtime.rpc_receipts
              (principal_id,session_scope,method,operation_key,payload_hash,response,intake_at)
              SELECT $1,$2,$3,$4,payload_hash,response,intake_at FROM durable_runtime.rpc_receipts
              WHERE principal_id=$1 AND session_scope=$2 AND method=$3 AND response=$5::jsonb
              ORDER BY committed_at LIMIT 1`, [...values, JSON.stringify({ browserPageId: replayPage })])
          }
          if (mutation && sql === 'COMMIT' && holdPublicationCommit) {
            holdPublicationCommit = false
            publicationCommitEntered.resolve()
            await publicationCommitRelease.promise
          }
          const result = await client.query(sql, values)
          if (mutation && (sql === 'COMMIT' || sql === 'ROLLBACK')) {
            mutation = false
            mutationTransactions--
            if (sql === 'COMMIT' && uncertainCommit) {
              uncertainCommit = false
              // Real isolated PG commits; only observation fails. Never rerun body.
              throw Object.assign(new Error('Synthetic COMMIT observation lost'), { code: '08006' })
            }
          }
          return result
        }
      } })
    }
  })
  const replayPage = randomUUID()
  try {
    assert.equal((await query('SELECT dataset_name FROM durable_runtime.dataset_metadata')).rows[0].dataset_name, 'orca-1012-dev-v1')
    await query("INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES('catalog',$1) ON CONFLICT(scope) DO NOTHING", [randomUUID()])
    await query('INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)', [groupId, JSON.stringify({ id: groupId })])
    const payload: FolderWorkspace = { id: folderId, projectGroupId: groupId, name: 'Synthetic public Browser',
      folderPath: `/synthetic/public-browser/${workspaceId}`, comment: '', linkedTask: null,
      createdAt: 7, updatedAt: 7, lastActivityAt: 7, sortOrder: 0, isArchived: false, isUnread: false, isPinned: false }
    await query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,$3,'PENDING')", [workspaceId, publicId, payload.name])
    await query(`INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,project_group_id,reserved_path,payload,create_request)
      VALUES($1,'FOLDER_WORKSPACE',$2,$3,$4,'{}')`, [workspaceId, groupId, payload.folderPath, JSON.stringify(payload)])
    await query('INSERT INTO durable_runtime.catalog_heads(scope,publication_epoch) VALUES($1,$2)', [`workspace:${workspaceId}`, randomUUID()])
    const protectedBefore = await protectedState()
    const config = captureDurableCatalogReadConfig({ ...fixtureConfig(borrowed), workspacePublicIds: [publicId] })
    const handler = createCatalogBrowserCreateRpc(config)
    const context = () => fixtureContext(owner.runtime, { clientId: 'synthetic-credential-never-store' })
    const firstPage = randomUUID()
    const request = { worktree: `id:${publicId}`, page: firstPage, url: 'localhost:3000', profileId: 'default',
      activate: true, navigation: 'clients' as const, targetGroupId: 'synthetic-selected-group', waitForRegistration: false }
    const original = JSON.parse(JSON.stringify(request))
    const caller = context()
    const pending = handler(request, caller)
    await entered.promise
    request.url = 'https://changed-after-await.example/'
    request.worktree = 'outside'
    request.page = 'changed-after-await'
    request.activate = false
    request.targetGroupId = 'changed-after-await'
    caller.authenticatedCallerFingerprint = 'changed-after-await'
    caller.pairedDeviceId = 'changed-after-await'
    caller.clientKind = 'runtime'
    caller.clientCapabilities = []
    caller.runtime = fixtureRuntime().runtime
    Object.defineProperty(owner.runtime, 'browserTabCreate', { configurable: true, value() { throw new Error('Replacement function consulted') } })
    gate.resolve()
    assert.deepEqual(await pending, { browserPageId: firstPage })
    Object.defineProperty(owner.runtime, 'browserTabCreate', { configurable: true, value: nativeCreate })
    assert.deepEqual(calls[0], { params: { worktree: `id:${publicId}`, page: firstPage, url: 'http://localhost:3000/',
      profileId: 'default', activate: true, navigation: 'clients', targetGroupId: 'synthetic-selected-group', waitForRegistration: false },
      caller: { pairedDeviceId: 'synthetic-device', clientKind: 'mobile' } })
    const firstStored = await tab(firstPage)
    assert.deepEqual(firstStored.launch_request, { method: 'browser.tabCreate', paramsSupplied: true, params: original })
    assert.ok(!(JSON.stringify(firstStored).includes('synthetic-credential-never-store')))
    const firstReceipt = (await receipts(firstPage))[0]
    assert.equal(firstReceipt.principal_id, JSON.stringify(['catalog-host-fingerprint-v1', config.datasetName, 'local', syntheticFingerprint]))
    assert.ok(firstReceipt.operation_key.startsWith('legacy:'))
    await handler({ ...original, url: 'https://replacement.example/', activate: false, navigation: 'all' }, context())
    assert.equal(calls[1].params.url, 'http://localhost:3000/')
    assert.equal(calls[1].params.activate, false)
    assert.equal(calls[1].params.navigation, 'all')
    assert.deepEqual(await tab(firstPage), firstStored)
    const generatedRequest = { worktree: publicId, url: 'about:blank' }
    const generated = await handler(generatedRequest, context())
    const generatedStored = await tab(generated.browserPageId)
    assert.match(generated.browserPageId, /^[a-f0-9-]{36}$/)
    assert.notEqual(generatedStored.id, generated.browserPageId)
    assert.deepEqual(generatedStored.launch_request.params, generatedRequest)
    assert.equal(Object.hasOwn(generatedStored.launch_request.params, 'page'), false)
    mode = 'failure'
    const failedPage = randomUUID()
    await assert.rejects(handler({ worktree: publicId, page: failedPage }, context()), error => error === nativeFailure)
    assert.equal((await tab(failedPage)).lifecycle, 'OPEN')
    assert.equal((await receipts(failedPage)).length, 1)
    mode = 'mismatch'
    const mismatchPage = randomUUID()
    await assert.rejects(handler({ worktree: publicId, page: mismatchPage }, context()), /CATALOG_BROWSER_NATIVE_PAGE_MISMATCH/)
    assert.equal((await tab(mismatchPage)).lifecycle, 'OPEN')
    assert.equal((await receipts(mismatchPage)).length, 1)
    mode = 'normal'
    const uncertainPage = randomUUID(), nativeBeforeUncertain = calls.length
    uncertainCommit = true
    await assert.rejects(handler({ worktree: publicId, page: uncertainPage }, context()), /CATALOG_BROWSER_COMMIT_UNCERTAIN/)
    assert.equal(calls.length, nativeBeforeUncertain)
    assert.equal((await tab(uncertainPage)).lifecycle, 'OPEN')
    assert.equal((await receipts(uncertainPage)).length, 1)
    // Actual close-first: the real Catalog close transaction commits before the guard.
    const publication = createOrcadCatalogBrowserPublication(config)
    const wrongDataset = createOrcadCatalogBrowserPublication(captureDurableCatalogReadConfig({
      ...fixtureConfig(borrowed), workspacePublicIds: [publicId], datasetName: 'synthetic-wrong-dataset' }))
    await assert.rejects(wrongDataset(publicId, firstPage, () => { assert.fail('Wrong dataset published') }), /CATALOG_BROWSER_DATASET_MISMATCH/)
    const wrongHost = createOrcadCatalogBrowserPublication(captureDurableCatalogReadConfig({
      ...fixtureConfig(borrowed), workspacePublicIds: [publicId], hostId: 'ssh:synthetic-other', readHostIdentity: () => 'ssh:synthetic-other' }))
    await assert.rejects(wrongHost(publicId, firstPage, () => { assert.fail('Wrong host published') }), /CATALOG_REGISTRATION_HOST_MISMATCH/)
    await assert.rejects(publication(publicId, 'synthetic-unreserved-page', () => { assert.fail('Wrong page published') }), /CATALOG_BROWSER_PAGE_CONFLICT/)
    await closeLogical(failedPage)
    const closeFirstStored = await tab(failedPage)
    let publications = 0
    await assert.rejects(publication(publicId, failedPage, () => { publications++ }), /CATALOG_BROWSER_PAGE_CLOSED/)
    assert.equal(publications, 0)
    assert.deepEqual(await tab(failedPage), closeFirstStored)
    // Actual publication-first: pause only the guard's SQL COMMIT, after its sync
    // callback, and observe the real close blocked on its Workspace FOR UPDATE.
    const lockAttempted = deferred<void>()
    let closingBackendPid = 0, closeFinished = false
    const closeCarrier: Pool = Object.create(pool)
    const closePool = new Proxy(closeCarrier, { get(_target, property) {
      if (property !== 'connect') {
        const value = Reflect.get(pool, property, pool)
        return typeof value === 'function' ? value.bind(pool) : value
      }
      return async () => {
        const client = await pool.connect()
        const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
        const carrier: PoolClient = Object.create(client)
        return new Proxy(carrier, { get(_target, key) {
          if (key !== 'query') {
            const value = Reflect.get(client, key, client)
            return typeof value === 'function' ? value.bind(client) : value
          }
          return (sql: string, values: unknown[] = []) => {
            const result = client.query(sql, values)
            if (sql.includes('durable_runtime.workspaces') && sql.includes('FOR UPDATE')) {
              closingBackendPid = pid
              lockAttempted.resolve()
            }
            return result
          }
        } })
      }
    } })
    holdPublicationCommit = true
    const publishing = publication(publicId, generated.browserPageId, () => { publications++ })
    await publicationCommitEntered.promise
    assert.equal(publications, 1)
    const closing = closeLogical(generated.browserPageId, closePool).then(result => { closeFinished = true; return result })
    try {
      await lockAttempted.promise
      let blocked = false
      for (let observed = 0; observed < 64 && !blocked; observed++) {
        blocked = (await query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [closingBackendPid, guardBackendPid])).rows[0].blocked
      }
      assert.equal(blocked, true, 'exact close backend must wait for exact publication backend')
      assert.equal(closeFinished, false)
    } finally { publicationCommitRelease.resolve() }
    await Promise.all([publishing, closing])
    assert.equal((await tab(generated.browserPageId)).lifecycle, 'CLOSED')
    assert.equal(publications, 1)
    mode = 'close'
    const replayRequest = { worktree: publicId, page: replayPage, activate: true, navigation: 'caller' as const }
    await assert.rejects(handler(replayRequest, context()), /CATALOG_BROWSER_CLOSED_DURING_CREATE_CLEANUP_UNVERIFIED/)
    const closed = await tab(replayPage), originalReceipt = (await receipts(replayPage))[0]
    assert.equal(closed.lifecycle, 'CLOSED')
    assert.ok(closed.closed_at)
    const nativeBeforeReplay = calls.length
    mode = 'normal'
    replaySeed = true
    assert.deepEqual(await handler(replayRequest, context()), { browserPageId: replayPage })
    assert.equal(calls.length, nativeBeforeReplay)
    assert.deepEqual(await tab(replayPage), closed)
    await query('UPDATE durable_runtime.workspaces SET deleted_at=clock_timestamp() WHERE id=$1', [workspaceId])
    const deleted = (await query('SELECT * FROM durable_runtime.workspaces WHERE id=$1', [workspaceId])).rows[0]
    replaySeed = true
    assert.deepEqual(await handler(replayRequest, context()), { browserPageId: replayPage })
    assert.equal(calls.length, nativeBeforeReplay)
    assert.deepEqual(await tab(replayPage), closed)
    assert.deepEqual((await receipts(replayPage)).find(row => row.operation_key === originalReceipt.operation_key), originalReceipt)
    assert.deepEqual((await query('SELECT * FROM durable_runtime.workspaces WHERE id=$1', [workspaceId])).rows[0], deleted)
    assert.deepEqual(await protectedState(), protectedBefore)
    assert.equal(closeCalls, 0)
    assert.equal(mutationTransactions, 0)
    assert.equal(Object.isFrozen(pool), false)
    assert.deepEqual(owner.unexpected, [])
  } finally { await pool.end() }
})
