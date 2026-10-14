import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { captureDurableCatalogReadConfig } from './config.ts'
import { captureCatalogClipboardConfig } from './clipboard-config.ts'
import { captureOrcadDurableCatalogConfig, prepareOrcadDurableCatalog } from '../../orcad/orcad-durable-catalog.ts'
import { DurableCatalogReadAdapter } from './public.ts'
import { eraseRpcMethods } from '../../runtime/rpc/core.ts'
import { CLIPBOARD_METHODS } from '../../runtime/rpc/methods/clipboard.ts'
import { fixtureConfig, fixtureContext, fixtureRuntime } from './fixture-support.mts'

// Source-only: the proposed public/registry wiring must be accepted/applied before execution.
if (process.env.ORCA_PUBLIC_CLIPBOARD_WIRING_APPROVED !== 'root-wiring-reviewed') {
  throw new Error('Root wiring review required')
}

await test('서버 첨부 설정의 capture·미설정·disposed·unary 경계를 유지합니다', async () => {
  let connects = 0
  const pool = { connect() { connects++; throw new Error('Unexpected PG I/O') },
    query() { throw new Error('Unexpected PG I/O') } } as unknown as Pool
  const settings = { aliasRoot: '/synthetic/public-clipboard-wiring/value' }
  const input = { ...fixtureConfig(pool), attachments: settings }
  const captured = captureDurableCatalogReadConfig(input)
  settings.aliasRoot = 'changed-relative-path'
  assert.deepEqual(captured.attachments, { aliasRoot: '/synthetic/public-clipboard-wiring/value' })
  assert.ok(Object.isFrozen(captured.attachments))
  assert.equal(captured.pool, pool); assert.equal(Object.isFrozen(pool), false)
  assert.equal(Object.hasOwn(captureDurableCatalogReadConfig(fixtureConfig(pool)), 'attachments'), false)
  const data = (value: unknown) => ({ value, enumerable: true, configurable: true, writable: true })
  assert.equal(captureCatalogClipboardConfig(undefined), undefined)
  let getterCalls = 0
  const getter = { get: () => { getterCalls++; return '/synthetic/forbidden' } }
  const accessorRoot = Object.defineProperty({}, 'aliasRoot', getter)
  for (const invalid of [null, [], Object.create(null), { aliasRoot: 'relative' }, { aliasRoot: '' },
    { aliasRoot: '/synthetic/\0bad' }, { aliasRoot: '/synthetic/\nbad' },
    { aliasRoot: '/synthetic/\rbad' }, { aliasRoot: 1 }, { aliasRoot: '/synthetic/root', extra: true },
    { aliasRoot: '/synthetic/root', [Symbol('extra')]: true }, accessorRoot]) {
    assert.throws(() => captureCatalogClipboardConfig(data(invalid)), { code: 'CATALOG_CLIPBOARD_CONFIGURATION' })
  }
  assert.throws(() => captureCatalogClipboardConfig(getter), { code: 'CATALOG_CLIPBOARD_CONFIGURATION' })
  const accessorConfig = Object.defineProperty(fixtureConfig(pool), 'attachments', getter)
  assert.throws(() => captureDurableCatalogReadConfig(accessorConfig), { code: 'CATALOG_CLIPBOARD_CONFIGURATION' })
  assert.equal(getterCalls, 0)

  const privateJson = { datasetName: 'orca-1012-dev-v1', hostId: 'local', repositoryIds: ['synthetic:wiring-repo'],
    projectGroupIds: [], workspacePublicIds: [], pg: { host: 'synthetic-host', port: 5432, database: 'synthetic-db', user: 'synthetic-owner', max: 1 },
    attachments: { aliasRoot: '/synthetic/public-clipboard-wiring/startup' } }
  const startup = captureOrcadDurableCatalogConfig(JSON.parse(JSON.stringify(privateJson)), '/synthetic/private/pgpass')
  privateJson.attachments.aliasRoot = 'changed'
  assert.deepEqual(startup.attachments, { aliasRoot: '/synthetic/public-clipboard-wiring/startup' })
  assert.ok(Object.isFrozen(startup.attachments)); assert.ok(Object.isFrozen(startup))
  assert.throws(() => captureOrcadDurableCatalogConfig({ ...privateJson, attachments: accessorRoot }, '/synthetic/private/pgpass'),
    { code: 'CATALOG_CLIPBOARD_CONFIGURATION' })
  const malformed = Object.defineProperty({ ...startup }, 'attachments', getter)
  await assert.rejects(prepareOrcadDurableCatalog(malformed, () => { throw new Error('Unexpected Pool creation') }),
    { code: 'CATALOG_CLIPBOARD_CONFIGURATION' })
  assert.equal(getterCalls, 0)
  assert.equal(await prepareOrcadDurableCatalog(null), null)

  const owner = fixtureRuntime(), context = fixtureContext(owner.runtime)
  const original = eraseRpcMethods(CLIPBOARD_METHODS)
  const missing = new DurableCatalogReadAdapter(fixtureConfig(pool))
  assert.throws(() => missing.bind([{ ...original[0], stream: true as const, handler: async () => {} }]), { code: 'CATALOG_REGISTRY_KIND' })
  const bound = missing.bind(original)
  assert.equal(bound.length, 5)
  for (let i = 0; i < original.length; i++) {
    assert.equal(bound[i].name, original[i].name); assert.equal(bound[i].params, original[i].params)
    assert.notEqual(bound[i].handler, original[i].handler)
  }
  await assert.rejects(missing.clipboard('clipboard.startImageUpload', { expectedBase64Length: 0 }, context),
    { code: 'CATALOG_CLIPBOARD_NOT_CONFIGURED' })
  missing.dispose()
  await assert.rejects(missing.clipboard('clipboard.startImageUpload', { expectedBase64Length: 0 }, context),
    { code: 'CATALOG_ADAPTER_DISPOSED' })
  const configuredInput = { ...fixtureConfig(pool), attachments: { aliasRoot: '/synthetic/public-clipboard-wiring/captured' } }
  const configured = new DurableCatalogReadAdapter(configuredInput)
  configuredInput.attachments.aliasRoot = 'mutated-after-constructor'
  await assert.rejects(configured.clipboard('clipboard.startImageUpload', { expectedBase64Length: 0, connectionId: 'synthetic-ssh' }, context),
    { code: 'CLIPBOARD_SSH_NOT_CONNECTED' })
  configured.dispose()
  // PG opt-out keeps the original declaration objects/handlers. No legacy invocation is repeated.
  assert.deepEqual(eraseRpcMethods(CLIPBOARD_METHODS), original)
  assert.equal(connects, 0); assert.deepEqual(owner.unexpected, [])
})
