import process from 'node:process'
import { writeSync } from 'node:fs'
import type { OrcadControllerSnapshot } from './orcad-controller.ts'

export type ControllerDiagnosticOwner = Readonly<{ controllerSnapshot?: () => OrcadControllerSnapshot }>
type DiagnosticCode = 'CONTROLLER_DIAGNOSTIC_SNAPSHOT_FAILED' | 'CONTROLLER_DIAGNOSTIC_OUTPUT_FAILED'
type SignalHandler = () => DiagnosticCode | null
export type ControllerDiagnosticIo = Readonly<{
  signals: Readonly<{
    readonly pid: number
    on(signal: 'SIGUSR2', handler: SignalHandler): unknown
    removeListener(signal: 'SIGUSR2', handler: SignalHandler): unknown
  }>
  output: Readonly<{ write(line: string): unknown }>
  now(): Date
}>

function code(value: string): string {
  if (typeof value !== 'string' || !/^[A-Z0-9_]{1,128}$/.test(value)) {
    throw new Error('CONTROLLER_DIAGNOSTIC_SNAPSHOT_FAILED')
  }
  return value
}
function state<T extends string>(value: T, allowed: readonly T[]): T {
  if (!allowed.includes(value)) { throw new Error('CONTROLLER_DIAGNOSTIC_SNAPSHOT_FAILED') }
  return value
}
function flag(value: boolean): boolean {
  if (typeof value !== 'boolean') { throw new Error('CONTROLLER_DIAGNOSTIC_SNAPSHOT_FAILED') }
  return value
}
function count(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) { throw new Error('CONTROLLER_DIAGNOSTIC_SNAPSHOT_FAILED') }
  return value
}

function optional(value: string | null): string | null {
  if (value !== null && (typeof value !== 'string' || !/^[A-Z0-9_:]{1,160}$/.test(value))) { throw new Error('CONTROLLER_DIAGNOSTIC_SNAPSHOT_FAILED') }
  return value
}

// Explicit projection only: never serialize the owner, a resource, or raw extra fields.
function project(snapshot: OrcadControllerSnapshot) {
  const worker = snapshot.worker, latest = snapshot.latestObservation, initial = snapshot.firstManagedInitial
  const lease = worker?.confirmedLease, pass = worker?.lastPass
  const failure = worker?.lastFailure, stopped = worker?.stoppedBy, flight = worker?.inFlight
  return {
    worker: worker === null ? null : {
      phase: state(worker.phase, ['NEW', 'STARTING', 'STANDBY', 'ACTIVE', 'STOPPING', 'STOPPED']),
      confirmedLease: lease == null ? null : { scope: lease.scope, owner: lease.owner, term: lease.term,
        revision: lease.revision, expiresAt: lease.expiresAt },
      lastPass: pass == null ? null : { status: state(pass.status, ['FINISHED', 'STOPPED']), reason: code(pass.reason),
        items: pass.items.map(item => ({ kind: state(item.kind, ['RECONCILE', 'QUEUE', 'INVENTORY']), disposition: code(item.disposition),
          identity: typeof item.identity === 'string' ? item.identity.slice(0, 8).replace(/[^0-9a-f-]/g, '') : null })) },
      lastFailure: failure == null ? null : { stage: state(failure.stage, ['ACQUIRE', 'RENEW', 'PASS', 'RELEASE', 'START']), code: code(failure.code) },
      stoppedBy: stopped == null ? null : { stage: state(stopped.stage, ['ACQUIRE', 'RENEW', 'PASS', 'RELEASE', 'START', 'STOP']), code: code(stopped.code) },
      inFlight: flight == null ? null : { acquire: flag(flight.acquire), renew: flag(flight.renew), pass: flag(flight.pass),
        callbacks: count(flight.callbacks), cleanup: flag(flight.cleanup) }
    },
    latestObservation: latest === null ? null : {
      source: state(latest.source, ['LIST', 'WATCH']), type: state(latest.type, ['ADDED', 'MODIFIED', 'DELETED', 'BOOKMARK']),
      persistence: state(latest.persistence, ['CURSOR_ONLY', 'RECORDED', 'REPLAYED']), observedAt: latest.observedAt,
      counts: { total: count(latest.counts.total), list: count(latest.counts.list), watch: count(latest.counts.watch) }
    },
    firstManagedInitial: initial == null ? null : { phase: initial.phase, status: initial.status,
      errorCode: optional(initial.errorCode), executionPhase: initial.executionPhase, executionErrorCode: optional(initial.executionErrorCode),
      coldPhase: optional(initial.coldPhase ?? null), coldFailure: optional(initial.coldFailure ?? null),
      coldInput: optional(initial.coldInput ?? null), adoption: optional(initial.adoption ?? null), output: optional(initial.output ?? null) },
    adoptedRuntimes: snapshot.adoptedRuntimes ? { adopted: count(snapshot.adoptedRuntimes.adopted), failed: count(snapshot.adoptedRuntimes.failed),
      firstError: optional(snapshot.adoptedRuntimes.firstError), lastInput: optional(snapshot.adoptedRuntimes.lastInput) } : null,
    owners: snapshot.owners ? snapshot.owners.map(owner => owner.replace(/[^0-9a-z:-]/g, '_').slice(0, 40)) : null,
    rewake: snapshot.rewake ? { started: count(snapshot.rewake.started), active: count(snapshot.rewake.active),
      lastError: optional(snapshot.rewake.lastError), status: snapshot.rewake.last?.status ?? null,
      errorCode: optional(snapshot.rewake.last?.errorCode ?? null), executionPhase: snapshot.rewake.last?.executionPhase ?? null,
      executionErrorCode: optional(snapshot.rewake.last?.executionErrorCode ?? null),
      preparationErrorCode: optional(snapshot.rewake.last?.preparationErrorCode ?? null),
      preparation: snapshot.rewake.last ? `${snapshot.rewake.last.preparationPhase ?? 'NONE'}:${snapshot.rewake.last.preparationOutcome ?? 'NONE'}:${snapshot.rewake.last.pinState ?? 'NONE'}:${snapshot.rewake.last.createRequested}` : null,
      assignment: snapshot.rewake.last?.assignment?.errorCode ?? snapshot.rewake.last?.assignment?.disposition ?? null,
      target: snapshot.rewake.last?.target?.errorCode ?? snapshot.rewake.last?.target?.disposition ?? null, coldPhase: optional(snapshot.rewake.last?.coldPhase ?? null),
      coldFailure: optional(snapshot.rewake.last?.coldFailure ?? null), coldInput: optional(snapshot.rewake.last?.coldInput ?? null) } : null,
    lastFailure: snapshot.lastFailure === null ? null : {
      stage: state(snapshot.lastFailure.stage, ['START', 'STOP', 'INVENTORY']), code: code(snapshot.lastFailure.code)
    }
  }
}

