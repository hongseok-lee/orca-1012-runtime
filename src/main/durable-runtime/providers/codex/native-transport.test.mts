import assert from 'node:assert/strict'
import test from 'node:test'
import { codexNativeTransport } from './native-transport.ts'

test('constructing the native wrapper does not open a provider; arbitrary baselines cannot terminate', async () => {
  const transport = codexNativeTransport()
  assert.equal(typeof transport.open, 'function')
  assert.equal(await transport.terminate!(123, { synthetic: 'unowned-baseline' }), false)
  assert.equal(await transport.terminate!(123, null), false)
})
