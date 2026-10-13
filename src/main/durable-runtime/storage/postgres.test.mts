import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createDurablePool, DurableDatabaseError, withDurableTransaction } from '../db/connection.ts';
import { applyMigrations, readMigrations } from '../db/migrate.ts';
import { lockAggregates } from '../db/locks.ts';
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts';
import { StorageStore, type StorageTarget } from './store.ts';
import type { StorageEvidenceAuthority, VerifiedDirectoryEvidence, VerifiedMountEvidence,
  VerifiedPermanentComputeStop, ExecutionTarget } from './evidence.ts';
import type { CanonicalCandidate } from './canonical.ts';

if (!/^orca_p110_[a-z0-9_]+$/.test(process.env.PGDATABASE ?? '')) throw new Error('Owned storage test database required');
const pool = createDurablePool({ max: 8, application_name: 'p110-storage-owned-test' });
const sql = (text: string, values: unknown[] = []) => withDurableTransaction(pool, tx => tx.query(text, values));
const unitRevision = (n: number) => counter('row:runtime-unit', String(n));
const bindingRevision = (n: number) => counter('row:storage-binding', String(n));
const epoch = (n: number) => counter('storage-epoch', String(n));
const rejectCode = (operation: Promise<unknown>, code: string) => assert.rejects(operation,
  e => e instanceof DurableDatabaseError && e.code === code);

// Synthetic attestation is confined to this fixture. It is NOT actual NFS,
// workload authentication, GCE deletion or a production verifier.
class FixtureAuthority implements StorageEvidenceAuthority {
  directories = new Map<string, VerifiedDirectoryEvidence>();
  mounts = new Map<string, VerifiedMountEvidence>();
  targets = new Map<string, ExecutionTarget>();
  stops = new Map<string, VerifiedPermanentComputeStop>();
  changed = false;
  async directory(ref: string) { return this.directories.get(ref) ?? null; }
  async revalidateDirectory(value: VerifiedDirectoryEvidence) {
    return this.changed ? null : this.directories.get(value.evidenceRef) ?? null;
  }
  async mount(ref: string) { return this.mounts.get(ref) ?? null; }
  async executionTarget(id: string) { return this.targets.get(id) ?? null; }
  async permanentComputeStop(ref: string) { return this.stops.get(ref) ?? null; }
  directoryFixture(ref: string, candidate: CanonicalCandidate) {
    const value = { evidenceRef: ref, candidate } as VerifiedDirectoryEvidence;
    this.directories.set(ref, value); return value;
  }
  mountFixture(ref: string, target: ExecutionTarget, directory: CanonicalCandidate, mode: 'RO' | 'RW', actualReadOnly = mode === 'RO') {
    this.mounts.set(ref, { evidenceRef: ref, target, directory, mode, actualReadOnly } as VerifiedMountEvidence);
  }
  stopFixture(ref: string, target: ExecutionTarget, numericId = target.numericInstanceId) {
    this.stops.set(ref, { proof: { ...target, kind: 'COMPUTE_STOPPED', observationSource: 'COMPUTE_CONTROL_PLANE',
      evidenceRef: ref, observedAt: new Date().toISOString() }, numericInstanceId: numericId,
      disposition: 'DELETED_NO_REENTRY' } as VerifiedPermanentComputeStop);
  }
}
async function fixture(a: FixtureAuthority, domain = randomUUID(), directory = '/home') {
  const unit = logicalId('runtime-unit', randomUUID()), attempt = logicalId('attempt', randomUUID());
  const next = logicalId('attempt', randomUUID()), session = logicalId('session', randomUUID());
  const binding = logicalId('storage-binding', randomUUID()), workspace = randomUUID(), agent = randomUUID();
  const pod = 'fixture-pod-' + attempt, incarnation = 'fixture-incarnation-' + attempt;
  const candidate: CanonicalCandidate = { domain: { backendId: 'fixture-pv', exportId: domain, pvUid: domain },
    canonicalDirectory: directory, podUid: 'fixture-server', generation: 'fixture-1', device: '123', inode: directory === '/home' ? '42' : '43' };
  const ref = 'fixture-directory-' + binding;
  a.directoryFixture(ref, candidate);
  const execution = { attemptId: attempt, podUid: pod, incarnation, executionEpoch: counter('execution-epoch', '0'),
    nodeUid: 'fixture-node-' + unit, computeIdentityRef: 'fixture-compute-' + unit, numericInstanceId: '123456' } as ExecutionTarget;
  a.targets.set(attempt, execution);
  await withDurableTransaction(pool, async tx => {
    await tx.query("INSERT INTO durable_runtime.workspaces(id,public_id,name,provisioning_state) VALUES($1::uuid,$2::text,'fixture','READY')", [workspace,workspace]);
    await tx.query("INSERT INTO durable_runtime.agents(id,provider) VALUES($1,'synthetic')", [agent]);
    await tx.query("INSERT INTO durable_runtime.sessions(id,agent_id,workspace_id,lifecycle) VALUES($1,$2,$3,'OPEN')", [session,agent,workspace]);
    await tx.query("INSERT INTO durable_runtime.runtime_units(id,desired_mode,phase) VALUES($1,'RUNNING','READY')", [unit]);
    await tx.query("INSERT INTO durable_runtime.resource_profiles(runtime_unit_id,revision,container_resources,policy_revision) VALUES($1,0,'{}',0)", [unit]);
    await tx.query(`INSERT INTO durable_runtime.attempts(id,runtime_unit_id,execution_epoch,mode,resource_profile_revision,effective_resources,pod_uid,incarnation,status)
      VALUES($1,$2,0,'COLD',0,'{}',$3,$4,'READY'),($5,$2,1,'COLD',0,'{}',$6,'fixture-next-incarnation','READY')`,
      [attempt,unit,pod,incarnation,next,'fixture-next-pod']);
    await tx.query('UPDATE durable_runtime.runtime_units SET active_attempt_id=$2 WHERE id=$1', [unit,attempt]);
    await tx.query("INSERT INTO durable_runtime.execution_grants(id,runtime_unit_id,attempt_id,execution_epoch,state) VALUES($1,$2,$3,0,'ACTIVE')", [randomUUID(),unit,attempt]);
    await new StorageStore(a).registerBinding(tx, { bindingId: binding, directoryEvidenceRef: ref,
      sessionId: session, unitId: unit, expectedUnitRevision: unitRevision(0), actorId: 'fixture-principal' });
  });
  const target: StorageTarget = { sessionId: session, unitId: unit, bindingId: binding,
    attemptId: attempt, podUid: pod, executionEpoch: counter('execution-epoch','0'),
    storageEpoch: epoch(0), expectedUnitRevision: unitRevision(0), expectedBindingRevision: bindingRevision(0), actorId: 'fixture-principal' };
  return { target, candidate, ref, execution, next };
}
const state = async (binding: string) => (await sql('SELECT epoch,revision,access_state FROM durable_runtime.storage_bindings WHERE id=$1', [binding])).rows[0];
const grantState = async (grant: string) => (await sql('SELECT state,revision FROM durable_runtime.storage_write_grants WHERE id=$1', [grant])).rows[0];

