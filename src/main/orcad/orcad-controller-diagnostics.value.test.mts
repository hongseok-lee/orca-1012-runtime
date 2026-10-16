import assert from 'node:assert/strict'
import { test } from 'node:test'
import { counter } from '../../shared/durable-runtime/identity.ts'
import type { OrcadControllerSnapshot } from './orcad-controller.ts'
import { installOrcadControllerDiagnostics, type ControllerDiagnosticIo } from './orcad-controller-diagnostics.ts'

if (process.env.ORCA_CONTROLLER_DIAGNOSTIC_APPROVED !== 'root-ready') {
  throw new Error('Root diagnostic source review and first execution assignment required')
}

type Handler = Parameters<ControllerDiagnosticIo['signals']['on']>[1]
class Signals {
  readonly pid = 12345
  readonly handlers = new Set<Handler>()
  on(signal: 'SIGUSR2', handler: Handler): void {
    assert.equal(signal, 'SIGUSR2'); this.handlers.add(handler)
  }
  removeListener(signal: 'SIGUSR2', handler: Handler): void {
    assert.equal(signal, 'SIGUSR2'); this.handlers.delete(handler)
  }
  request() { return [...this.handlers].map(handler => handler()) }
}
const utc = '2026-10-16T00:00:00.000Z'
function snapshot(): OrcadControllerSnapshot {
  return { worker: { phase: 'ACTIVE', confirmedLease: { scope: 'orca-serve:fixture', owner: 'fixture-owner',
    term: counter('controller-term', '7'), revision: counter('row:controller', '11'), expiresAt: utc },
    lastAcquire: null, lastRenew: null, lastRelease: null,
    lastPass: { status: 'FINISHED', reason: 'PASS_COMPLETE', items: [{ kind: 'INVENTORY', identity: 'fixture-original-scope', disposition: 'OBSERVED' }] },
    lastFailure: null, stoppedBy: null,
    inFlight: { acquire: false, renew: false, pass: false, callbacks: 0, cleanup: false } },
    latestObservation: null, lastFailure: null }
}
function fixture(current = snapshot()) {
  const signals = new Signals(), output = { lines: [] as string[], write(line: string) { this.lines.push(line) } }
  const owner = { reads: 0, current, stops: 0,
    controllerSnapshot() { this.reads++; return this.current }, stop() { this.stops++ } }
  const io: ControllerDiagnosticIo = { signals, output, now: () => new Date(utc) }
  return { signals, output, owner, io }
}

