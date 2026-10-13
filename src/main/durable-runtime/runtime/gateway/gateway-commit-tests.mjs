// Transport reply-loss probes around real isolated PostgreSQL COMMIT.
// These consume P1-03 uncertainty handling; they do not reimplement it.
import assert from 'node:assert/strict'
import { resolveReceipt } from '../../db/atomic.ts'
import { lookupCommand } from './store.ts'
import { runGatewayCommandMutation } from './mutation.ts'
import {
  pool,
  fixture,
  request,
  original,
  accept,
  mutationRequest,
  inGateway,
  counts,
  test
} from './gateway-test-fixtures.mjs'

export async function registerCommitBoundaryCases() {
  for (const commitSent of [false, true]) {
    await test(
      commitSent
        ? 'claim-commit-reply-lost-reuses-original-receipt'
        : 'claim-commit-not-sent-remains-unconfirmed',
      async () => {
        const f = await fixture(true),
          r = request(f)
        await accept(f, r)
        const req = mutationRequest(f, {
          kind: 'CLAIM',
          original: original(r),
          executorId: 'fixture-lost-reply'
        })
        let intercepted = false
        const lossy = {
          connect: async () => {
            const c = await pool.connect()
            return new Proxy(c, {
              get(target, key) {
                if (key === 'query') {
                  return async (sql, values) => {
                    if (String(sql) === 'COMMIT' && !intercepted) {
                      intercepted = true
                      if (commitSent) {
                        await target.query(sql, values)
                      }
                      const e = new Error('FIXTURE_COMMIT_REPLY_LOSS')
                      e.code = 'ECONNRESET'
                      throw e
                    }
                    return target.query(sql, values)
                  }
                }
                const v = Reflect.get(target, key)
                return typeof v === 'function' ? v.bind(target) : v
              }
            })
          }
        }
        const result = await runGatewayCommandMutation(lossy, req)
        assert.equal(result.mutation.status, 'UNCERTAIN')
        const receipt = await resolveReceipt(pool, result.identity)
        assert.equal(receipt.status, commitSent ? 'FOUND' : 'NOT_FOUND')
        const row = await inGateway(f, (a) => lookupCommand(a, original(r)))
        assert.equal(row.state, commitSent ? 'EXECUTING' : 'ACCEPTED')
        const n = await counts(f)
        assert.equal(n.audit, commitSent ? 1 : 0)
        assert.equal(n.outbox, commitSent ? 1 : 0)
        assert.equal(n.receipts, commitSent ? 1 : 0)
        if (commitSent) {
          const replay = await runGatewayCommandMutation(pool, req)
          assert.equal(replay.mutation.status, 'REPLAYED')
          assert.equal((await counts(f)).history, 2)
        }
        return {
          commitSent,
          receiptResolution: receipt.status,
          ledgerState: row.state,
          automaticExternalExecutions: 0,
          claimNotAutomaticallyRetried: true
        }
      }
    )
  }
}
