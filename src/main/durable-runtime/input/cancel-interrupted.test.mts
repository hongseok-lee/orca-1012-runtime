import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createDurablePool } from '../db/connection.ts'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { requestInputCancel } from './cancel.ts'
import { fixture, response, field } from './verification-fixtures.mts'

// Synthetic persisted verified-observation fixtures, not actual provider proof.
// Production has no boolean/ACK/string-to-proof constructor.
test('INTERRUPTED retains fixed execution history; only exact persisted stop proof is ALREADY_SETTLED', async () => {
  assert.equal(process.cwd(), process.env.ORCA_CANCEL_EXECUTION_ROOT)
  assert.match(process.env.PGDATABASE ?? '', /^orca_p107_[a-z0-9_]+$/)
  const pool = createDurablePool({ database: process.env.PGDATABASE, max: 3 })
  try {
    for (const variant of ['confirmed', 'no-proof', 'wrong-delivery', 'wrong-epoch'] as const) {
      const f = await fixture(pool)
      const sessionId = f.request.authority.sessionId
      const messageId = logicalId('message', randomUUID())
      const attemptId = randomUUID()
      const deliveryId = randomUUID()
      const oldCancelId = randomUUID()
      await pool.query(
        `INSERT INTO durable_runtime.resource_profiles (runtime_unit_id,revision,container_resources,policy_revision) VALUES ($1,0,'{}',0)`,
        [f.unitId]
      )
      await pool.query(
        `INSERT INTO durable_runtime.attempts
        (id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,resource_profile_revision,effective_resources,status)
        VALUES ($1,$2,7,'COLD','synthetic-old-pod','synthetic-incarnation',0,'{}','STOPPED')`,
        [attemptId, f.unitId]
      )
      await pool.query(
        `INSERT INTO durable_runtime.messages
        (id,session_id,seq,revision,body_or_blob_ref,intake_status,cancel_requested_at,cancel_revision,merge_closed)
        VALUES ($1,$2,1,4,'{}','INTERRUPTED',clock_timestamp(),1,true)`,
        [messageId, sessionId]
      )
      await pool.query(
        `INSERT INTO durable_runtime.delivery_attempts
        (id,message_id,session_id,runtime_unit_id,attempt_id,execution_epoch,state,provider_ref,effect_possible_at,completed_at)
        VALUES ($1,$2,$3,$4,$5,7,'INTERRUPTED','synthetic-old-turn',clock_timestamp(),clock_timestamp())`,
        [deliveryId, messageId, sessionId, f.unitId, attemptId]
      )
      const evidenceAttempt = variant === 'wrong-epoch' ? randomUUID() : attemptId
      if (variant === 'wrong-epoch') {
        await pool.query(
          `INSERT INTO durable_runtime.attempts
          (id,runtime_unit_id,execution_epoch,mode,pod_uid,resource_profile_revision,effective_resources,status)
          VALUES ($1,$2,8,'COLD','synthetic-other-pod',0,'{}','STOPPED')`,
          [evidenceAttempt, f.unitId]
        )
      }
      await pool.query(
        `INSERT INTO durable_runtime.cancel_intents
        (operation_id,session_id,target_message_id,target_message_revision,target_runtime_unit_id,target_attempt_id,
         target_execution_epoch,target_provider_turn_ref,requested_by,requested_at,cancel_revision,interrupt_status,
         interrupt_evidence_ref,updated_at)
        VALUES ($1,$2,$3,3,$4,$5,$6,'synthetic-old-turn',$7,clock_timestamp(),1,$8,$9,clock_timestamp())`,
        [
          oldCancelId,
          sessionId,
          messageId,
          f.unitId,
          evidenceAttempt,
          variant === 'wrong-epoch' ? '8' : '7',
          f.request.authority.principal,
          variant === 'no-proof' ? 'REQUESTED' : 'CONFIRMED',
          variant === 'no-proof' ? null : 'synthetic-correlated-stop-proof'
        ]
      )
      await pool.query(
        `INSERT INTO durable_runtime.session_context_records
        (id,session_id,revision,kind,target_message_id,body_ref) VALUES ($1,$2,1,'CANCEL_INTENT',$3,$4)`,
        [
          randomUUID(),
          sessionId,
          messageId,
          JSON.stringify({
            operationId: oldCancelId,
            fixedDelivery: {
              deliveryAttemptId: variant === 'wrong-delivery' ? randomUUID() : deliveryId
            }
          })
        ]
      )
      await pool.query('UPDATE durable_runtime.sessions SET context_revision=1 WHERE id=$1', [
        sessionId
      ])
      const before = await pool.query(
        `SELECT m.cancel_requested_at, d.*, u.intent_revision,u.last_work_event_at,u.reconcile_due_at
        FROM durable_runtime.messages m JOIN durable_runtime.delivery_attempts d ON d.message_id=m.id
        JOIN durable_runtime.runtime_units u ON u.id=d.runtime_unit_id WHERE m.id=$1`,
        [messageId]
      )
      const cancel = {
        authority: f.request.authority,
        method: 'verification.cancel',
        operationKey: randomUUID(),
        targetMessageId: messageId,
        originalPayload: {}
      }
      const outcome = await requestInputCancel(pool, cancel)
      assert.equal(outcome.status, 'COMMITTED')
      const result = response(outcome)
      const expected = variant === 'confirmed' ? 'ALREADY_SETTLED' : 'REQUESTED'
      assert.equal(field(result, 'interruptStatus'), expected)
      const observed = await pool.query(
        `SELECT ci.*,m.intake_status,m.cancel_requested_at AS first_cancel_at,
        m.cancel_revision AS current_cancel_revision FROM durable_runtime.cancel_intents ci
        JOIN durable_runtime.messages m ON m.id=ci.target_message_id WHERE ci.operation_id=$1`,
        [field(result, 'operationId')]
      )
      const current = observed.rows[0]
      assert.equal(current.intake_status, 'INTERRUPTED')
      assert.equal(current.target_runtime_unit_id, f.unitId)
      assert.equal(current.target_attempt_id, attemptId)
      assert.equal(current.target_execution_epoch, '7')
      assert.equal(current.target_provider_turn_ref, 'synthetic-old-turn')
      assert.equal(current.interrupt_evidence_ref, null)
      assert.equal(current.current_cancel_revision, '2')
      assert.equal(
        current.first_cancel_at.toISOString(),
        before.rows[0].cancel_requested_at.toISOString()
      )
      const after = await pool.query(
        `SELECT d.*,u.intent_revision,u.last_work_event_at,u.reconcile_due_at
        FROM durable_runtime.delivery_attempts d JOIN durable_runtime.runtime_units u ON u.id=d.runtime_unit_id
        WHERE d.id=$1`,
        [deliveryId]
      )
      const { cancel_requested_at: _firstCancel, ...beforeDelivery } = before.rows[0]
      assert.deepEqual(after.rows[0], beforeDelivery)
      const contexts = await pool.query(
        `SELECT body_ref FROM durable_runtime.session_context_records
        WHERE session_id=$1 ORDER BY revision`,
        [sessionId]
      )
      assert.equal(contexts.rowCount, 2)
      assert.equal(contexts.rows[0].body_ref.operationId, oldCancelId)
      const facts = contexts.rows[1].body_ref
      assert.equal(facts.preEffect, false)
      assert.equal(facts.interruptStatus, expected)
      assert.equal(facts.fixedDelivery.deliveryAttemptId, deliveryId)
      const outbox = await pool.query(
        'SELECT count(*)::text AS n FROM durable_runtime.outbox_events WHERE aggregate_id=$1',
        [sessionId]
      )
      assert.equal(outbox.rows[0].n, variant === 'confirmed' ? '0' : '1')
      const replay = await requestInputCancel(pool, cancel)
      assert.equal(replay.status, 'REPLAYED')
      assert.deepEqual(response(replay), result)
    }
  } finally {
    await pool.end()
  }
})
