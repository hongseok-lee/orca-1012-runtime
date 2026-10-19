import type { ManagedCodexCredential } from '../providers/codex/managed-credential-owner.ts'
import type { CodexAppServerConnection } from '../../codex/codex-app-server-connection-types.ts'

export const MANAGED_CODEX_AUTH_REFRESH_CAPABILITY='managed-codex-auth-refresh-v2'
export const MANAGED_CODEX_AUTH_REFRESH_METHOD='REFRESH_CODEX_MANAGED_AUTH'
/** Pinned installed0.160.1 GetAccountParams, not an external-token login. */
export type ManagedCodexAccountRefreshParams=Readonly<{refreshToken:true}>
export type ManagedCodexAuthRefresh = Readonly<
  {state:'COMPLETED';authMode:'chatgpt'} |
  {state:'FAILED';code:'TOKEN_REVOKED'|'REFRESH_TOKEN_REUSED'|'REFRESH_TOKEN_EXPIRED'|'MANAGED_AUTH_REQUIRED'|'REFRESH_UNCONFIRMED'|'CREDENTIAL_OWNER_UNAVAILABLE'|'ACCOUNT_SELECTION_MISMATCH'} |
  {state:'UNAVAILABLE';reason:'HOST_CAPABILITY_MISSING'}>
export type ManagedCodexAuthControl=Readonly<{refreshManagedAuth():Promise<ManagedCodexAuthRefresh>}>
const failure=(code:'MANAGED_AUTH_REQUIRED'|'REFRESH_UNCONFIRMED'):ManagedCodexAuthRefresh=>({state:'FAILED',code})
/** Agent-side only: use the resident connection's official refresh operation.
 * No auth file, account selection, token-bearing RPC or input replay is owned here.
 * Completion means the managed refresh RPC completed, not inference access proof. */
export async function refreshResidentManagedCodexAuth(connection:Pick<CodexAppServerConnection,'request'>,expectedEmail?:string):Promise<ManagedCodexAuthRefresh> {
  try {
    const params:ManagedCodexAccountRefreshParams={refreshToken:true}
    const value=await connection.request('account/read',params,{timeoutMs:15_000})
    if(!value || typeof value!=='object' || Reflect.get(value,'requiresOpenaiAuth')!==true) {return failure('REFRESH_UNCONFIRMED')}
    const account=Reflect.get(value,'account')
    if(!account || typeof account!=='object' || Reflect.get(account,'type')!=='chatgpt') {return failure('MANAGED_AUTH_REQUIRED')}
    if(expectedEmail&&String(Reflect.get(account,'email')).trim().toLowerCase()!==expectedEmail.trim().toLowerCase()) {return {state:'FAILED',code:'ACCOUNT_SELECTION_MISMATCH'}}
    return {state:'COMPLETED',authMode:'chatgpt'}
  } catch(error) {
    const message=error instanceof Error?error.message:''
    const code=message.includes('token_revoked')?'TOKEN_REVOKED':message.includes('refresh_token_reused')?'REFRESH_TOKEN_REUSED':
      message.includes('refresh_token_expired')?'REFRESH_TOKEN_EXPIRED':'REFRESH_UNCONFIRMED'
    return {state:'FAILED',code}
  }
}
export function managedCodexAuthRefreshSupported(capabilities:unknown):boolean {
  return Array.isArray(capabilities)&&capabilities.includes(MANAGED_CODEX_AUTH_REFRESH_CAPABILITY)
}
/** Backend side: old hosts are explicit and receive no unsupported request. */
export function managedCodexAuthControl(supported:()=>boolean,valid:()=>boolean,
  request:(method:string,params?:unknown)=>Promise<unknown>,readCredential?:()=>ManagedCodexCredential):ManagedCodexAuthControl {
  return Object.freeze({async refreshManagedAuth() {
    if(!supported()) {return {state:'UNAVAILABLE',reason:'HOST_CAPABILITY_MISSING'} as const}
    if(!valid()) {return failure('REFRESH_UNCONFIRMED')}
    try {
      let params:unknown
      try {if(!readCredential) {return {state:'FAILED',code:'CREDENTIAL_OWNER_UNAVAILABLE'} as const};params={credential:readCredential()}}catch{return {state:'FAILED',code:'CREDENTIAL_OWNER_UNAVAILABLE'} as const}
      const result=await request(MANAGED_CODEX_AUTH_REFRESH_METHOD,params)
      if(result && typeof result==='object') {
        if(Reflect.get(result,'state')==='COMPLETED'&&Reflect.get(result,'authMode')==='chatgpt') {return {state:'COMPLETED',authMode:'chatgpt'} as const}
        const code=Reflect.get(result,'code')
        if(Reflect.get(result,'state')==='FAILED'&&['TOKEN_REVOKED','REFRESH_TOKEN_REUSED','REFRESH_TOKEN_EXPIRED','MANAGED_AUTH_REQUIRED','REFRESH_UNCONFIRMED','CREDENTIAL_OWNER_UNAVAILABLE','ACCOUNT_SELECTION_MISMATCH'].includes(code)) {
          return {state:'FAILED',code} as ManagedCodexAuthRefresh
        }
      }
      return failure('REFRESH_UNCONFIRMED')
    } catch {return failure('REFRESH_UNCONFIRMED')}
  }})
}
/** One runtime owner's observation, separate from native input admission.
 * Failed refresh blocks future dispatch while the healthy host/in-flight turn stays owned. */
