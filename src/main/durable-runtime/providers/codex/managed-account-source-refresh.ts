import type {CodexAppServerConnection} from '../../../codex/codex-app-server-connection-types.ts'
import {CodexAppServerHandshakeExitUnprovenError} from '../../../codex/codex-app-server-handshake-exit-proof.ts'
import type {ManagedCodexCredential,ManagedCodexCredentialReader} from './managed-credential-owner.ts'
const fail=(code:string)=>new Error(`CODEX_ACCOUNT_SOURCE_${code}`)
export type AccountSourceFailure=Readonly<{
  stage:'OPEN'|'OWNER_CHECK'|'REFRESH'|'SOURCE_CHECK'
  category:'TIMEOUT'|'NATIVE_REFUSAL'|'OWNER_OR_SOURCE_CHANGED'|'LOCAL_OR_TRANSPORT'
  nativeCode:number|null
  elapsedMs:number
  nativeStopped:boolean
}>
/** Runs only under the broker's committed rotation claim and account lock.
 * The native process opens the ORIGINAL selected account home and owns its
 * normal token-file update. No copy/import/handwritten OAuth endpoint is used. */
export function createManagedAccountSourceRefresh(input:Readonly<{
  read:ManagedCodexCredentialReader
  open(codexHome:string):Promise<CodexAppServerConnection>
  assertCurrent():void
  onFailure?(failure:AccountSourceFailure):void
}>) {
  return async(agentId:string,expected:ManagedCodexCredential,onStopped:()=>Promise<void>):Promise<void>=>{
    input.assertCurrent()
    if(!input.read.sourceHome) {throw fail('OWNER_UNAVAILABLE')}
    const home=input.read.sourceHome(agentId,expected)
    let connection:CodexAppServerConnection|null=null,failureCode:string|null=null,stopped=false
    const started=Date.now()
    let stage:AccountSourceFailure['stage']='OPEN',diagnostic:Omit<AccountSourceFailure,'nativeStopped'>|undefined
    try {
      connection=await input.open(home)
      stage='OWNER_CHECK'
      input.assertCurrent()
      const current=input.read(agentId,false)
      if(current.accountId!==expected.accountId||input.read.sourceHome(agentId,current)!==home) {throw fail('OWNER_CHANGED')}
      stage='REFRESH'
      const result=await connection.request('account/read',{refreshToken:true},{timeoutMs:6000})
      const object=result&&typeof result==='object'?result:null
      const account=object?Reflect.get(object,'account'):null
      if(!object||!account||typeof account!=='object'||Reflect.get(account,'type')!=='chatgpt'||Reflect.get(object,'requiresOpenaiAuth')!==true) {throw fail('REFRESH_REJECTED')}
      if(expected.expectedEmail&&String(Reflect.get(account,'email')).trim().toLowerCase()!==expected.expectedEmail.trim().toLowerCase()) {throw fail('OWNER_CHANGED')}
      stage='SOURCE_CHECK'
      input.assertCurrent()
      const after=input.read(agentId,false)
      if(after.accountId!==expected.accountId||input.read.sourceHome(agentId,after)!==home||after.revision===expected.revision) {throw fail('REFRESH_UNCONFIRMED')}
    } catch(error) {
      if(error instanceof CodexAppServerHandshakeExitUnprovenError) {connection=error.connection}
      // Native errors can contain token/server response data; expose one bounded code.
      failureCode='REFRESH_UNCONFIRMED'
      const name=error instanceof Error?error.name:''
      const local=error instanceof Error&&/^CODEX_(ACCOUNT|ACCESS)_[A-Z_]+$/.test(error.message)
      const code=name==='CodexAppServerRequestError'?Reflect.get(error as object,'code'):null
      diagnostic={stage,category:name==='CodexAppServerTimeoutError'?'TIMEOUT':
        name==='CodexAppServerRequestError'?'NATIVE_REFUSAL':local?'OWNER_OR_SOURCE_CHANGED':'LOCAL_OR_TRANSPORT',
        nativeCode:Number.isSafeInteger(code)?Number(code):null,elapsedMs:Date.now()-started}
    } finally {
      try {stopped=connection!==null&&await connection.close()}catch{/* Preserve the durable STARTED claim. */}
      if(!stopped) {failureCode='STOP_UNCONFIRMED'}
    }
    if(diagnostic) {
      try {input.onFailure?.(Object.freeze({...diagnostic,nativeStopped:stopped}))}catch{/* Reporting cannot alter the original outcome. */}
    }
    if(stopped) {await onStopped()}
    if(failureCode) {throw fail(failureCode)}
    input.assertCurrent()
  }
}
