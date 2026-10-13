// Shared isolated-PG fixture helpers; never imported by product gateway code.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import {
  createDurablePool,
  withDurableTransaction,
  DurableDatabaseError
} from '../../db/connection.ts'
import { LockedGatewayAuthority } from './authority.ts'
import { inputDigest } from './input.ts'
import { submitCommand } from './store.ts'
if (!/^orca_p109_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? '')) {
  throw new Error('OWN_DATABASE_REQUIRED')
}
const pool = createDurablePool({ max: 6, application_name: 'p109-isolated-gateway-tests' })
const results = []
const selected = process.env.ORCA_P109_CASE
let producerSeq = 0n
const producerId = randomUUID()

async function fixture(session = false) {
  const id = randomUUID(),
    operationId = randomUUID(),
    attemptId = randomUUID()
  const controller = { scope: `fixture:${id}`, owner: `controller:${id}`, term: '1' }
  const context = { runtimeUnitId: id, operationId, controller }
  const pod = `fixture-pod:${attemptId}`
  const envelope = {
    operationId,
    controllerTerm: '1',
    stepRevision: '0',
    executionEpoch: '1',
    intentRevision: '1',
    podTarget: 'EXISTING_POD',
    expectedPodUid: pod
  }
  const sessionId = session ? randomUUID() : null
  await withDurableTransaction(pool, async (tx) => {
    await tx.query(
      "INSERT INTO durable_runtime.runtime_units(id,desired_mode,intent_revision,execution_epoch,phase) VALUES($1,'RUNNING',1,1,'READY')",
      [id]
    )
    await tx.query(
      "INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,1,'{}',1)",
      [id]
    )
    await tx.query(
      "INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,resource_profile_revision,effective_resources,status) VALUES($1,$2,1,'COLD',$3,1,'{}','READY')",
      [attemptId, id, pod]
    )
    await tx.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=$2 WHERE id=$1', [
      id,
      attemptId
    ])
    await tx.query(
      "INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,$2,1,clock_timestamp()+interval '30 minutes')",
      [controller.scope, controller.owner]
    )
    await tx.query(
      "INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,step_revision,expected_pod_uid,execution_epoch) VALUES($1,$2,'fixture',1,$3,1,'fixture',0,$4,1)",
      [operationId, id, controller.scope, pod]
    )
    if (sessionId) {
      const agent = randomUUID(),
        workspace = randomUUID(),
        storage = randomUUID()
      await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'fixture')", [
        agent
      ])
      await tx.query(
        "INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1::uuid,$1::text,'fixture','READY')",
        [workspace]
      )
      await tx.query(
        "INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')",
        [sessionId, agent, workspace]
      )
      await tx.query(
        "INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES($1,'fixture')",
        [id]
      )
      await tx.query(
        "INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state) VALUES($1,$2,'fixture',$3,'RO')",
        [storage, id, `/fixture/${id}`]
      )
      await tx.query(
        'INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)',
        [id, sessionId, storage]
      )
    }
  })
  return { context, envelope, sessionId, attemptId }
}
function request(f, command = 'stageInput', input = { fixture: true }) {
  return {
    command,
    envelope: { ...f.envelope },
    inputHash: inputDigest(input),
    input,
    predecessor: { kind: 'NONE' }
  }
}
function original(r) {
  return { command: r.command, originalEnvelope: r.envelope, inputHash: r.inputHash }
}
async function inGateway(f, body) {
  return withDurableTransaction(pool, async (tx) =>
    body(await LockedGatewayAuthority.acquire(tx, f.context))
  )
}
async function accept(f, r = request(f)) {
  return inGateway(f, (a) => submitCommand(a, r))
}
function mutationRequest(f, action, key = randomUUID()) {
  return {
    context: f.context,
    mutationKey: key,
    action,
    sessionIds: f.sessionId ? [f.sessionId] : [],
    observation: {
      producerId,
      producerSeq: String(++producerSeq),
      occurredAt: new Date(),
      receivedAt: new Date()
    }
  }
}
async function rejected(body, code) {
  await assert.rejects(body, (e) => e instanceof DurableDatabaseError && e.code === code)
}
async function counts(f) {
  const q = await pool.query(
    `SELECT
    (SELECT count(*)::int FROM durable_runtime.runtime_commands WHERE runtime_unit_id=$1) AS commands,
    (SELECT count(*)::int FROM durable_runtime.runtime_command_history h JOIN durable_runtime.runtime_commands c ON c.id=h.command_id WHERE c.runtime_unit_id=$1) AS history,
    (SELECT count(*)::int FROM durable_runtime.runtime_audit_events WHERE runtime_unit_id=$1) AS audit,
    (SELECT count(*)::int FROM durable_runtime.outbox_events WHERE event->>'runtimeUnitId'=$1::text) AS outbox,
    (SELECT count(*)::int FROM durable_runtime.session_events WHERE body->>'runtimeUnitId'=$1::text) AS journal,
    (SELECT count(*)::int FROM durable_runtime.rpc_receipts WHERE session_scope='runtime-unit:'||$1::text) AS receipts`,
    [f.context.runtimeUnitId]
  )
  return q.rows[0]
}
function gate() {
  let release
  const promise = new Promise((r) => {
    release = r
  })
  return { promise, release }
}
async function waitForLock(pid) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const r = await pool.query(
      "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE datname=current_database() AND pid=$1",
      [pid]
    )
    if (r.rows[0]?.waiting) {
      return true
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  return false
}
async function test(name, body) {
  if (selected && selected !== name) {
    return
  }
  const start = Date.now()
  try {
    const observed = await body()
    results.push({ name, passed: true, durationMs: Date.now() - start, observed: observed ?? {} })
  } catch (error) {
    results.push({
      name,
      passed: false,
      durationMs: Date.now() - start,
      errorCode: typeof error?.code === 'string' ? error.code : (error?.name ?? 'UNEXPECTED')
    })
    process.exitCode = 1
  }
  await writeFile(
    process.env.ORCA_P109_RESULT,
    `${JSON.stringify({ schemaPrerequisite: process.env.ORCA_P109_SCHEMA, sourceRevision: process.env.ORCA_P109_REVISION, scope: 'isolated PostgreSQL/SQL fixture and callback boundary; no real authentication/provider/K8s fencing', cases: results }, null, 2)}\n`,
    { mode: 0o600 }
  )
  console.log(
    JSON.stringify({ name, passed: results.at(-1).passed, errorCode: results.at(-1).errorCode })
  )
  if (process.exitCode) {
    throw new Error('STOP_AFTER_NEW_FAILURE')
  }
}

export {
  pool,
  fixture,
  request,
  original,
  inGateway,
  accept,
  mutationRequest,
  rejected,
  counts,
  gate,
  waitForLock,
  test
}
