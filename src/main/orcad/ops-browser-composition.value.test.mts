import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import { createOrcadOpsBrowserSessionOwner } from './orcad-ops-browser-session-owner.ts'
import { createRuntimeOpsBearerVerifier, snapshotRuntimeOpsHttpConfig } from '../durable-runtime/ops/runtime-config.ts'
import { createOpsHttpHandler } from '../durable-runtime/ops/handler.ts'
import type { OpsHttpServices } from '../durable-runtime/ops/types.ts'
import { captureDurableCatalogReadConfig } from '../durable-runtime/rpc/config.ts'
import { captureCatalogAuthenticatedContext } from '../durable-runtime/rpc/context.ts'
import { createCatalogBrowserCreateRpc } from '../durable-runtime/rpc/browser-create.ts'
import { fixtureConfig, fixtureContext, fixtureRuntime, syntheticFingerprint } from '../durable-runtime/rpc/fixture-support.mts'
import { captureBrowserTabCreateCaller } from '../runtime/browser-ops-auth-capability.ts'

const origin = 'https://ops.example.test:8443'
const scope = { datasetName: 'orca-1012-dev-v1', namespaceId: 'synthetic-composition',
  workspaceIds: ['00000000-0000-4000-8000-000000000001'] }
function services(): OpsHttpServices {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected fixture route') }
  return { units: async () => ({ units: [], observedAt: null }), unit: unexpected, operation: unexpected,
    events: unexpected, notifications: unexpected, readNotification: unexpected, command: unexpected }
}
function request(handler: ReturnType<typeof createOpsHttpHandler>, authorization?: string, requestOrigin = origin): Promise<number> {
  return new Promise(resolve => {
    const incoming = Object.assign(new EventEmitter(), { url: '/ops/v1/runtime-units', method: 'GET', complete: true,
      headers: { origin: requestOrigin, ...(authorization === undefined ? {} : { authorization }) } })
    const outgoing = Object.assign(new EventEmitter(), { statusCode: 200, headersSent: false, writableEnded: false,
      destroyed: false, setHeader() {}, end(this: EventEmitter & { writableEnded: boolean; statusCode: number }) { this.writableEnded = true; this.emit('finish'); resolve(this.statusCode) } })
    assert.equal(handler(incoming as IncomingMessage, outgoing as unknown as ServerResponse), true)
  })
}

