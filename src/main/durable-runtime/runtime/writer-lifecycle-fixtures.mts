import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { withDurableTransaction } from '../db/connection.ts'
import { createAgentPodPlanner } from './agent-pod-plan.ts'
import { counter } from '../../../shared/durable-runtime/identity.ts'
import type { VerifiedControllerIdentity } from './gateway/types.ts'

/** Only isolated fixture DBs call this; no production grant/evidence is issued. */
export async function seedWriterLifecycle(pool:Pool, physical?: {attemptId:string;runtimeUnitId:string;podName:string;podUid:string}) {
  const ids={attemptId:randomUUID(),runtimeUnitId:randomUUID(),podName:'fixture-agent-'+randomUUID(),podUid:'fixture-uid-'+randomUUID(),...physical}
  const candidate={...ids,executionEpoch:'1',incarnation:'fixture-incarnation',status:'READY'}
  const session=randomUUID(),workspace=randomUUID(),agent=randomUUID(),binding=randomUUID(),operation=randomUUID(),exportId=randomUUID()
  // SAFETY: Controller identity exists only in this owned synthetic database.
  const controller={scope:'fixture-stop:'+randomUUID(),owner:'fixture-current-controller',term:counter('controller-term','2')} as VerifiedControllerIdentity
  const leaf=randomUUID()
  const plan=createAgentPodPlanner({namespace:'orca-dev',dataset:'orca-1012-dev-v1',image:'example.invalid/fixture@sha256:'+'1'.repeat(64),
    entrypoint:{command:['node'],args:['-e','setInterval(()=>{},1000)']},nfsServer:'fixture.invalid',protectedExportRoot:'/exports/runtime-domains/orca-1012-dev-v1',
    paths:{home:'/agent/home',claudeState:'/agent/home/.claude',codexState:'/agent/home/.codex',checkout:'/agent/checkout'},
    protectedMounts:[{key:'home',clientPath:'/agent'}],shared:{claimName:'fixture-shared',claimUid:'fixture-shared-uid',pvUid:'fixture-shared-pv',serverPath:'/exports/shared/orca-1012-dev-v1'}})
    .plan({identity:{unitId:ids.runtimeUnitId,attemptId:ids.attemptId,operationId:operation,resourceName:ids.podName,executionEpoch:'1',intentRevision:'0',specHash:'a'.repeat(64)},
      protectedBindings:[{key:'home',mode:'RW',bindingId:binding,leafId:leaf,claimName:'fixture-home',claimUid:'fixture-home-uid',pvUid:'fixture-home-pv',serverPath:'/exports/runtime-domains/orca-1012-dev-v1/'+leaf}],
      profile:{revision:'0',cpuMilli:50,memoryMi:128,ephemeralMi:128,temporaryMi:64}})
  await withDurableTransaction(pool,async tx=>{
    await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'synthetic')",[agent])
    await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1,$2,'writer lifecycle fixture','READY')",[workspace,'fixture:'+workspace])
    await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')",[session,agent,workspace])
    await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase,execution_epoch) VALUES($1,'RUNNING','READY',1)",[ids.runtimeUnitId])
    await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0)",[ids.runtimeUnitId])
    await tx.query(`INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,pod_uid,incarnation,resource_profile_revision,effective_resources,status,started_at)
      VALUES($1,$2,1,'COLD',$3,$4,0,'{}','READY',clock_timestamp())`,[ids.attemptId,ids.runtimeUnitId,ids.podUid,candidate.incarnation])
    await tx.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=$2 WHERE id=$1',[ids.runtimeUnitId,ids.attemptId])
    await tx.query("INSERT INTO durable_runtime.controller_leases(scope,owner,term,expires_at) VALUES($1,$2,2,clock_timestamp()+interval '10 minutes')",[controller.scope,controller.owner])
    await tx.query(`INSERT INTO durable_runtime.operations(id,runtime_unit_id,kind,intent_revision,controller_scope,controller_term,step,execution_epoch,external_resource_name)
      VALUES($1,$2,'WAKE',0,$3,1,'ENSURE_ATTEMPT',1,$4)`,[operation,ids.runtimeUnitId,controller.scope,ids.podName])
    await tx.query("INSERT INTO durable_runtime.storage_domains(backend_id,export_id) VALUES('fixture-backend',$1)",[exportId])
    await tx.query(`INSERT INTO durable_runtime.storage_bindings(id,backend_id,export_id,canonical_directory,access_state,writer_attempt_id,identity_proof_ref,identity_verified_at)
      VALUES($1,'fixture-backend',$2,$3,'ACTIVE',$4,'fixture-identity',clock_timestamp())`,[binding,exportId,'/fixture/'+binding,ids.attemptId])
    await tx.query('INSERT INTO durable_runtime.runtime_members(runtime_unit_id,session_id,storage_binding_id) VALUES($1,$2,$3)',[ids.runtimeUnitId,session,binding])
    await tx.query("INSERT INTO durable_runtime.execution_grants(id,runtime_unit_id,attempt_id,execution_epoch,state) VALUES($1,$2,$3,1,'ACTIVE')",[randomUUID(),ids.runtimeUnitId,ids.attemptId])
    const grant=randomUUID()
    await tx.query("INSERT INTO durable_runtime.storage_write_grants(id,storage_binding_id,attempt_id,storage_epoch,state) VALUES($1,$2,$3,0,'ACTIVE')",[grant,binding,ids.attemptId])
    await tx.query(`INSERT INTO durable_runtime.storage_mounts(id,storage_binding_id,attempt_id,pod_uid,mode,write_grant_id,desired_state,observed_state,grant_epoch)
      VALUES($1,$2,$3,$4,'RW',$5,'ACTIVE','ACTIVE',0)`,[randomUUID(),binding,ids.attemptId,ids.podUid,grant])
    await tx.query(`INSERT INTO durable_runtime.agent_pod_plans(operation_id,runtime_unit_id,dataset_name,attempt_id,execution_epoch,intent_revision,namespace,resource_name,spec_hash,pod_spec_sha256,plan_digest,plan)
      VALUES($1,$2,'orca-1012-dev-v1',$3,1,0,'orca-dev',$4,$5,$6,$7,$8)`,[operation,ids.runtimeUnitId,ids.attemptId,ids.podName,'a'.repeat(64),plan.podSpecSHA256,'b'.repeat(64),JSON.stringify(plan)])
    for(const [i,state] of ['DURABLE','UNKNOWN'].entries()) {
      await tx.query('INSERT INTO durable_runtime.messages(id,session_id,seq,body_or_blob_ref,intake_status) VALUES($1,$2,$3,$4,$5)',[randomUUID(),session,i+1,JSON.stringify({text:'fixture-'+state}),state])
    }
  })
  return {candidate,controller,session,binding,operation,plan}
}