await test('P1-10 actual PostgreSQL with synthetic authority', async t => {
  try {
    await applyMigrations(pool, await readMigrations(process.env.P110_MIGRATIONS!));
    const run = (name: string, body: () => Promise<void>) => t.test(name, { skip: !!process.env.P110_ONLY && process.env.P110_ONLY !== name }, body);
    await run('no authority evidence means no verified binding', async () => {
      const a = new FixtureAuthority(); const store = new StorageStore(a);
      // Invalid proof is rejected before SQL; no fabricated success or new grant.
      await rejectCode(withDurableTransaction(pool, tx => store.registerBinding(tx, {
        sessionId: logicalId('session',randomUUID()), unitId: logicalId('runtime-unit',randomUUID()),
        expectedUnitRevision: unitRevision(0), actorId:'fixture', bindingId:logicalId('storage-binding',randomUUID()), directoryEvidenceRef:'untrusted-ref'
      })), 'STORAGE_DIRECTORY_UNVERIFIED');
    });
    await run('parent/child domain blocks another writer; direct SQL bypass also rejects', async () => {
      const a = new FixtureAuthority(), d = randomUUID(), store = new StorageStore(a);
      const f = await fixture(a,d,'/home'), child = await fixture(a,d,'/home/child');
      const g = randomUUID();
      assert.equal((await withDurableTransaction(pool,tx=>store.reserveWriter(tx,{...f.target,grantId:g}))).status,'APPLIED');
      const blocked = await withDurableTransaction(pool,tx=>store.reserveWriter(tx,{...child.target,grantId:randomUUID()}));
      assert.equal(blocked.status,'BLOCKED'); assert.deepEqual(await grantState(g),{state:'RESERVED',revision:'0'});
      await rejectCode(sql(`INSERT INTO durable_runtime.storage_write_grants(id,storage_binding_id,attempt_id,storage_epoch,state) VALUES($1,$2,$3,0,'RESERVED')`,
        [randomUUID(),child.target.bindingId,child.target.attemptId]), '23505');
    });
    await run('two RO observations coexist; desired flag without real RO observation is BLOCKED', async () => {
      const a=new FixtureAuthority(), f=await fixture(a), store=new StorageStore(a);
      const ids=[randomUUID(),randomUUID()];
      for(let i=0;i<2;i++) await withDurableTransaction(pool,tx=>store.registerReadOnlyMount(tx,{...f.target,expectedBindingRevision:bindingRevision(i),mountId:ids[i]}));
      a.mountFixture('fixture-ro',f.execution,f.candidate,'RO');
      for(let i=0;i<2;i++) assert.equal((await withDurableTransaction(pool,tx=>store.observeMount(tx,{...f.target,expectedBindingRevision:bindingRevision(2+i),mountId:ids[i],mountEvidenceRef:'fixture-ro'}))).status,'APPLIED');
      assert.equal((await sql("SELECT count(*)::text AS count FROM durable_runtime.storage_mounts WHERE storage_binding_id=$1 AND observed_state='ACTIVE' AND mode='RO'",[f.target.bindingId])).rows[0].count,'2');
      a.mountFixture('fixture-not-ro',f.execution,f.candidate,'RO',false);
      const m=randomUUID();await withDurableTransaction(pool,tx=>store.registerReadOnlyMount(tx,{...f.target,expectedBindingRevision:bindingRevision(4),mountId:m}));
      assert.equal((await withDurableTransaction(pool,tx=>store.observeMount(tx,{...f.target,expectedBindingRevision:bindingRevision(5),mountId:m,mountEvidenceRef:'fixture-not-ro'}))).status,'BLOCKED');
      assert.equal((await sql('SELECT observed_state FROM durable_runtime.storage_mounts WHERE id=$1',[m])).rows[0].observed_state,'RESERVED');
    });
    await run('held locks reenter; transitions and journal/audit/outbox roll back together', async () => {
      const a=new FixtureAuthority(), f=await fixture(a), store=new StorageStore(a), g=randomUUID();
      const before=(await sql('SELECT count(*)::text AS n FROM durable_runtime.session_events WHERE session_id=$1',[f.target.sessionId])).rows[0].n;
      await assert.rejects(withDurableTransaction(pool,async tx=>{
        await lockAggregates(tx,{sessionIds:[f.target.sessionId],runtimeUnitIds:[f.target.unitId],storageDomains:[{backendId:f.candidate.domain.backendId,exportId:f.candidate.domain.exportId}]});
        await store.reserveWriter(tx,{...f.target,grantId:g}); throw new Error('fixture-rollback');
      }), /fixture-rollback/);
      assert.equal((await sql('SELECT count(*)::text AS n FROM durable_runtime.storage_write_grants WHERE id=$1',[g])).rows[0].n,'0');
      assert.equal((await sql('SELECT count(*)::text AS n FROM durable_runtime.session_events WHERE session_id=$1',[f.target.sessionId])).rows[0].n,before);
      const result=await withDurableTransaction(pool,tx=>store.reserveWriter(tx,{...f.target,grantId:g}));assert.equal(result.status,'APPLIED');
      const counts=(await sql(`SELECT
        (SELECT count(*) FROM durable_runtime.session_events WHERE session_id=$1)::text AS journal,
        (SELECT count(*) FROM durable_runtime.runtime_audit_events WHERE session_id=$1)::text AS audit,
        (SELECT count(*) FROM durable_runtime.outbox_events WHERE aggregate_id=$2)::text AS outbox`,[f.target.sessionId,f.target.bindingId])).rows[0];
      assert.deepEqual(counts,{journal:'2',audit:'2',outbox:'2'});
    });
    await run('stale row revision, Pod UID, epoch and unit membership cannot grant', async () => {
      const a=new FixtureAuthority(), f=await fixture(a), store=new StorageStore(a);
      for(const patch of [{expectedBindingRevision:bindingRevision(99)}, {storageEpoch:epoch(99)}])
        await rejectCode(withDurableTransaction(pool,tx=>store.reserveWriter(tx,{...f.target,...patch,grantId:randomUUID()})), 'STORAGE_BINDING_STALE');
      for(const patch of [{podUid:'stale-pod'}, {executionEpoch:counter('execution-epoch','99')}, {sessionId:logicalId('session',randomUUID())}]) {
        await assert.rejects(withDurableTransaction(pool,tx=>store.reserveWriter(tx,{...f.target,...patch,grantId:randomUUID()})),
          e=>e instanceof DurableDatabaseError && ['STORAGE_TARGET_STALE','LOCK_TARGET_MISSING'].includes(e.code));
      }
      await rejectCode(withDurableTransaction(pool,tx=>store.reserveWriter(tx,{...f.target,expectedUnitRevision:unitRevision(99),grantId:randomUUID()})), 'STORAGE_UNIT_STALE');
      assert.equal((await sql('SELECT count(*)::text AS n FROM durable_runtime.storage_write_grants WHERE storage_binding_id=$1',[f.target.bindingId])).rows[0].n,'0');
    });
    await run('concurrent overlapping reservation has exactly one writer', async () => {
      const a=new FixtureAuthority(),d=randomUUID(), f=await fixture(a,d,'/race'), child=await fixture(a,d,'/race/child'),store=new StorageStore(a);
      const result=await Promise.all([f,child].map(item=>withDurableTransaction(pool,tx=>store.reserveWriter(tx,{...item.target,grantId:randomUUID()}))));
      assert.equal(result.filter(r=>r.status==='APPLIED').length,1);assert.equal(result.filter(r=>r.status==='BLOCKED').length,1);
      assert.equal((await sql(`SELECT count(*)::text AS n FROM durable_runtime.storage_write_grants g JOIN durable_runtime.storage_bindings b ON b.id=g.storage_binding_id WHERE b.export_id=$1 AND g.state IN ('RESERVED','ACTIVE','REVOKING')`,[d])).rows[0].n,'1');
    });
    await run('failed and wrong-incarnation revoke preserve REVOKING; synthetic exact proof alone completes', async () => {
      const a=new FixtureAuthority(),f=await fixture(a),store=new StorageStore(a),g=randomUUID(),m=randomUUID();
      await withDurableTransaction(pool,tx=>store.reserveWriter(tx,{...f.target,grantId:g}));
      a.mountFixture('fixture-rw',f.execution,f.candidate,'RW');
      await withDurableTransaction(pool,tx=>store.observeMount(tx,{...f.target,expectedBindingRevision:bindingRevision(1),mountId:m,mountEvidenceRef:'fixture-rw',writer:{grantId:g,expectedRevision:'0'}}));
      await withDurableTransaction(pool,tx=>store.beginRevocation(tx,{...f.target,expectedBindingRevision:bindingRevision(2),grantId:g,expectedGrantRevision:'1',expectedGrantState:'ACTIVE'}));
      const revoke=(binding:number,unit:number,ref:string)=>withDurableTransaction(pool,tx=>store.confirmRevocation(tx,{...f.target,expectedBindingRevision:bindingRevision(binding),expectedUnitRevision:unitRevision(unit),grantId:g,expectedGrantRevision:'2',permanentStopRef:ref}));
      assert.equal((await revoke(3,0,'unverified-user-ref')).status,'BLOCKED');assert.deepEqual(await grantState(g),{state:'REVOKING',revision:'2'});
      a.stopFixture('wrong-id',f.execution,'987654');assert.equal((await revoke(4,1,'wrong-id')).status,'BLOCKED');
      a.stopFixture('fixture-exact',f.execution);const applied=await revoke(5,2,'fixture-exact');assert.equal(applied.status,'APPLIED');
      assert.deepEqual(await grantState(g),{state:'REVOKED',revision:'3'});assert.equal((await state(f.target.bindingId)).epoch,'1');
      await rejectCode(revoke(6,2,'fixture-exact'),'STORAGE_BINDING_STALE');
      assert.equal((await sql('SELECT observed_state FROM durable_runtime.storage_mounts WHERE id=$1',[m])).rows[0].observed_state,'REVOKED');
    });
    await run('changed directory observation blocks without replacing held identity or releasing writer',async()=>{
      const a=new FixtureAuthority(),f=await fixture(a),store=new StorageStore(a),g=randomUUID();
      await withDurableTransaction(pool,tx=>store.reserveWriter(tx,{...f.target,grantId:g}));a.changed=true;
      const m=await withDurableTransaction(pool,tx=>store.observeMount(tx,{...f.target,expectedBindingRevision:bindingRevision(1),mountId:randomUUID(),mountEvidenceRef:'arbitrary',writer:{grantId:g,expectedRevision:'0'}}));
      assert.equal(m.status,'BLOCKED');assert.deepEqual(await grantState(g),{state:'RESERVED',revision:'0'});
      assert.equal((await sql('SELECT identity_proof_ref FROM durable_runtime.storage_bindings WHERE id=$1',[f.target.bindingId])).rows[0].identity_proof_ref,f.ref);
    });
  } finally { await pool.end(); }
});
