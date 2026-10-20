import type {Pool} from 'pg'
import type {CodexAppServerConnection} from '../../../codex/codex-app-server-connection-types.ts'
import type {ManagedCodexCredentialReader} from './managed-credential-owner.ts'
import {createManagedCodexAccessBroker} from './managed-access-broker.ts'
import {createManagedAccountRotationStore} from './managed-account-rotation-store.ts'
import {createManagedAccountSourceRefresh} from './managed-account-source-refresh.ts'

/** One instance per backend account service, shared by every Agent. The scope
 * identifies the same account source across active/standby servers. */
export function createManagedAccountAccess(input:Readonly<{
  pool:Pool;scope:string;read:ManagedCodexCredentialReader;assertCurrent():void
  openSource(codexHome:string):Promise<CodexAppServerConnection>
}>) {
  const rotations=createManagedAccountRotationStore(input.pool,input.scope,input.assertCurrent)
  const refreshSource=createManagedAccountSourceRefresh({read:input.read,open:input.openSource,assertCurrent:input.assertCurrent})
  return createManagedCodexAccessBroker({read:input.read,...rotations,refreshSource})
}