export class ManagedCodexAuthRefreshState {
  private latest:ManagedCodexAuthRefresh|null=null
  constructor(private readonly observe:(value:ManagedCodexAuthRefresh)=>void) {}
  async refresh(control:ManagedCodexAuthControl):Promise<ManagedCodexAuthRefresh> {
    const result=await control.refreshManagedAuth();this.latest=result;this.observe(result);return result
  }
  snapshot():ManagedCodexAuthRefresh|null {return this.latest}
  assertDispatchAllowed():void {
    if(this.latest?.state==='FAILED') {throw new Error(`AGENT_MANAGED_AUTH_${this.latest.code}`)}
  }
}
/** The resident host retains the outcome for an unchanged supplied credential.
 * Backend polling/restart does not become another OAuth retry. Bytes stay private
 * in memory only; no token digest, credential log or parallel retry budget exists. */
export function createResidentManagedCodexAuthRefresh(connection:()=>Pick<CodexAppServerConnection,'request'>|null,
  readSuppliedAuth:()=>string,expectedEmail?:()=>string|undefined):()=>Promise<ManagedCodexAuthRefresh> {
  let prior:string|null=null,result:ManagedCodexAuthRefresh|null=null
  return async()=>{
    try {
      const supplied=readSuppliedAuth(),native=connection()
      if(!native) {return failure('REFRESH_UNCONFIRMED')}
      if(result && supplied===prior) {return result}
      result=await refreshResidentManagedCodexAuth(native,expectedEmail?.())
      prior=result.state==='COMPLETED'?readSuppliedAuth():supplied
      return result
    } catch {return failure('REFRESH_UNCONFIRMED')}
  }
}
/** Private source-owner supply only. No public token/login/RPC substitution. */
export async function handleManagedCodexAuthRefresh(input:Readonly<{provider:string;phase:string;
  connection:Pick<CodexAppServerConnection,'request'>|null;params:unknown;refresh?:()=>Promise<ManagedCodexAuthRefresh>;
  applyCredential?:(value:unknown)=>void}>):Promise<ManagedCodexAuthRefresh> {
  if(input.provider!=='codex'||input.phase!=='READY'||!input.connection) {return failure('REFRESH_UNCONFIRMED')}
  if(input.params!==undefined) {
    if(!input.params||typeof input.params!=='object'||Array.isArray(input.params)||
      Object.keys(input.params).length!==1||!Object.hasOwn(input.params,'credential')||!input.applyCredential) {return failure('REFRESH_UNCONFIRMED')}
    try{input.applyCredential(Reflect.get(input.params,'credential'))}catch{return failure('REFRESH_UNCONFIRMED')}
  }
  return input.refresh?input.refresh():refreshResidentManagedCodexAuth(input.connection)
}
