import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { createCatalogClipboardRpc } from './clipboard.ts'
import { captureDurableCatalogReadConfig } from './config.ts'
import { fixtureConfig, fixtureContext, fixtureRuntime, deferred } from './fixture-support.mts'

if (process.env.ORCA_PUBLIC_CLIPBOARD_APPROVED !== 'root-source-reviewed') {
  throw new Error('Root source review required')
}

await test('공개 schema와 인증 거절은 I/O 전에 처리하고 첫 await 전의 요청·context·서버 값을 유지합니다', async () => {
  const owner = fixtureRuntime(), context = fixtureContext(owner.runtime)
  let connects = 0, ends = 0, releases = 0, commitFailure = false
  const checkout = deferred<void>()
  let opened = false, upload: Record<string, unknown> | null = null
  let aliasPath: string | null = null
  let blob: { content_bytes: Buffer; byte_length: number; media_type: string } | null = null
  const statements: string[] = []
  const client = {
    async query(sql: string, values: unknown[] = []) {
      statements.push(sql)
      if (sql.includes('dataset_metadata')) { return { rows: [{ dataset_name: 'orca-1012-dev-v1' }], rowCount: 1 } }
      if (sql.includes('INSERT INTO durable_runtime.attachment_uploads')) {
        upload = { id: values[0], principal_id: values[1], target_connection_id: values[2],
          expected_base64_length: values[3], received_base64_length: 0, state: 'OPEN', revision: '0' }
      }
      if (sql.includes('SELECT * FROM durable_runtime.attachment_uploads')) { return { rows: [upload], rowCount: 1 } }
      if (sql.includes('SELECT chunk_offset,content_base64')) { return { rows: [], rowCount: 0 } }
      if (sql.includes('INSERT INTO durable_runtime.attachment_blobs')) {
        blob = { content_bytes: values[1] as Buffer, byte_length: values[2] as number, media_type: values[3] as string }
      }
      if (sql.includes('SELECT content_bytes,byte_length,media_type')) { return { rows: [blob], rowCount: 1 } }
      if (sql.includes('INSERT INTO durable_runtime.attachment_aliases')) { aliasPath = values[0] as string }
      if (sql === 'COMMIT' && commitFailure) { throw new Error('synthetic sensitive database diagnostic') }
      return { rows: [], rowCount: 0 }
    },
    release() { releases++ }
  }
  const receiver = {
    async connect() {
      assert.equal(this, receiver)
      connects++; opened = true
      await checkout.promise
      return client
    },
    async end() { ends++ }
  }
  const pool = receiver as unknown as Pool
  const config = captureDurableCatalogReadConfig(fixtureConfig(pool))
  const mutable = { ...config }
  const options = { aliasRoot: '/synthetic/public-clipboard/aliases' }
  const handler = createCatalogClipboardRpc(mutable, options)

  for (const [method, params] of [
    ['clipboard.saveImageAsTempFile', { contentBase64: '!' }],
    ['clipboard.startImageUpload', { expectedBase64Length: -1 }],
    ['clipboard.appendImageUploadChunk', { uploadId: '', offset: 0, contentBase64: 'AA==' }],
    ['clipboard.commitImageUpload', { uploadId: '' }],
    ['clipboard.abortImageUpload', { uploadId: '' }]
  ] as const) {
    await assert.rejects(handler(method, params, context), { code: 'CLIPBOARD_INVALID_PARAMS' })
  }
  await assert.rejects(handler('clipboard.startImageUpload', { expectedBase64Length: 4 },
    { ...context, authenticatedCallerFingerprint: undefined, clientId: 'synthetic-raw-credential' }),
  { code: 'CATALOG_AUTHENTICATED_CALLER_REQUIRED' })
  await assert.rejects(handler('clipboard.startImageUpload', { expectedBase64Length: 4 },
    { ...context, authenticatedCallerFingerprint: 'invalid' }), { code: 'CATALOG_AUTHENTICATED_CALLER_REQUIRED' })
  for (const method of ['clipboard.startImageUpload', 'clipboard.saveImageAsTempFile'] as const) {
    const params = method === 'clipboard.startImageUpload' ? { expectedBase64Length: 4, connectionId: 'synthetic-ssh' }
      : { contentBase64: 'AA==', connectionId: 'synthetic-ssh' }
    await assert.rejects(handler(method, params, context), { code: 'CLIPBOARD_SSH_NOT_CONNECTED' })
  }
  assert.equal(connects, 0); assert.equal(statements.length, 0)
  assert.throws(() => createCatalogClipboardRpc(config, { aliasRoot: 'relative' }))

  const request = { expectedBase64Length: 4, connectionId: null }
  const started = handler('clipboard.startImageUpload', request, context)
  assert.equal(opened, true)
  request.expectedBase64Length = 40
  context.authenticatedCallerFingerprint = 'b'.repeat(64)
  context.clientKind = 'runtime'; context.clientCapabilities = []
  options.aliasRoot = '/changed'
  mutable.datasetName = 'changed'
  mutable.assertCurrentHost = () => { throw new Error('replaced guard') }
  receiver.connect = async () => { throw new Error('replaced connect') }
  checkout.resolve()
  const result = await started as { uploadId: string }
  assert.match(result.uploadId, /^[a-f0-9-]{36}$/)
  const saved = upload as Record<string, unknown> | null
  assert.equal(saved?.id, result.uploadId)
  assert.equal(saved?.principal_id, `pairing-sha256:${'a'.repeat(64)}`)
  assert.equal(saved?.expected_base64_length, 4)
  assert.equal(statements.at(-1), 'COMMIT')
  assert.equal(connects, 1); assert.equal(releases, 1); assert.equal(ends, 0)

  commitFailure = true
  await assert.rejects(handler('clipboard.startImageUpload', { expectedBase64Length: 4 }, context), error => {
    assert.equal((error as { code: string }).code, 'DB_FAILURE')
    assert.equal(String(error).includes('sensitive'), false)
    return true
  })
  assert.equal(statements.at(-1), 'ROLLBACK')
  commitFailure = false
  const empty = await handler('clipboard.startImageUpload', { expectedBase64Length: 0 }, context) as { uploadId: string }
  assert.deepEqual(await handler('clipboard.appendImageUploadChunk', { uploadId: empty.uploadId, offset: 0, contentBase64: '' }, context),
    { receivedBase64Length: 0 })
  const alias = await handler('clipboard.commitImageUpload', empty, context)
  assert.equal(alias, `/synthetic/public-clipboard/aliases/orca-paste-${empty.uploadId}.png`)
  assert.equal(aliasPath, alias)
  assert.deepEqual(await handler('clipboard.abortImageUpload', empty, context), { aborted: true })
  assert.equal(ends, 0); assert.deepEqual(owner.unexpected, [])
})