await test('one diagnostic request reads the same owner once, excludes raw fields, and owns only its listener', async t => {
  await t.test('no startup controller adds no handler or output', () => {
    const f = fixture(), foreign: Handler = () => null
    f.signals.on('SIGUSR2', foreign)
    const stopNull = installOrcadControllerDiagnostics(null, f.io)
    const stopAbsent = installOrcadControllerDiagnostics({}, f.io)
    stopNull(); stopAbsent(); f.signals.request()
    assert.deepEqual([...f.signals.handlers], [foreign]); assert.equal(f.owner.reads, 0)
    assert.deepEqual(f.output.lines, [])
  })
  await t.test('captures the exact owner method and receiver but reads its current state per request', () => {
    const f = fixture(), stop = installOrcadControllerDiagnostics(f.owner, f.io)
    f.owner.controllerSnapshot = () => { throw new Error('method replacement must not be read') }
    f.signals.request(); assert.equal(f.owner.reads, 1); assert.equal(f.output.lines.length, 1)
    const first = JSON.parse(f.output.lines[0])
    assert.equal(first.type, 'orca_controller_diagnostic'); assert.equal(first.observedAt, utc); assert.equal(first.pid, 12345)
    assert.equal(first.worker.phase, 'ACTIVE'); assert.equal(first.worker.confirmedLease.term, '7')
    assert.deepEqual(first.worker.lastPass.items, [{ kind: 'INVENTORY', disposition: 'OBSERVED' }])
    assert.equal(first.latestObservation, null) // Empty LIST need not emit an observation.
    f.owner.current = { ...f.owner.current, worker: { ...f.owner.current.worker!, phase: 'STANDBY', confirmedLease: null,
      lastPass: { status: 'STOPPED', reason: 'CONTROLLER_LEASE_EXPIRED', items: [{ kind: 'INVENTORY', identity: 'not-output', disposition: 'UNVERIFIABLE' }] },
      lastFailure: { stage: 'PASS', code: 'CONTROLLER_LEASE_EXPIRED' }, stoppedBy: { stage: 'STOP', code: 'REQUESTED' } } }
    f.signals.request(); const next = JSON.parse(f.output.lines[1])
    assert.equal(f.owner.reads, 2); assert.equal(next.worker.phase, 'STANDBY'); assert.equal(next.worker.lastPass.status, 'STOPPED')
    assert.equal(next.worker.lastPass.items[0].disposition, 'UNVERIFIABLE'); assert.equal(next.worker.lastFailure.code, 'CONTROLLER_LEASE_EXPIRED')
    assert.equal(next.worker.stoppedBy.code, 'REQUESTED'); assert.equal(f.owner.stops, 0)
    for (const phase of ['STARTING', 'STOPPED'] as const) {
      f.owner.current = { ...f.owner.current, worker: { ...f.owner.current.worker!, phase } }
      f.signals.request(); assert.equal(JSON.parse(f.output.lines.at(-1)!).worker.phase, phase)
    }
    assert.ok(f.output.lines.every(line => line.endsWith('\n') && line.split('\n').length === 2)); stop()
  })
  await t.test('explicit projection never serializes added secrets, resource, item identity or toJSON hooks', () => {
    const f = fixture(), original = f.owner.current, secret = 'fixture-secret-never-output'
    assert.ok(original.worker)
    assert.ok(original.worker.confirmedLease)
    assert.ok(original.worker.lastPass)
    const trap = { token: secret, config: secret, environment: secret, stack: secret,
      toJSON() { throw new Error('raw object serialization is forbidden') } }
    const worker = Object.assign({}, original.worker, trap, {
      confirmedLease: Object.assign({}, original.worker.confirmedLease, trap),
      lastPass: Object.assign({}, original.worker.lastPass, trap, { items: [Object.assign({ kind: 'INVENTORY' as const, disposition: 'OBSERVED', identity: secret }, trap)] }),
      inFlight: Object.assign({}, original.worker.inFlight, trap) })
    f.owner.current = Object.assign({}, original, trap, { worker,
      latestObservation: Object.assign({ source: 'WATCH' as const, type: 'BOOKMARK' as const, persistence: 'CURSOR_ONLY' as const,
        observedAt: utc, resourceVersion: secret, counts: { total: 1, list: 0, watch: 1 }, resource: null }, trap,
      { resource: { namespace: secret, name: secret, uid: secret, unitId: secret, operationId: secret, executionEpoch: secret, specHash: secret } }) })
    const stop = installOrcadControllerDiagnostics(f.owner, f.io); f.signals.request()
    const line = f.output.lines[0], result = JSON.parse(line)
    assert.equal(f.owner.reads, 1); assert.equal(result.failure, undefined); assert.ok(!line.includes(secret))
    assert.deepEqual(Object.keys(result.latestObservation).sort(), ['counts', 'observedAt', 'persistence', 'source', 'type'])
    assert.deepEqual(result.latestObservation.counts, { total: 1, list: 0, watch: 1 })
    assert.equal(result.worker.lastPass.items[0].identity, undefined); assert.equal(f.owner.stops, 0); stop()
  })
  await t.test('cleanup removes only its listener and invalidates an already retained callback', () => {
    const f = fixture(), foreign: Handler = () => null
    f.signals.on('SIGUSR2', foreign); const stop = installOrcadControllerDiagnostics(f.owner, f.io)
    const queued = [...f.signals.handlers].find(handler => handler !== foreign)!
    stop(); stop(); queued(); f.signals.request()
    assert.deepEqual([...f.signals.handlers], [foreign]); assert.equal(f.owner.reads, 0)
    assert.deepEqual(f.output.lines, []); assert.equal(f.owner.stops, 0)
  })
  await t.test('snapshot failure emits one fixed code and leaves the owner running', () => {
    const f = fixture(); f.owner.controllerSnapshot = () => { f.owner.reads++; throw new Error('fixture-private-error-body') }
    const stop = installOrcadControllerDiagnostics(f.owner, f.io)
    assert.doesNotThrow(() => f.signals.request()); assert.equal(f.owner.reads, 1); assert.equal(f.output.lines.length, 1)
    assert.deepEqual(JSON.parse(f.output.lines[0]), { type: 'orca_controller_diagnostic', observedAt: utc, pid: 12345,
      failure: { code: 'CONTROLLER_DIAGNOSTIC_SNAPSHOT_FAILED' } })
    assert.ok(!f.output.lines[0].includes('fixture-private-error-body')); assert.equal(f.owner.stops, 0); stop()
  })
  await t.test('output failure never retries or throws into signal delivery; cleanup during read emits nothing', () => {
    const f = fixture(); let writes = 0
    const stop = installOrcadControllerDiagnostics(f.owner, { ...f.io, output: { write() { writes++; throw new Error('fixture-private-output-error') } } })
    assert.deepEqual(f.signals.request(), ['CONTROLLER_DIAGNOSTIC_OUTPUT_FAILED'])
    assert.equal(writes, 1); assert.equal(f.owner.reads, 1); assert.equal(f.owner.stops, 0); stop()
    const g = fixture(); let release = () => {}
    g.owner.controllerSnapshot = () => { g.owner.reads++; release(); return g.owner.current }
    release = installOrcadControllerDiagnostics(g.owner, g.io); g.signals.request()
    assert.equal(g.owner.reads, 1); assert.deepEqual(g.output.lines, []); assert.equal(g.owner.stops, 0)
  })
})
