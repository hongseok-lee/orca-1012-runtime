import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {createDurablePool} from '../../db/connection.ts'
import {applyMigrations,readMigrations} from '../../db/migrate.ts'
import {createManagedAccountRotationStore} from './managed-account-rotation-store.ts'
if(process.env.PGDATABASE!=='orca_terminal_task05_20261019') {throw new Error('Owned task05 database required')}
test('PG account rotation commits before OAuth, excludes another owner and retains every consumed revision',async()=>{
  const pool=createDurablePool({max:4}),scope=`fixture-rotation:${randomUUID()}`,account=randomUUID()
  try {
    await applyMigrations(pool,await readMigrations(process.env.ORCA_TERMINAL_TEST_MIGRATIONS!))
    const a=createManagedAccountRotationStore(pool,scope,()=>{}),b=createManagedAccountRotationStore(pool,scope,()=>{})
    await assert.rejects(a.readRotation(account,'1:2:3:4'),/LOCK_REQUIRED/)
    await a.withAccountLock(account,async()=>{
      await assert.rejects(b.withAccountLock(account,async()=>{}),/BUSY/)
      await b.withAccountLock('other',async()=>assert.equal(await b.readRotation('other','1:2:3:4'),null))
      await a.recordRotation(account,'1:2:3:4','STARTED')
      // Independent connection sees COMMIT before the external refresh could run.
      const rows=(await pool.query('SELECT state FROM durable_runtime.managed_codex_account_rotations WHERE scope=$1',[scope])).rows
      assert.deepEqual(rows,[{state:'STARTED'}])
      await assert.rejects(a.withAccountLock(account,async()=>{}),/NESTED_LOCK/)
      await a.recordNativeStopped(account,'1:2:3:4')
    })
    await assert.rejects(a.withAccountLock(account,async()=>{
      await a.recordRotation(account,'1:2:4:4','STARTED')
      throw new Error('simulated OAuth response loss')
    }),/response loss/)
    await b.withAccountLock(account,async()=>{
      assert.deepEqual(await b.readRotation(account,'1:2:3:4'),{revision:'1:2:3:4',state:'STARTED'})
      assert.deepEqual(await b.readRotation(account,'1:2:4:4'),{revision:'1:2:4:4',state:'STARTED'})
      await assert.rejects(b.recordRotation(account,'1:2:4:4','COMPLETED'),/CLAIM_REQUIRED/)
      await assert.rejects(b.recordRotation(account,'1:2:5:4','STARTED'),/NATIVE_STOP_UNCONFIRMED/)
      await assert.rejects(b.recordNativeStopped(account,'1:2:4:4'),/CLAIM_REQUIRED/)
    })
    let current=true
    const expiring=createManagedAccountRotationStore(pool,scope,()=>{if(!current) {throw new Error('REQUEST_EXPIRED')}})
    await assert.rejects(expiring.withAccountLock('expired',async()=>{
      await expiring.recordRotation('expired','1:2:6:4','STARTED')
      current=false
      await expiring.recordNativeStopped('expired','1:2:6:4')
      await assert.rejects(expiring.recordRotation('expired','1:2:6:4','COMPLETED'),/REQUEST_EXPIRED/)
    }),/REQUEST_EXPIRED/)
    const cleanup=await pool.query('SELECT native_stopped_at FROM durable_runtime.managed_codex_account_rotations WHERE scope=$1 AND account_key=$2',[scope,JSON.stringify(['account','expired'])])
    assert.ok(cleanup.rows[0].native_stopped_at,'original owner retains stop proof even after request expiration')
    await a.withAccountLock('completed',async()=>{
      await a.recordRotation('completed','1:2:5:4','STARTED')
      await assert.rejects(a.recordRotation('completed','1:2:5:4','COMPLETED'),/CLAIM_CHANGED/)
      await a.recordNativeStopped('completed','1:2:5:4')
      await a.recordRotation('completed','1:2:5:4','COMPLETED')
      assert.deepEqual(await a.readRotation('completed','1:2:5:4'),{revision:'1:2:5:4',state:'COMPLETED'})
      await assert.rejects(a.recordRotation('completed','1:2:5:4','STARTED'),/ALREADY_ATTEMPTED/)
    })
  } finally {await pool.end()}
})
