import {AsyncLocalStorage} from 'node:async_hooks'
import {randomUUID} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'

type Rotation={revision:string;state:'STARTED'|'COMPLETED'}
type Held={accountKey:string;client:PoolClient;lost:boolean;claims:Map<string,string>}
const failure=(suffix:string)=>new Error(`CODEX_ACCOUNT_ROTATION_${suffix}`)
/** A dedicated PG connection holds the account advisory lock while each STARTED
 * marker is committed before OAuth I/O. Never wrap the marker in a transaction
 * that would roll back when a process dies. Old revision claims are retained. */
export function createManagedAccountRotationStore(pool:Pool,scope:string,assertCurrent:()=>void) {
  if(!scope||scope.length>512) {throw failure('SCOPE')}
  const context=new AsyncLocalStorage<Held>()
  const accountKey=(accountId:string|null)=>{
    if(accountId!==null&&(typeof accountId!=='string'||!accountId||accountId.length>256)) {throw failure('ACCOUNT')}
    return JSON.stringify(['account',accountId])
  }
  const held=(accountId:string|null,requireCurrent=true)=>{
    if(requireCurrent) {assertCurrent()}
    const owner=context.getStore()
    if(!owner||owner.lost||owner.accountKey!==accountKey(accountId)) {throw failure('LOCK_REQUIRED')}
    return owner
  }
  const revision=(value:string)=>{if(!/^\d+:\d+:\d+:\d+$/.test(value)||value.length>256) {throw failure('REVISION')};return value}
  return Object.freeze({
    async withAccountLock<T>(accountId:string|null,body:()=>Promise<T>):Promise<T> {
      assertCurrent()
      if(context.getStore()) {throw failure('NESTED_LOCK')}
      const key=accountKey(accountId),client=await pool.connect()
      const owner:Held={accountKey:key,client,lost:false,claims:new Map()}
      const error=()=>{owner.lost=true}
      client.on('error',error)
      let locked=false,destroy=false
      const lockName=JSON.stringify(['orca-codex-account-rotation',scope,key])
      try {
        // No unbounded wait behind a crashed or still-running OAuth owner.
        const result=await client.query<{locked:boolean}>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[lockName])
        locked=result.rows[0]?.locked===true
        if(!locked) {throw failure('BUSY')}
        assertCurrent();if(owner.lost) {throw failure('OWNER_LOST')}
        return await context.run(owner,async()=>{
          const value=await body();held(accountId);return value
        })
      } catch(error) {
        destroy=true
        throw error
      } finally {
        // A connection with uncertain lock state must never return to the pool.
        if(locked&&!owner.lost) {
          try {const result=await client.query<{unlocked:boolean}>('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked',[lockName]);if(result.rows[0]?.unlocked!==true) {destroy=true}}
          catch{destroy=true}
        }
        destroy ||= owner.lost
        owner.lost=true;client.removeListener('error',error);client.release(destroy)
      }
    },
    async readRotation(accountId:string|null,sourceRevision:string):Promise<Rotation|null> {
      const owner=held(accountId)
      const result=await owner.client.query<Rotation>(`SELECT source_revision AS revision,state
        FROM durable_runtime.managed_codex_account_rotations WHERE scope=$1 AND account_key=$2 AND source_revision=$3`,
      [scope,owner.accountKey,revision(sourceRevision)])
      held(accountId);return result.rows[0]??null
    },
    // Cleanup proof survives requester expiry; only the original live PG claim may record it.
    async recordNativeStopped(accountId:string|null,sourceRevision:string):Promise<void> {
      const owner=held(accountId,false),source=revision(sourceRevision),claim=owner.claims.get(source)
      if(!claim) {throw failure('CLAIM_REQUIRED')}
      const result=await owner.client.query(`UPDATE durable_runtime.managed_codex_account_rotations
        SET native_stopped_at=COALESCE(native_stopped_at,clock_timestamp())
        WHERE scope=$1 AND account_key=$2 AND source_revision=$3 AND claim_id=$4 AND state='STARTED'`,
      [scope,owner.accountKey,source,claim])
      held(accountId,false);if(result.rowCount!==1) {throw failure('CLAIM_CHANGED')}
    },
    async recordRotation(accountId:string|null,sourceRevision:string,state:'STARTED'|'COMPLETED'):Promise<void> {
      const owner=held(accountId),source=revision(sourceRevision)
      if(state==='STARTED') {
        const unresolved=await owner.client.query(`SELECT 1 FROM durable_runtime.managed_codex_account_rotations
          WHERE scope=$1 AND account_key=$2 AND native_stopped_at IS NULL LIMIT 1`,[scope,owner.accountKey])
        held(accountId);if(unresolved.rowCount) {throw failure('NATIVE_STOP_UNCONFIRMED')}
        const claim=randomUUID()
        const result=await owner.client.query(`INSERT INTO durable_runtime.managed_codex_account_rotations
          (scope,account_key,source_revision,claim_id,state) VALUES($1,$2,$3,$4,'STARTED')
          ON CONFLICT DO NOTHING RETURNING claim_id`,[scope,owner.accountKey,source,claim])
        held(accountId)
        if(result.rowCount!==1) {throw failure('ALREADY_ATTEMPTED')}
        owner.claims.set(source,claim)
      } else {
        const claim=owner.claims.get(source)
        if(!claim) {throw failure('CLAIM_REQUIRED')}
        const result=await owner.client.query(`UPDATE durable_runtime.managed_codex_account_rotations
          SET state='COMPLETED',completed_at=clock_timestamp()
          WHERE scope=$1 AND account_key=$2 AND source_revision=$3 AND claim_id=$4 AND state='STARTED' AND native_stopped_at IS NOT NULL`,
        [scope,owner.accountKey,source,claim])
        held(accountId);if(result.rowCount!==1) {throw failure('CLAIM_CHANGED')}
        owner.claims.delete(source)
      }
    }
  })
}
