import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool, PoolClient, QueryResult } from 'pg'
import { createDurablePool } from '../db/connection.ts'
import type { ControllerWorkerPolicy } from './worker.ts'

/** Fixture timing only, never a product default/quota/provider budget. */
export function workerPolicy(): ControllerWorkerPolicy {
  return { lease: { revision: 'p114-worker-fixture-v1', durationMs: 5000 }, renewIntervalMs: 100,
    standbyPollIntervalMs: 30, passPollIntervalMs: 100, maximumWork: 100, externalBudgetMs: 10000 }
}
export function ownedPool(): Pool {
  if (process.env.ORCA_CONTROLLER_WORKER_APPROVED !== 'root-ready' ||
      !/^orca_p114_worker_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? '')) {
    throw new Error('Root first execution assignment and separate schema-ready worker DB required')
  }
  return createDurablePool({ max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000 })
}
export function gate() {
  let signal!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { signal = resolve })
  const wait = new Promise<void>(resolve => { release = resolve })
  return { entered, signal, wait, release }
}
export async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let n = 0; n < 500; n++) {
    if (await check()) { return }
    await delay(20)
  }
  assert.fail('actual worker boundary was not observed before the fixture observation timeout')
}
/** Delays/rejects replies from real PG statements. No fabricated SQL result or lease/pass implementation. */
export function observedPool(pool: Pool,
  hook: (sql: string, values: readonly unknown[], client: PoolClient, execute: () => Promise<QueryResult>) => Promise<QueryResult>): Pool {
  return new Proxy(pool, { get(target, property) {
    if (property === 'connect') { return async () => {
      const client = await target.connect()
      return new Proxy(client, { get(original, key) {
        if (key === 'query') { return (sql: string, values: unknown[] = []) => hook(sql, values, client, () => client.query(sql, values)) }
        const member = Reflect.get(original, key)
        return typeof member === 'function' ? member.bind(original) : member
      } })
    } }
    const member = Reflect.get(target, property)
    return typeof member === 'function' ? member.bind(target) : member
  } })
}
