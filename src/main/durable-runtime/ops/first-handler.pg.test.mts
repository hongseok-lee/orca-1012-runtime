import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { Pool } from 'pg'
import { DeviceRegistry } from '../../runtime/device-registry.ts'
import { createDurablePool } from '../db/connection.ts'
import { fixture, policy } from '../lifecycle/verification-fixtures.mts'
import { notificationSource, hookPool, gate } from '../replay/test-support.mts'
import { publishClaimToReplay, OPS_REPLAY_STREAM } from '../replay/index.ts'
import { createOpsHttpHandler } from './handler.ts'
import { createPgOpsServices } from './pg-services.ts'
import { createDeviceRegistryOpsVerifier, type OpsServerScope } from './auth.ts'
import { encodeOpsAfter } from './cursor.ts'
import type { OpsHttpConfig, OpsHttpHandler, OpsHttpServices, OpsActor } from './types.ts'
import type { OpsReplayPage, OpsUnitList } from './contract.ts'

// Prepared first fixtures only. DB owner stages the pinned migrations; this file creates no DDL.
let pool: Pool
type MutableConfig = { -readonly [K in keyof OpsHttpConfig]: OpsHttpConfig[K] }
const open = new Set<{ server: Server; handler: OpsHttpHandler; directory: string }>()
before(async () => {
  assert.match(process.env.PGDATABASE ?? '', /^orca_p126_[a-z0-9_]+$/)
  pool = createDurablePool({ max: 6 })
  assert.equal((await pool.query("SELECT count(*)::text AS n FROM durable_runtime.schema_migrations WHERE version='014-durable-catalog.sql'")).rows[0].n, '1')
})
after(async () => {
  for (const owner of open) {
    await owner.handler.stop(); owner.server.closeAllConnections()
    await new Promise<void>(resolve => owner.server.close(() => resolve()))
    await rm(owner.directory, { recursive: true, force: true })
  }
  await pool?.end()
})
async function seed() {
  const f = await fixture(pool, 1)
  const workspace = (await pool.query('SELECT workspace_id FROM durable_runtime.sessions WHERE id=$1', [f.sessions[0]])).rows[0].workspace_id as string
  const group = `p126-fixture:${randomUUID()}`
  await pool.query('INSERT INTO durable_runtime.catalog_project_groups(id,payload) VALUES($1,$2)', [group, { id: group }])
  await pool.query(`INSERT INTO durable_runtime.catalog_workspace_metadata(workspace_id,kind,project_group_id,reserved_path,payload,create_request,runtime_unit_id)
    VALUES($1,'FOLDER_WORKSPACE',$2,$3,'{}','{}',$4)`, [workspace, group, `/fixture/${workspace}`, f.unit])
  const scope = { datasetName: 'orca-1012-dev-v1', namespaceId: `p126:${workspace}`, workspaceIds: [workspace] }
  return { ...f, workspace, scope, target: { runtimeUnitId: f.unit, sessionIds: f.sessions } }
}
function services(scope: OpsServerScope, selectedPool = pool): OpsHttpServices {
  return createPgOpsServices({ pool: selectedPool, scope, streamId: OPS_REPLAY_STREAM, lifecyclePolicy: policy, controllerConnected: false })
}
async function serve(scope: OpsServerScope, selected: OpsHttpServices, modify?: (config: MutableConfig) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'p126-owned-registry-'))
  const registry = new DeviceRegistry(directory)
  const device = registry.addDevice('P126 isolated HTTP fixture', 'mobile', 'this-computer')
  let handler!: OpsHttpHandler
  const server = createServer((req, res) => { if (!handler(req, res)) { res.statusCode = 404; res.end('static fallback fixture') } })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const origin = `http://127.0.0.1:${address.port}`
  const config: MutableConfig = { origin, streamId: OPS_REPLAY_STREAM, services: selected,
    authenticateBearer: createDeviceRegistryOpsVerifier(registry, scope), pollIntervalMs: 10 }
  modify?.(config); handler = createOpsHttpHandler(config)
  open.add({ server, handler, directory })
  return { handler, server, origin, config, registry, headers: { Authorization: `Bearer ${device.token}` },
    get: (path: string, extra: Record<string, string> = {}) => fetch(origin + path, { headers: { Authorization: `Bearer ${device.token}`, ...extra } }),
    post: (path: string, body: unknown) => fetch(origin + path, { method: 'POST', headers: { Authorization: `Bearer ${device.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }
}
async function revisions(id: string) {
  return (await pool.query('SELECT revision,intent_revision FROM durable_runtime.runtime_units WHERE id=$1', [id])).rows[0]
}
async function unitState(id: string) {
  return (await pool.query('SELECT to_jsonb(u) AS state FROM durable_runtime.runtime_units u WHERE id=$1', [id])).rows
}
async function firstFrame(response: Response) {
  assert.equal(response.status, 200); assert.ok(response.body)
  const reader = response.body.getReader(); let text = ''
  while (!text.includes('\n\n')) { const chunk = await reader.read(); assert.equal(chunk.done, false); text += new TextDecoder().decode(chunk.value) }
  return { text, reader }
}

test('actual existing-key verification rejects invalid and cookie-only credentials and cross origin', async () => {
  const f = await seed(), h = await serve(f.scope, services(f.scope))
  assert.equal((await h.get('/ops/v1/runtime-units')).status, 200)
  assert.equal((await fetch(h.origin + '/ops/v1/runtime-units', { headers: { Authorization: 'Bearer invalid-fixture' } })).status, 401)
  assert.equal((await fetch(h.origin + '/ops/v1/runtime-units', { headers: { Cookie: 'fixture=session' } })).status, 401)
  assert.equal((await h.get('/ops/v1/runtime-units', { Origin: 'https://cross-origin.invalid' })).status, 403)
  assert.equal((await h.get('/ops/v1/runtime-units', { Origin: h.origin })).status, 200)
})

test('original config/services receivers and actor scope survive method replacement across awaits', async () => {
  const f = await seed(), selected = services(f.scope), authGate = gate(), serviceGate = gate()
  let authReceiver = false, serviceReceiver = false
  const originalUnits = selected.units.bind(selected)
  const mutable: OpsHttpServices = { ...selected, async units(actor) {
    serviceReceiver = this === mutable; serviceGate.signal(); await serviceGate.wait
    assert.deepEqual(actor.workspaceIds, [f.workspace]); return originalUnits(actor)
  } }
  const returned: { actor: OpsActor | null } = { actor: null }
  const h = await serve(f.scope, mutable, config => {
    const verify = config.authenticateBearer.bind(config)
    config.authenticateBearer = async function (token) {
      authReceiver = this === config; authGate.signal(); await authGate.wait
      const valid = await verify(token); returned.actor = valid ? { ...valid, workspaceIds: [...valid.workspaceIds] } : null
      return returned.actor
    }
  })
  const pending = h.get('/ops/v1/runtime-units'); await authGate.entered
  h.config.authenticateBearer = () => { throw new Error('replacement verifier must not run') }
  mutable.units = async () => { throw new Error('replacement service must not run') }
  f.scope.namespaceId = 'replacement-namespace'; f.scope.workspaceIds = []
  authGate.release(); await serviceGate.entered
  if (returned.actor) { (returned.actor.workspaceIds as string[]).length = 0 }
  serviceGate.release(); assert.equal((await pending).status, 200)
  assert.equal(authReceiver, true); assert.equal(serviceReceiver, true)
})

test('stored workspace anchors prevent namespace leaks and query failure differs from empty', async () => {
  const f = await seed(), other = await seed(), h = await serve(f.scope, services(f.scope))
  const before = await unitState(f.unit)
  const list = await (await h.get('/ops/v1/runtime-units')).json() as OpsUnitList
  assert.deepEqual(list.units.map(u => u.id), [f.unit]); assert.equal(list.units[0].resources.usage, null)
  assert.equal(list.units[0].availableActions.find(a => a.action === 'wake')?.enabled, false)
  assert.equal((await h.get(`/ops/v1/runtime-units/${other.unit}`)).status, 403)
  assert.equal((await h.get(`/ops/v1/runtime-units/${randomUUID()}`)).status, 404)
  assert.equal((await h.get(`/ops/v1/runtime-units/${f.unit}`)).status, 200)
  assert.deepEqual(await unitState(f.unit), before)
  const emptyScope = { ...f.scope, workspaceIds: [] }, empty = await serve(emptyScope, services(emptyScope))
  assert.deepEqual((await (await empty.get('/ops/v1/runtime-units')).json()).units, [])
  const failing = hookPool(pool, async (sql, _client, execute) => { if (sql.includes('SELECT DISTINCT u.id')) { throw new Error('private SQL fixture must not leak') }; return execute() })
  const broken = await serve(f.scope, services(f.scope, failing)), response = await broken.get('/ops/v1/runtime-units')
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: { code: 'unavailable', message: 'The operations service could not confirm the result.' } })
})

test('HTTP wake preserves receipt replay after tombstone and member removal, conflict and actual operation', async () => {
  const f = await seed(), h = await serve(f.scope, services(f.scope)), row = await revisions(f.unit)
  const body = { operationId: randomUUID(), expectedRevision: row.revision, action: 'wake', params: { expectedIntentRevision: row.intent_revision } }
  const first = await h.post(`/ops/v1/runtime-units/${f.unit}/commands`, body); assert.equal(first.status, 202)
  const accepted = await first.json(); assert.equal(accepted.receipt, 'COMMITTED')
  const operation = await (await h.get(`/ops/v1/operations/${accepted.operationId}`)).json()
  assert.equal(operation.disposition, 'queued'); assert.equal(operation.step, 'INTENT_QUEUED')
  await pool.query("UPDATE durable_runtime.sessions SET lifecycle='CLOSED' WHERE id=$1", [f.sessions[0]])
  await pool.query('DELETE FROM durable_runtime.runtime_members WHERE runtime_unit_id=$1', [f.unit])
  await pool.query("UPDATE durable_runtime.runtime_units SET desired_mode='DELETED',intent_revision=intent_revision+1,revision=revision+1 WHERE id=$1", [f.unit])
  const replay = await h.post(`/ops/v1/runtime-units/${f.unit}/commands`, body); assert.equal(replay.status, 202)
  assert.equal((await replay.json()).operationId, accepted.operationId)
  assert.equal((await h.post(`/ops/v1/runtime-units/${f.unit}/commands`, { ...body, expectedRevision: '999' })).status, 409)
  assert.equal((await h.post(`/ops/v1/runtime-units/${f.unit}/commands`, { ...body, operationId: randomUUID() })).status, 409)
  assert.equal((await revisions(f.unit)).intent_revision, '1')
})

test('notification read remains OPEN, preserves original receipt and changes no Unit activity', async () => {
  const f = await seed(), source = await notificationSource(pool, f.target), h = await serve(f.scope, services(f.scope))
  const before = await unitState(f.unit)
  const current = (await pool.query('SELECT revision FROM durable_runtime.notifications WHERE id=$1', [source.notificationId])).rows[0]
  const body = { operationId: randomUUID(), expectedRevision: current.revision }, path = `/ops/v1/notifications/${source.notificationId}/read`
  const first = await h.post(path, body); assert.equal(first.status, 200)
  const result = await first.json(); assert.equal(result.state, 'OPEN'); assert.equal(result.resolvedAt, null); assert.ok(result.readAt)
  assert.deepEqual(await (await h.post(path, body)).json(), result)
  assert.equal((await h.post(path, { ...body, expectedRevision: '999' })).status, 409)
  assert.deepEqual(await unitState(f.unit), before)
  const foreign = await seed(), n = await notificationSource(pool, foreign.target)
  assert.equal((await h.post(`/ops/v1/notifications/${n.notificationId}/read`, body)).status, 403)
  const listed = await (await h.get('/ops/v1/notifications')).json()
  assert.ok(listed.notifications.every((x: { target: { runtimeUnitId: string } }) => x.target.runtimeUnitId === f.unit))
})

test('PAGE to SSE preserves filtered global cursor, reset and Last-Event-ID conflict', async () => {
  const f = await seed(), foreign = await seed(), source = await notificationSource(pool, foreign.target)
  await publishClaimToReplay(pool, { claim: source.claim })
  const h = await serve(f.scope, services(f.scope)), before = await unitState(f.unit)
  const page = await (await h.get(`/ops/v1/events?unit=${f.unit}`)).json() as OpsReplayPage
  assert.equal(page.status, 'PAGE'); if (page.status !== 'PAGE') { throw new Error('expected PAGE') }
  assert.equal(page.events.length, 0); assert.ok(BigInt(page.nextCursor.offset) > 0n)
  const after = encodeOpsAfter(page.nextCursor)
  const first = await firstFrame(await h.get(`/ops/v1/events/stream?unit=${f.unit}&after=${after}`))
  assert.ok(first.text.includes(`id: ${after}\nevent: page`)); await first.reader.cancel()
  const wrong = encodeOpsAfter({ ...page.nextCursor, epoch: String(BigInt(page.nextCursor.epoch) + 1n) })
  assert.equal((await h.get(`/ops/v1/events/stream?after=${after}`, { 'Last-Event-ID': wrong })).status, 400)
  const reset = await firstFrame(await h.get(`/ops/v1/events/stream?after=${wrong}`))
  assert.ok(reset.text.includes('event: reset')); await reset.reader.cancel()
  assert.equal((await h.get(`/ops/v1/events/stream?unit=${foreign.unit}`)).status, 403)
  assert.deepEqual(await unitState(f.unit), before)
})

test('stop ends pending unary and SSE, disconnect drops late results without extra polling', async () => {
  const f = await seed(), waiting = gate(), selected = services(f.scope)
  const pendingService: OpsHttpServices = { ...selected, async units(actor) { waiting.signal(); await waiting.wait; return selected.units(actor) } }
  const h = await serve(f.scope, pendingService), pending = h.get('/ops/v1/runtime-units')
  await waiting.entered; await h.handler.stop(); assert.equal((await pending).status, 503); waiting.release()
  const counting: OpsHttpServices = { ...selected, async events(actor, query) { return selected.events(actor, query) } }
  const tail = await serve(f.scope, counting), stream = await firstFrame(await tail.get('/ops/v1/events/stream'))
  await tail.handler.stop(); let next = await stream.reader.read()
  while (!next.done) { next = await stream.reader.read() }
  const late = gate(); let lateCalls = 0
  const delayed: OpsHttpServices = { ...selected, async events(actor, query) {
    lateCalls++; if (lateCalls === 2) { late.signal(); await late.wait }; return selected.events(actor, query)
  } }
  const disconnected = await serve(f.scope, delayed), disconnect = await firstFrame(await disconnected.get('/ops/v1/events/stream'))
  await late.entered; await disconnect.reader.cancel(); late.release()
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(lateCalls, 2)

})

test('real COMMIT reply loss returns 503 and same identity retry finds the original admission', async () => {
  const f = await seed(); let fired = false
  // Trigger only the mutation COMMIT, not the preceding read-only authorization transaction.
  let mutation = false
  const exactLost = hookPool(pool, async (sql, _client, execute) => {
    if (sql.includes('INSERT INTO durable_runtime.rpc_receipts')) { mutation = true }
    const result = await execute()
    if (sql === 'COMMIT' && mutation && !fired) { fired = true; throw new Error('fixture discards real mutation COMMIT reply') }
    return result
  })
  const h = await serve(f.scope, services(f.scope, exactLost)), row = await revisions(f.unit)
  const body = { operationId: randomUUID(), expectedRevision: row.revision, action: 'wake', params: { expectedIntentRevision: row.intent_revision } }
  assert.equal((await h.post(`/ops/v1/runtime-units/${f.unit}/commands`, body)).status, 503)
  const retry = await h.post(`/ops/v1/runtime-units/${f.unit}/commands`, body); assert.equal(retry.status, 202)
  assert.equal((await retry.json()).receipt, 'REPLAYED')
  assert.equal((await pool.query('SELECT count(*)::text AS n FROM durable_runtime.operations WHERE runtime_unit_id=$1', [f.unit])).rows[0].n, '1')
})

test('request schema, counters, unsupported actions and unowned URLs retain distinct responses', async () => {
  const f = await seed(), h = await serve(f.scope, services(f.scope))
  assert.equal((await h.get('/ops/v1/runtime-units/not-a-uuid')).status, 400)
  assert.equal((await h.get('/ops/v1/events?after=not-json')).status, 400)
  const base = { operationId: randomUUID(), expectedRevision: '0', action: 'wake', params: { expectedIntentRevision: '0' } }
  assert.equal((await h.post(`/ops/v1/runtime-units/${f.unit}/commands`, { ...base, expectedRevision: '9223372036854775808' })).status, 400)
  assert.equal((await h.post(`/ops/v1/runtime-units/${f.unit}/commands`, { ...base, action: 'sleep', params: {} })).status, 501)
  assert.equal((await fetch(h.origin + '/ops/v1/runtime-units/' + f.unit + '/commands', { method: 'POST', headers: h.headers, body: '{}' })).status, 400)
  assert.equal(await (await h.get('/unowned')).text(), 'static fallback fixture')
})
