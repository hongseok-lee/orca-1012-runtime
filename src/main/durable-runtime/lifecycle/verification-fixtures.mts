import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { createDurablePool, withDurableTransaction } from '../db/connection.ts'
import { logicalId, counter } from '../../../shared/durable-runtime/identity.ts'
import { lockUnitMembers } from './locks.ts'
import { LIFECYCLE_CONTROLLER_SCOPE } from './intent.ts'
import type { UnitIntentRequest, UnitIntentAuthority } from './types.ts'
import type { VerifiedControllerIdentity, ExecutorId } from '../runtime/gateway/types.ts'
import type { PreparedMemberActivity, LifecycleActivityAuthority } from './sleep.ts'

// All authority/evidence assertions in this file are isolated fixtures. They
// cannot qualify production authentication, activity freshness or G04 fencing.
export const policy = Object.freeze({ operationDeadlineMs: 60000, idleDurationMs: 60000 })
export function ownPool(): Pool {
  const database = process.env.PGDATABASE ?? ''
  if (!/^orca_p113_[a-z0-9_]+$/.test(database)) { throw new Error('P1-13 owned verification database required') }
  return createDurablePool({ database })
}
export async function fixture(pool: Pool, count = 2) {
  const unit = logicalId('runtime-unit', randomUUID()), workspace = randomUUID(), agent = randomUUID()
  const sessions = Array.from({ length: count }, () => logicalId('session', randomUUID()))
  const binding = randomUUID(), backend = `fixture-${unit}`, exportId = 'fixture-export'
  await withDurableTransaction(pool, async tx => {
    await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'fixture')", [agent])
    await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'fixture','READY')", [workspace, `fixture-${unit}`])
    await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','ABSENT')", [unit])
    await tx.query('INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,$2)', [backend, exportId])
    await tx.query("INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state) VALUES($1,$2,$3,$4,'UNKNOWN')", [binding, backend, exportId, `/fixture/${unit}`])
    for (const session of sessions) {
      await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [session, agent, workspace])
      await tx.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)', [unit, session, binding])
    }
  })
  return { unit, sessions, binding }
}
export async function intent(pool: Pool, f: Awaited<ReturnType<typeof fixture>>, desired: 'RUNNING' | 'DELETED' = 'RUNNING'): Promise<UnitIntentRequest> {
  const row = (await pool.query('SELECT revision,intent_revision FROM durable_runtime.runtime_units WHERE id=$1', [f.unit])).rows[0]
  return { authority: { principalId: 'lifecycle-test', runtimeUnitId: f.unit, scope: `fixture-unit:${f.unit}` } as UnitIntentAuthority,
    operationKey: randomUUID(), desired, expectedRevision: counter('row:runtime-unit', row.revision),
    expectedIntentRevision: counter('intent-revision', row.intent_revision), policy }
}
export async function stoppedMetadataAttempt(pool: Pool, f: Awaited<ReturnType<typeof fixture>>, active: boolean) {
  const attempt = logicalId('attempt', randomUUID()), podUid = `fixture-pod-${attempt}`
  await withDurableTransaction(pool, async tx => {
    await lockUnitMembers(tx, f.unit, f.sessions)
    await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0)", [f.unit])
    await tx.query(`INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,
      resource_profile_revision,effective_resources,status,stopped_at) VALUES($1,$2,0,'COLD',$3,'fixture',0,'{}',$4,$5)`,
      [attempt, f.unit, podUid, active ? 'RUNNING' : 'OBSERVED_STOPPED', active ? null : new Date()])
    if (active) { await tx.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=$2 WHERE id=$1', [f.unit, attempt]) }
  })
  return { attempt, podUid }
}
export function activity(f: Awaited<ReturnType<typeof fixture>>, a: Awaited<ReturnType<typeof stoppedMetadataAttempt>>, busySession?: string): LifecycleActivityAuthority {
  const frames = new Map(f.sessions.map(session => [session, Object.freeze({ sessionId: session, attemptId: a.attempt,
    podUid: a.podUid, executionEpoch: '0', observedAt: new Date(), producerCommittedWatermark: '1', observedWatermark: '1',
    sourceEvidenceRef: 'fixture-only-not-physical-proof', activeTurn: session === busySession, activeTool: false,
    backgroundWriter: false, inFlightDispatch: false }) as PreparedMemberActivity]))
  return { member: session => frames.get(session) ?? null, pinValid: frame => frames.get(frame.sessionId) === frame }
}
export async function controller(pool: Pool, owner: string, term: string): Promise<VerifiedControllerIdentity> {
  await pool.query(`INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at)
    VALUES($1,$2,$3,clock_timestamp()+interval '1 hour') ON CONFLICT(scope) DO UPDATE SET owner=$2,term=$3,
    expires_at=clock_timestamp()+interval '1 hour',revision=durable_runtime.controller_leases.revision+1`, [LIFECYCLE_CONTROLLER_SCOPE, owner, term])
  return { scope: LIFECYCLE_CONTROLLER_SCOPE, owner, term: counter('controller-term', term) } as VerifiedControllerIdentity
}
export const executor = 'fixture-owned-executor' as ExecutorId
