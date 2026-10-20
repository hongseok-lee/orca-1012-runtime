import type {CodexAppServerConnection} from '../../../codex/codex-app-server-connection-types.ts'
import {CodexAppServerHandshakeExitUnprovenError} from '../../../codex/codex-app-server-handshake-exit-proof.ts'
import type {ManagedCodexCredential,ManagedCodexCredentialReader} from './managed-credential-owner.ts'
const fail=(code:string)=>new Error(`CODEX_ACCOUNT_SOURCE_${code}`)
/** Runs only under the broker's committed rotation claim and account lock.
 * The native process opens the ORIGINAL selected account home and owns its
 * normal token-file update. No copy/import/handwritten OAuth endpoint is used. */
export function createManagedAccountSourceRefresh(input:Readonly<{
  read:ManagedCodexCredentialReader
  open(codexHome:string):Promise<CodexAppServerConnection>
  assertCurrent():void
}>) {
  return async(agentId:string,expected:ManagedCodexCredential,onStopped:()=>Promise<void>):Promise<void>=>{
    input.assertCurrent()
    if(!input.read.sourceHome) {throw fail('OWNER_UNAVAILABLE')}
    const home=input.read.sourceHome(agentId,expected)
    let connection:CodexAppServerConnection|null=null,failureCode:string|null=null,stopped=false
    try {
      connection=await input.open(home)
      input.assertCurrent()
      const current=input.read(agentId,false)
      if(current.accountId!==expected.accountId||input.read.sourceHome(agentId,current)!==home) {throw fail('OWNER_CHANGED')}
      const result=await connection.request('account/read',{refreshToken:true},{timeoutMs:6000})
      const object=result&&typeof result==='object'?result:null
      const account=object?Reflect.get(object,'account'):null
      if(!object||!account||typeof account!=='object'||Reflect.get(account,'type')!=='chatgpt'||Reflect.get(object,'requiresOpenaiAuth')!==true) {throw fail('REFRESH_REJECTED')}
      if(expected.expectedEmail&&String(Reflect.get(account,'email')).trim().toLowerCase()!==expected.expectedEmail.trim().toLowerCase()) {throw fail('OWNER_CHANGED')}
      input.assertCurrent()
      const after=input.read(agentId,false)
      if(after.accountId!==expected.accountId||input.read.sourceHome(agentId,after)!==home||after.revision===expected.revision) {throw fail('REFRESH_UNCONFIRMED')}
    } catch(error) {
      if(error instanceof CodexAppServerHandshakeExitUnprovenError) {connection=error.connection}
      // Native errors can contain token/server response data; expose one bounded code.
      failureCode='REFRESH_UNCONFIRMED'
    } finally {
      try {stopped=connection!==null&&await connection.close()}catch{/* Preserve the durable STARTED claim. */}
      if(!stopped) {failureCode='STOP_UNCONFIRMED'}
    }
    if(stopped) {await onStopped()}
    if(failureCode) {throw fail(failureCode)}
    input.assertCurrent()
  }
}
