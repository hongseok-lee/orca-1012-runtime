import {AsyncLocalStorage} from 'node:async_hooks'
import type {Pool} from 'pg'
import type {CodexAppServerConnection} from '../../../codex/codex-app-server-connection-types.ts'
import type {ManagedCodexCredentialReader} from './managed-credential-owner.ts'
import {createManagedCodexAccessBroker} from './managed-access-broker.ts'
import {createManagedAccountRotationStore} from './managed-account-rotation-store.ts'
import {createManagedAccountSourceRefresh} from './managed-account-source-refresh.ts'

/** One instance per backend account service, shared by every Agent. The scope
 * identifies the same account source across active/standby servers. */
export function createManagedAccountAccess(input:Readonly<{
  pool:Pool;scope:string;read:ManagedCodexCredentialReader
  openSource(codexHome:string,assertCurrent:()=>void):Promise<CodexAppServerConnection>
}>) {
  const requestOwner=new AsyncLocalStorage<()=>boolean>()
  const assertCurrent=()=>{
    if(requestOwner.getStore()?.()!==true) {throw new Error('CODEX_ACCOUNT_REQUEST_OWNER_LOST')}
  }
  const rotations=createManagedAccountRotationStore(input.pool,input.scope,assertCurrent)
  const refreshSource=createManagedAccountSourceRefresh({read:input.read,open:home=>input.openSource(home,assertCurrent),assertCurrent})
  const broker=createManagedCodexAccessBroker({read:input.read,...rotations,refreshSource})
  return Object.freeze({async read(agentId:string,rejected:Parameters<typeof broker.read>[1],current:()=>boolean){
    return requestOwner.run(current,async()=>{
      assertCurrent()
      const access=await broker.read(agentId,rejected)
      assertCurrent()
      return access
    })
  }})
}
