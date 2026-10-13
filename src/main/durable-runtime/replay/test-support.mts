import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool, PoolClient, QueryResult } from 'pg'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import { claimOutbox, type OutboxClaim } from '../journal/publisher.ts'
import { observeNotification } from '../notifications/index.ts'
import type { NotificationTarget, Observation, NotificationPrincipal, SourceAuthority } from '../notifications/types.ts'
import type { MutationOutcome, JsonValue } from '../db/atomic.ts'

// Fixture assertions supply trusted types solely to exercise real PG module
// boundaries. They are not authentication or actual provider recovery proofs.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Verification fixture only; authentication is explicitly unverified.
export const authority = { actorId: 'p125-fixture-source', verificationRef: 'fixture-source-observation' } as SourceAuthority
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Verification fixture only; no public authentication factory.
export const principal = 'p125-fixture-principal' as NotificationPrincipal
export function receipt(result: MutationOutcome): Record<string, JsonValue> {
  assert.notEqual(result.status, 'UNCERTAIN')
  if (result.status === 'UNCERTAIN') { throw new Error('uncertain fixture commit') }
  const value = result.receipt.response
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Object receipt shape checked immediately above.
  return value as Record<string, JsonValue>
}
export async function fixture(pool: Pool): Promise<NotificationTarget> {
  const unit = logicalId('runtime-unit', randomUUID())
  const agent = logicalId('agent', randomUUID())
  const session = logicalId('session', randomUUID())
  const workspace = randomUUID()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT')", [unit])
    await client.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'p125-fixture')", [agent])
    await client.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'p125','READY')", [workspace, randomUUID()])
    await client.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [session, agent, workspace])
    await client.query('INSERT INTO durable_runtime.runtime_members(session_id,runtime_unit_id) VALUES($1,$2)', [session, unit])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  return { runtimeUnitId: unit, sessionIds: [session], agentId: agent }
}
export function source(targetRef: NotificationTarget, extra: Partial<Observation> = {}): Observation {
  return { authority, sourceEventId: logicalId('event', randomUUID()), incidentKey: `fixture-incident:${randomUUID()}`,
    targetRef, reasonCode: 'FIXTURE_FAILED', occurredAt: new Date('2026-10-12T12:00:00.000Z'), retryCount: '0', ...extra }
}
const claims = new Map<string, OutboxClaim>()
export async function claimFor(pool: Pool, id: string): Promise<OutboxClaim> {
  const cached = claims.get(id)
  if (cached) { return cached }
  for (const value of await claimOutbox(pool, { owner: 'p125-fixture-publisher', limit: 100, leaseMs: 60000 })) { claims.set(value.id, value) }
  const result = claims.get(id)
  assert.ok(result, 'source must have a real committed OutboxClaim')
  return result
}
export async function notificationSource(pool: Pool, target: NotificationTarget, overrides: Partial<Observation> = {}): Promise<{ input: Observation; notificationId: string; claim: OutboxClaim }> {
  const input = source(target, overrides)
  const value = receipt(await observeNotification(pool, input))
  return { input, notificationId: String(value.notificationId), claim: await claimFor(pool, input.sourceEventId) }
}
export async function errorCode(action: () => Promise<unknown>, expected: string): Promise<void> {
  await assert.rejects(action, error => error instanceof DurableDatabaseError && error.code === expected)
}
export type QueryHook = (sql: string, client: PoolClient, execute: () => Promise<QueryResult>) => Promise<QueryResult>
// Uses an actual PG connection; hooks delay or reject selected statements or
// discard a reply after that real statement commits. No fake SQL results.
export function hookPool(pool: Pool, hook: QueryHook): Pool {
  const result = Object.create(pool)
  result.connect = async () => {
    const client = await pool.connect()
    return new Proxy(client, { get(target, property) {
      if (property === 'query') {
        return (sql: string, values: unknown[] = []) => hook(sql, client, () => client.query(sql, values))
      }
      const member = Reflect.get(target, property)
      return typeof member === 'function' ? member.bind(target) : member
    } })
  }
  return result
}
export function gate(): { entered: Promise<void>; signal: () => void; wait: Promise<void>; release: () => void } {
  let signal!: () => void; let release!: () => void
  const entered = new Promise<void>(r => { signal = r }); const wait = new Promise<void>(r => { release = r })
  return { entered, signal, wait, release }
}
export async function waitForBlocking(pool: Pool, waiter: number, blocker: number): Promise<{ waitEventType: string; blocked: boolean }> {
  for (let n = 0; n < 40; n++) {
    const found = await pool.query('SELECT wait_event_type, $2::integer=ANY(pg_blocking_pids(pid)) AS blocked FROM pg_stat_activity WHERE pid=$1 AND datname=current_database()', [waiter, blocker])
    if (found.rows[0]?.blocked) {
      assert.equal(found.rows[0].wait_event_type, 'Lock')
      return { waitEventType: found.rows[0].wait_event_type, blocked: true }
    }
    await delay(25)
  }
  assert.fail('actual publication lock overlap was not observed')
}