/** Owns one diagnostic listener, never a controller/Pool/transport. No owner means no listener. */
export function installOrcadControllerDiagnostics(owner: ControllerDiagnosticOwner | null,
  io: ControllerDiagnosticIo = { signals: process, output: { write(line) {
    // The existing private runtime stdout fd is synchronous: no unhandled stream error callback.
    const bytes = Buffer.from(line)
    if (writeSync(process.stdout.fd, bytes) !== bytes.length) { throw new Error('CONTROLLER_DIAGNOSTIC_OUTPUT_FAILED') }
  } }, now: () => new Date() }): () => void {
  const method = owner?.controllerSnapshot
  if (typeof method !== 'function') { return () => {} }
  const read = method.bind(owner), signals = io.signals, output = io.output
  const register = signals.on.bind(signals), remove = signals.removeListener.bind(signals)
  const write = output.write.bind(output), now = io.now.bind(io), pid = signals.pid
  let closed = false
  const handler: SignalHandler = () => {
    if (closed) { return null }
    let line: string, observedAt: string | null = null
    try {
      observedAt = now().toISOString()
      const snapshot = read()
      if (closed) { return null }
      line = `${JSON.stringify({ type: 'orca_controller_diagnostic', observedAt, pid, ...project(snapshot) })}\n`
    } catch {
      if (closed) { return null }
      line = `${JSON.stringify({ type: 'orca_controller_diagnostic', observedAt, pid,
        failure: { code: 'CONTROLLER_DIAGNOSTIC_SNAPSHOT_FAILED' } })}\n`
    }
    if (closed) { return null }
    try { write(line) }
    catch {
      // A write may have emitted bytes before throwing. Never retry or leak its cause.
      // EventEmitter ignores this fixed result; the diagnostic cannot stop the controller.
      return 'CONTROLLER_DIAGNOSTIC_OUTPUT_FAILED'
    }
    return null
  }
  register('SIGUSR2', handler)
  return () => {
    if (closed) { return }
    closed = true
    remove('SIGUSR2', handler)
  }
}
