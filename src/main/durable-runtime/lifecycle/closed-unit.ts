import type { Pool } from 'pg'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { withDurableTransaction } from '../db/connection.ts'
import type { RuntimeUnitRow } from '../db/rows.ts'
import { currentAuthoritySql } from '../runtime/gateway/authority.ts'
import type { VerifiedControllerIdentity } from '../runtime/gateway/types.ts'
import { discoverUnitMembers, lockUnitMembers } from './locks.ts'
import { ensureIntentOperation } from './intent.ts'
import type { LifecyclePolicy } from './types.ts'

/** Finish already accepted close/DELETE intents. An open sibling always keeps
 * its unit alive; this never turns one tab's close into a shared-unit delete. */
export async function reconcileClosedUnits(pool: Pool, controller: VerifiedControllerIdentity, policy: LifecyclePolicy) {
  const auth = [controller.scope,controller.owner,controller.term]
  const candidates = await pool.query<{ id: string }>(`SELECT u.id FROM durable_runtime.runtime_units u
    WHERE ${currentAuthoritySql} AND (u.desired_mode='DELETED' OR EXISTS(SELECT 1 FROM durable_runtime.runtime_members m
      JOIN durable_runtime.sessions s ON s.id=m.session_id WHERE m.runtime_unit_id=u.id AND s.lifecycle='CLOSING'))
    AND NOT EXISTS(SELECT 1 FROM durable_runtime.runtime_members m JOIN durable_runtime.sessions s ON s.id=m.session_id
      WHERE m.runtime_unit_id=u.id AND s.lifecycle='OPEN') AND
      (u.active_attempt_id IS NOT NULL OR u.phase<>'ABSENT' OR EXISTS(SELECT 1 FROM durable_runtime.runtime_members m
       JOIN durable_runtime.sessions s ON s.id=m.session_id WHERE m.runtime_unit_id=u.id AND s.lifecycle='CLOSING')) LIMIT 16`, auth)
  for (const row of candidates.rows) {
    const id=logicalId('runtime-unit',row.id), members=await discoverUnitMembers(pool,id)
    await withDurableTransaction(pool,async tx=>{
      await lockUnitMembers(tx,id,members)
      if (!(await tx.query(`SELECT 1 WHERE ${currentAuthoritySql}`,auth)).rowCount ||
          (await tx.query("SELECT 1 FROM durable_runtime.sessions WHERE id=ANY($1::uuid[]) AND lifecycle='OPEN'",[members])).rowCount) {return}
      let unit=(await tx.query<RuntimeUnitRow>('SELECT * FROM durable_runtime.runtime_units WHERE id=$1',[id])).rows[0]
      if((await tx.query(`SELECT 1 FROM durable_runtime.runtime_commands WHERE runtime_unit_id=$1 AND
        (state IN ('ACCEPTED','EXECUTING') OR (state='UNKNOWN' AND command_name NOT IN ('dispatchInput','cancel'))) LIMIT 1`,[id])).rowCount) {return}
      if(unit.desired_mode!=='DELETED') {
        unit=(await tx.query<RuntimeUnitRow>(`UPDATE durable_runtime.runtime_units SET desired_mode='DELETED',phase='DELETING',
          intent_revision=intent_revision+1,revision=revision+1,reconcile_due_at=clock_timestamp() WHERE id=$1 RETURNING *`,[id])).rows[0]
      }
      const selected=await ensureIntentOperation(tx,unit,policy)
      if(unit.active_attempt_id || selected.blocked) {return}
      if((await tx.query(`SELECT 1 FROM durable_runtime.execution_grants WHERE runtime_unit_id=$1 AND state<>'REVOKED'
        UNION ALL SELECT 1 FROM durable_runtime.storage_write_grants g JOIN durable_runtime.attempts a ON a.id=g.attempt_id
          WHERE a.runtime_unit_id=$1 AND g.state<>'REVOKED' LIMIT 1`,[id])).rowCount) {return}
      await tx.query("UPDATE durable_runtime.sessions SET lifecycle='CLOSED',revision=revision+1 WHERE id=ANY($1::uuid[]) AND lifecycle='CLOSING'",[members])
      await tx.query("UPDATE durable_runtime.runtime_units SET phase='ABSENT',idle_due_at=NULL,reconcile_due_at=NULL,revision=revision+1 WHERE id=$1",[id])
      await tx.query(`UPDATE durable_runtime.operations SET step='SUCCEEDED',step_revision=step_revision+1,revision=revision+1,
        result='{"state":"SUCCEEDED","stopped":true}'::jsonb WHERE id=$1 AND result IS NULL`,[selected.operation.id])
    })
  }
  return candidates.rowCount ?? 0
}
