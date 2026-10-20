import type {ManagedCodexAuthControl} from './managed-codex-auth-refresh.ts'
import type {AgentCodexControlPolicy} from './agent-codex-control.ts'
import type {ManagedCodexCredential} from '../providers/codex/managed-credential-owner.ts'
import type {ManagedCodexAccess} from '../providers/codex/managed-access-broker.ts'
export const AGENT_EXTERNAL_AUTH_CAPABILITY='account-owned-codex-auth-v1'
export const AGENT_EXTERNAL_AUTH_REQUEST='CODEX_ACCESS_REQUEST'
export const AGENT_EXTERNAL_AUTH_SUPPLY='SUPPLY_CODEX_ACCESS'
export const AGENT_EXTERNAL_AUTH_STATUS='CHECK_CODEX_EXTERNAL_AUTH'
export type ManagedCodexAccessReader=(rejected?:Readonly<{revision:string;chatgptAccountId:string}>,current?:()=>boolean)=>Promise<ManagedCodexAccess>
const fail=()=>new Error('AGENT_EXTERNAL_AUTH_UNCONFIRMED')
export function captureManagedCodexAccess(value:unknown):ManagedCodexAccess {
  if(!value||typeof value!=='object'||Array.isArray(value)) {throw fail()}
  const x=value as Record<string,unknown>
  if(Object.keys(x).some(k=>!['accountId','revision','accessToken','chatgptAccountId','expiresAt'].includes(k))||
    !(x.accountId===null||typeof x.accountId==='string'&&x.accountId.length>0&&x.accountId.length<256)||
    typeof x.revision!=='string'||!/^\d+:\d+:\d+:\d+$/.test(x.revision)||
    typeof x.accessToken!=='string'||!x.accessToken||x.accessToken.length>65536||
    typeof x.chatgptAccountId!=='string'||!x.chatgptAccountId||x.chatgptAccountId.length>256||
    !Number.isSafeInteger(x.expiresAt)||Number(x.expiresAt)<=0) {throw fail()}
  return Object.freeze({...x}) as ManagedCodexAccess
}
/** Requests contain no token. Supplies arrive on the authenticated private
 * input channel and are resolved outside the control's serial native queue. */
export function createAgentExternalAuthBridge(send:(event:Record<string,unknown>)=>void,now=Date.now) {
  let next=0,closed=false
  const pending=new Map<string,{resolve(value:ManagedCodexAccess):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>()
  return Object.freeze({
    read:((rejected)=>{
      if(closed) {return Promise.reject(fail())}
      const requestId=String(++next)
      return new Promise<ManagedCodexAccess>((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(requestId);reject(fail())},8000)
        pending.set(requestId,{resolve,reject,timer})
        try {send({event:AGENT_EXTERNAL_AUTH_REQUEST,requestId,deadlineAt:now()+8000,...(rejected?{rejected}:{})})}
        catch {clearTimeout(timer);pending.delete(requestId);reject(fail())}
      })
    }) satisfies ManagedCodexAccessReader,
    supply(value:unknown):boolean {
      if(!value||typeof value!=='object'||Array.isArray(value)) {throw fail()}
      const x=value as Record<string,unknown>
      if(typeof x.requestId!=='string'||Object.keys(x).some(k=>!['requestId','access','unavailable'].includes(k))) {throw fail()}
      const waiter=pending.get(x.requestId)
      if(!waiter) {return false}
      clearTimeout(waiter.timer);pending.delete(x.requestId)
      try {if(x.unavailable===true) {throw fail()};waiter.resolve(captureManagedCodexAccess(x.access))}
      catch {waiter.reject(fail())}
      return true
    },
    close():void {closed=true;for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(fail())};pending.clear()}
  })
}
/** Backend starts this without blocking frame delivery: native COLD is waiting
 * for the reply, so awaiting the RPC ACK on the frame queue would deadlock. */
export async function supplyAgentExternalAuth(event:Record<string,unknown>,read:ManagedCodexAccessReader,
  current:()=>boolean,reply:(params:Record<string,unknown>)=>Promise<unknown>,now=Date.now):Promise<void> {
  const requestId=event.requestId,deadline=event.deadlineAt
  if(typeof requestId!=='string'||!/^\d+$/.test(requestId)||!Number.isSafeInteger(deadline)) {throw fail()}
  if(!current()) {return}
  let access:ManagedCodexAccess|undefined
  try {
    if(Number(deadline)<=now()||Number(deadline)>now()+10000) {throw fail()}
    const rejected=event.rejected
    if(rejected!==undefined&&(!rejected||typeof rejected!=='object'||Array.isArray(rejected)||
      Object.keys(rejected).some(k=>!['revision','chatgptAccountId'].includes(k))||
      typeof Reflect.get(rejected,'revision')!=='string'||!/^\d+:\d+:\d+:\d+$/.test(Reflect.get(rejected,'revision'))||
      typeof Reflect.get(rejected,'chatgptAccountId')!=='string')) {throw fail()}
    access=captureManagedCodexAccess(await read(rejected as Parameters<ManagedCodexAccessReader>[0],()=>current()&&Number(deadline)>now()))
  }catch{/* No token/provider error details cross the protocol. */}
  if(!current()) {return}
  if(Number(deadline)<=now()) {access=undefined}
  await reply({requestId,...(access?{access}:{unavailable:true})})
}

export function externalAgentAuthControl(enabled:boolean,capable:()=>boolean,current:()=>boolean,
  request:(method:string,params?:Record<string,unknown>,timeoutMs?:number)=>Promise<unknown>,
  legacy:ManagedCodexAuthControl):ManagedCodexAuthControl {
  if(!enabled) {return legacy}
  return Object.freeze({async refreshManagedAuth(){
    if(!capable()||!current()) {return {state:'FAILED' as const,code:'REFRESH_UNCONFIRMED' as const}}
    try {const status=await request(AGENT_EXTERNAL_AUTH_STATUS,undefined,8000)
      if(status&&typeof status==='object'&&Reflect.get(status,'ready')===true) {return {state:'COMPLETED' as const,authMode:'chatgpt' as const}}
    }catch{/* Keep provider errors private. */}
    return {state:'FAILED' as const,code:'REFRESH_UNCONFIRMED' as const}
  }})
}
export function externalAuthCapable(value:unknown):boolean {
  return Array.isArray(value)&&value.includes(AGENT_EXTERNAL_AUTH_CAPABILITY)
}

export function initializeAgentAuthPolicy(policy:AgentCodexControlPolicy,external:boolean,read?:()=>ManagedCodexCredential):AgentCodexControlPolicy {
  if(policy.provider==='claude') {return policy}
  if(external) {return {...policy,codexAuth:'',managedCredential:undefined,externalAuth:true}}
  const source=read?.()
  return source?{...policy,codexAuth:source.authJson,managedCredential:source}:policy
}
export function dispatchAgentExternalAuth(record:Record<string,unknown>,controlId:string,capable:boolean,
  read:ManagedCodexAccessReader|undefined,current:()=>boolean,reply:(params:Record<string,unknown>)=>Promise<unknown>):boolean {
  if(record.event!==AGENT_EXTERNAL_AUTH_REQUEST) {return false}
  if(!capable||!read||record.controlId!==controlId) {throw fail()}
  void supplyAgentExternalAuth(record,read,current,reply).catch(()=>{})
  return true
}