test('Ops Browser composition preserves authenticated capture, HTTP authority and startup ownership', { timeout: 10000 }, async t => {
  await t.test('one authority connects the bounded issuer and actual HTTP verifier; explicit invalid auth is not replaced', async t => {
    let stops = 0
    const owner = createOrcadOpsBrowserSessionOwner({ async stop() { stops++ } })
    const composed = owner.connect({ origin, scope, streamId: 'synthetic-stream', pollIntervalMs: 10, services: services() })
    const session = composed.browserOpsAuth.issuePageSession({ authenticatedCallerFingerprint: syntheticFingerprint,
      browserPageId: 'synthetic-page', worktreePublicId: 'synthetic-worktree' })
    const verified = snapshotRuntimeOpsHttpConfig(composed.opsHttp)
    const actor = await verified.authenticateBrowserBearer?.(session.readBearer())
    assert.equal(actor?.principalId, `pairing-sha256:${syntheticFingerprint}`)
    assert.deepEqual(actor?.workspaceIds, scope.workspaceIds)
    const verify = createRuntimeOpsBearerVerifier(verified, token => token === 'fixture-manual-key' ? actor ?? null : null)
    const handler = createOpsHttpHandler({ ...verified, authenticateBearer: verify })
    t.after(async () => { await handler.stop(); await owner.stop() })
    assert.equal(await request(handler, `Bearer ${session.readBearer()}`), 200)
    assert.equal(await request(handler, 'Bearer fixture-manual-key'), 200)
    assert.equal(await request(handler, 'Bearer fixture-invalid-explicit-key'), 401)
    assert.equal(await request(handler), 401)
    assert.equal(await request(handler, `Bearer ${session.readBearer()}`, 'https://foreign.example.test'), 403)
    const done = owner.stop(); assert.equal(owner.stop(), done); await done
    assert.equal(stops, 1)
    assert.throws(() => session.readBearer(), { code: 'OPS_BROWSER_SESSION_CLOSED' })
    assert.throws(() => owner.connect(composed.opsHttp), /OPS_STARTUP_UNAVAILABLE/)
  })
  await t.test('early startup stop prevents a late authority and borrowed owner stops once', async () => {
    let stops = 0
    const owner = createOrcadOpsBrowserSessionOwner({ async stop() { stops++ } })
    await owner.stop(); await owner.stop()
    assert.throws(() => owner.assertOpen(), /OPS_STARTUP_UNAVAILABLE/)
    assert.throws(() => owner.connect({ origin, scope, streamId: 'fixture', pollIntervalMs: 10, services: services() }))
    assert.equal(stops, 1)
  })
  await t.test('private config rejects accessors without invoking them and snapshots issuer/verifier receivers', async () => {
    let getterReads = 0, issues = 0
    const borrowed = { connect() { throw new Error('PG must not run') } } as unknown as Pool
    const issuer = { origin, issuePageSession() { assert.equal(this, issuer); issues++; throw new Error('Synthetic issue boundary') } }
    const config = { ...fixtureConfig(borrowed), browserOpsAuth: issuer }
    const captured = captureDurableCatalogReadConfig(config)
    issuer.issuePageSession = () => { throw new Error('Replacement issuer consulted') }
    assert.throws(() => captured.browserOpsAuth?.issuePageSession({ authenticatedCallerFingerprint: syntheticFingerprint,
      browserPageId: 'page', worktreePublicId: 'workspace' }), /Synthetic issue boundary/)
    assert.equal(issues, 1)
    const accessor = Object.defineProperty({ ...fixtureConfig(borrowed) }, 'browserOpsAuth', {
      get() { getterReads++; return issuer }
    })
    assert.throws(() => captureDurableCatalogReadConfig(accessor), /CATALOG_SERVER_CONFIG/)
    assert.equal(getterReads, 0)
    const raw = { origin, scope, streamId: 'fixture', pollIntervalMs: 10, services: services(),
      authenticateBrowserBearer() { assert.equal(this, raw); return null } }
    const snap = snapshotRuntimeOpsHttpConfig(raw)
    raw.authenticateBrowserBearer = () => { throw new Error('Replacement verifier consulted') }
    assert.equal(await snap.authenticateBrowserBearer?.('synthetic-rejected-token'), null)
  })
  await t.test('the authenticated fingerprint is read once and PG/native failure before OPEN issues no session', async () => {
    let checkouts = 0, issues = 0, reads = 0, nativeCalls = 0
    const pool = { connect() { checkouts++; throw Object.assign(new Error('Synthetic first checkout failed'), { code: 'Z0001' }) } } as unknown as Pool
    const captured = captureDurableCatalogReadConfig({ ...fixtureConfig(pool), browserOpsAuth: { origin,
      issuePageSession() { issues++; throw new Error('Premature issuer') } } })
    const runtime = fixtureRuntime()
    Object.defineProperty(runtime.runtime, 'browserTabCreate', { value() { nativeCalls++; throw new Error('Premature native') } })
    const context = Object.defineProperty(fixtureContext(runtime.runtime), 'authenticatedCallerFingerprint', {
      get() { reads++; return syntheticFingerprint }
    })
    const direct = captureCatalogAuthenticatedContext(captured, context)
    assert.equal(direct.authenticatedCallerFingerprint, syntheticFingerprint); assert.equal(reads, 1)
    reads = 0
    await assert.rejects(createCatalogBrowserCreateRpc(captured)({ worktree: 'synthetic-worktree', page: 'synthetic-page', url: 'about:blank' }, context))
    assert.equal(reads, 1); assert.equal(checkouts, 1); assert.equal(issues, 0); assert.equal(nativeCalls, 0)
    const accessor = Object.defineProperty({}, 'opsAuth', { get() { throw new Error('Private caller accessor read') } })
    assert.throws(() => captureBrowserTabCreateCaller(accessor), { code: 'browser_ops_auth_unavailable' })
  })
})
