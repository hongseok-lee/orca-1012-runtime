import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createManagedLeafPinHolder, heldManagedLeafDirectoryValid } from './managed-leaf-pin.ts'
import { managedLeafPinCommand } from './managed-leaf-pin-command.ts'
import { ManagedLeafCollectorError } from './managed-leaf-collector-types.ts'
import { deferred, fixture, finish, leafId } from './managed-leaf-collector-fixtures.mts'
import type { Socket } from './managed-leaf-collector-fixtures.mts'

test('managed directory holder owns its post-acquisition lifetime and confirms explicit release', async t => {
  function setup() {
    const reached = deferred<Socket>(), writes: Buffer[] = []
    // Reuse the original HTTPS and stream fixture; select the new lifetime by
    // exact argv instead of duplicating the collector/authentication behavior.
    const collector = fixture(undefined, (socket, output) => {
      if (collector.opened.at(-1)?.url.searchParams.get('stdin') !== 'true') { finish(socket, output); return }
      Reflect.set(socket, 'send', (bytes: Buffer) => { writes.push(Buffer.from(bytes)) })
      reached.resolve(socket)
      socket.frame(1, `${output}ORCA_MANAGED_LEAF_PIN_HELD 73 66317 400\n`)
    })
    const open = collector.dependencies.openWebSocket.bind(collector.dependencies)
    collector.dependencies.openWebSocket = (url, protocol, options) => {
      const socket = open(url, protocol, options)
      Reflect.set(socket, 'send', (bytes: Buffer) => { writes.push(Buffer.from(bytes)) })
      return socket
    }
    const cancellation = new AbortController()
    return { f: collector, reached, writes, cancellation,
      acquiring: createManagedLeafPinHolder(collector.configuration, collector.dependencies).acquire(leafId, cancellation.signal) }
  }
  await t.test('request cancellation after handoff cannot release the FD during settlement', async () => {
    const s = setup(), holder = await s.acquiring, socket = await s.reached.promise
    const settling = deferred<void>()
    const transaction = settling.promise.then(() => holder.release())
    s.cancellation.abort(); await Promise.resolve()
    assert.equal(heldManagedLeafDirectoryValid(holder), true)
    assert.equal(socket.terminated, false); assert.equal(s.writes.length, 0)
    assert.equal(holder.physicalPinIssued, false)
    assert.equal(s.f.opened[1].url.searchParams.getAll('command')[2], managedLeafPinCommand)
    settling.resolve(); await Promise.resolve()
    assert.equal(holder.held(), false)
    assert.deepEqual(s.writes, [Buffer.concat([Buffer.from([0]), Buffer.from('RELEASE_MANAGED_LEAF_PIN\n')])])
    socket.frame(1, 'ORCA_MANAGED_LEAF_PIN_RELEASED\n'); socket.frame(3, '{"status":"Success"}')
    socket.end()
    await transaction; await holder.release(); await s.f.assertCleanup()
  })
  await t.test('disconnect before release preserves terminal failure instead of waiting on a dead socket', async () => {
    const s = setup(), holder = await s.acquiring, socket = await s.reached.promise
    socket.end(1006)
    assert.equal(heldManagedLeafDirectoryValid(holder), false)
    await assert.rejects(holder.release(), e => e instanceof ManagedLeafCollectorError && e.code === 'EXEC_FAILED')
    assert.equal(s.writes.length, 0); await s.f.assertCleanup()
  })
  await t.test('a marker without remote Success never confirms release', async () => {
    const s = setup(), holder = await s.acquiring, socket = await s.reached.promise
    const releasing = holder.release(), rejected = assert.rejects(releasing, ManagedLeafCollectorError)
    socket.frame(1, 'ORCA_MANAGED_LEAF_PIN_RELEASED\n'); socket.end()
    await rejected; await assert.rejects(holder.release(), ManagedLeafCollectorError); await s.f.assertCleanup()
  })
  await t.test('release is bounded while the held lifetime itself has no TTL', async child => {
    const s = setup(), holder = await s.acquiring
    child.mock.timers.enable({ apis: ['setTimeout'] })
    const releasing = holder.release(), rejected = assert.rejects(releasing,
      e => e instanceof ManagedLeafCollectorError && e.code === 'TIMEOUT')
    child.mock.timers.tick(s.f.configuration.timeoutMs)
    await rejected; await s.f.assertCleanup()
  })
})
