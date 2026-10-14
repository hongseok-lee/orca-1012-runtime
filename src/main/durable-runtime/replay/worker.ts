import type { Pool } from 'pg'
import { DurableDatabaseError } from '../db/connection.ts'
import { recordOutboxFailure } from '../journal/publisher.ts'
import type { OutboxClaim } from '../journal/publisher.ts'
import { claimOpsReplayOutbox, OpsReplayClaimFailure, opsReplayErrorCode } from './claim.ts'
import type { OpsReplayClaimIdentity } from './claim.ts'
import { publishClaimToReplay } from './publication.ts'
import { stream } from './validation.ts'

export type OpsReplayWorkerConfig = Readonly<{
  owner: string; streamId: string; batchSize: number; claimLeaseMs: number; pollIntervalMs: number
}>
export type OpsReplayPublicationFailure = OpsReplayClaimIdentity & Readonly<{
  code: string; failureRecorded: boolean; failureRecordCode: string | null
}>
export type OpsReplayPassResult = Readonly<{
  status: 'COMPLETED' | 'PUBLICATION_FAILED' | 'CLAIM_FAILED' | 'BUSY' | 'STOPPED'
  claimed: readonly OpsReplayClaimIdentity[]
  published: readonly OpsReplayClaimIdentity[]
  replayed: readonly OpsReplayClaimIdentity[]
  unsupported: readonly OpsReplayClaimIdentity[]
  deferred: readonly OpsReplayClaimIdentity[]
  failures: readonly OpsReplayPublicationFailure[]
  claimFailure: Readonly<{ code: string; owner: string; token: string | null;
    observedSourceEventIds: readonly string[] }> | null
}>
export type OpsReplayPublicationWorker = Readonly<{
  runPass(): Promise<OpsReplayPassResult>
  start(): boolean
  stop(): Promise<OpsReplayPassResult | null>
  readonly lastResult: OpsReplayPassResult | null
  readonly lastFailure: OpsReplayPassResult | null
}>
// Process-local exclusion only; canonical events and leases remain PG-owned.
const activeOwners = new WeakMap<Pool, Set<string>>()
function snapshot(input: OpsReplayWorkerConfig): OpsReplayWorkerConfig {
  const fixed = Object.freeze({ owner: input.owner, streamId: input.streamId, batchSize: input.batchSize,
    claimLeaseMs: input.claimLeaseMs, pollIntervalMs: input.pollIntervalMs })
  if (typeof fixed.owner !== 'string' || !fixed.owner ||
    !Number.isSafeInteger(fixed.batchSize) || fixed.batchSize < 1 || fixed.batchSize > 100 ||
    !Number.isSafeInteger(fixed.claimLeaseMs) || fixed.claimLeaseMs < 1 ||
    !Number.isSafeInteger(fixed.pollIntervalMs) || fixed.pollIntervalMs < 1 || fixed.pollIntervalMs > 2147483647) {
    throw new DurableDatabaseError('REPLAY_WORKER_CONFIG')
  }
  stream(fixed.streamId)
  return fixed
}
function identity(claim: OutboxClaim): OpsReplayClaimIdentity {
  return Object.freeze({ sourceEventId: claim.id, owner: claim.owner, token: claim.token })
}
function result(status: OpsReplayPassResult['status']): {
  status: OpsReplayPassResult['status']; claimed: OpsReplayClaimIdentity[]; published: OpsReplayClaimIdentity[];
  replayed: OpsReplayClaimIdentity[]; unsupported: OpsReplayClaimIdentity[]; deferred: OpsReplayClaimIdentity[];
  failures: OpsReplayPublicationFailure[]; claimFailure: OpsReplayPassResult['claimFailure']
} { return { status, claimed: [], published: [], replayed: [], unsupported: [], deferred: [], failures: [], claimFailure: null } }
function finish(value: ReturnType<typeof result>): OpsReplayPassResult {
  return Object.freeze({ ...value, claimed: Object.freeze(value.claimed), published: Object.freeze(value.published),
    replayed: Object.freeze(value.replayed), unsupported: Object.freeze(value.unsupported),
    deferred: Object.freeze(value.deferred), failures: Object.freeze(value.failures) })
}
/** Borrows this exact Pool. No startup wiring, Pool.end, provider IO or physical authority. */
export function createOpsReplayPublicationWorker(pool: Pool, input: OpsReplayWorkerConfig): OpsReplayPublicationWorker {
  const config = snapshot(input)
  let running = false, stopped = false, ownsGate = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<OpsReplayPassResult> | null = null
  let lastResult: OpsReplayPassResult | null = null, lastFailure: OpsReplayPassResult | null = null
  function acquireGate(): boolean {
    const owners = activeOwners.get(pool) ?? new Set<string>()
    if (owners.has(config.owner)) { return false }
    owners.add(config.owner); activeOwners.set(pool, owners); ownsGate = true
    return true
  }
  function releaseGate(): void {
    if (!ownsGate) { return }
    const owners = activeOwners.get(pool)
    owners?.delete(config.owner)
    if (owners?.size === 0) { activeOwners.delete(pool) }
    ownsGate = false
  }
  async function noteFailure(claim: OutboxClaim, code: string): Promise<OpsReplayPublicationFailure> {
    let recorded = false, recordCode: string | null = null
    if (!stopped) {
      try { recorded = await recordOutboxFailure(pool, claim, code) }
      catch (error) { recordCode = opsReplayErrorCode(error) }
    }
    return Object.freeze({ ...identity(claim), code, failureRecorded: recorded, failureRecordCode: recordCode })
  }
  async function execute(): Promise<OpsReplayPassResult> {
    const output = result('COMPLETED')
    let claims: OutboxClaim[]
    try {
      claims = await claimOpsReplayOutbox(pool, { owner: config.owner, limit: config.batchSize, leaseMs: config.claimLeaseMs })
    } catch (error) {
      output.status = 'CLAIM_FAILED'
      output.claimFailure = Object.freeze({ code: opsReplayErrorCode(error), owner: config.owner,
        token: error instanceof OpsReplayClaimFailure ? error.token : null,
        observedSourceEventIds: error instanceof OpsReplayClaimFailure ? error.observedSourceEventIds : Object.freeze([]) })
      return finish(output)
    }
    output.claimed.push(...claims.map(identity))
    for (const claim of claims) {
      if (stopped) { output.status = 'STOPPED'; output.deferred.push(identity(claim)); continue }
      try {
        const published = await publishClaimToReplay(pool, { claim, streamId: config.streamId })
        if (published.status === 'PUBLISHED') { output.published.push(identity(claim)) }
        else if (published.status === 'REPLAYED') { output.replayed.push(identity(claim)) }
        else if (published.status === 'UNSUPPORTED_SOURCE') {
          output.unsupported.push(identity(claim))
          output.failures.push(await noteFailure(claim, 'REPLAY_UNSUPPORTED_SOURCE'))
        } else { output.failures.push(await noteFailure(claim, 'REPLAY_NOT_PUBLISHED_HERE')) }
      } catch (error) { output.failures.push(await noteFailure(claim, opsReplayErrorCode(error))) }
    }
    if (output.failures.length > 0 && output.status !== 'STOPPED') { output.status = 'PUBLICATION_FAILED' }
    return finish(output)
  }
  function begin(): Promise<OpsReplayPassResult> {
    const task = execute().then(value => {
      lastResult = value
      if (value.claimFailure || value.failures.length > 0) { lastFailure = value }
      return value
    })
    inFlight = task
    // Cleanup cannot discard the original task's publication/commit outcome.
    void task.finally(() => {
      if (inFlight === task) { inFlight = null }
      if (!running) { releaseGate() }
    }).catch(() => undefined)
    return task
  }
  async function tick(): Promise<void> {
    timer = null
    if (!running || stopped) { return }
    try { await begin() }
    finally {
      if (running && !stopped) { timer = setTimeout(() => { void tick() }, config.pollIntervalMs) }
    }
  }
  return Object.freeze({
    runPass(): Promise<OpsReplayPassResult> {
      if (stopped) { return Promise.resolve(finish(result('STOPPED'))) }
      if (running || inFlight || !acquireGate()) { return Promise.resolve(finish(result('BUSY'))) }
      return begin()
    },
    start(): boolean {
      if (stopped || running || inFlight || !acquireGate()) { return false }
      running = true
      timer = setTimeout(() => { void tick() }, 0)
      return true
    },
    async stop(): Promise<OpsReplayPassResult | null> {
      stopped = true; running = false
      if (timer !== null) { clearTimeout(timer); timer = null }
      const task = inFlight
      try { if (task) { await task } }
      finally { releaseGate() }
      return lastResult
    },
    get lastResult() { return lastResult },
    get lastFailure() { return lastFailure }
  })
}
