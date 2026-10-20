import {prepareAccountNativeArtifact} from './orcad-account-native-artifact.ts'
import type {Pool} from 'pg'
import {openCodexAppServerConnection} from '../codex/codex-app-server-connection.ts'
import {createManagedAccountAccess} from '../durable-runtime/providers/codex/managed-account-access.ts'
import type {ManagedCodexCredentialReader} from '../durable-runtime/providers/codex/managed-credential-owner.ts'
import type {ManagedCodexAccessReader} from '../durable-runtime/runtime/agent-external-auth.ts'
import {parseUniqueOrcadControllerJson,readPrivateOrcadControllerConfigBytes,type OrcadControllerConfig} from './orcad-controller-config.ts'

type Service={read:ManagedCodexCredentialReader;access:ReturnType<typeof createManagedAccountAccess>;artifact:string}
const services=new WeakMap<Pool,Map<string,Service>>()
const fail=()=>new Error('CODEX_ACCOUNT_SERVICE_UNAVAILABLE')
/** One broker per account namespace, shared by cold and adopted Agents. Native
 * auth is opened lazily only under the PG rotation claim, on the original HOME. */
export function orcadManagedAccountAccess(pool:Pool,config:OrcadControllerConfig,read:ManagedCodexCredentialReader,agentId:string):ManagedCodexAccessReader {
  const file=config.firstManagedInitial?.coldConfigFile??config.rewake?.configFile
  if(!file||!read.sourceHome) {throw fail()}
  const raw=parseUniqueOrcadControllerJson(readPrivateOrcadControllerConfigBytes(file).toString('utf8'))
  if(!raw||typeof raw!=='object') {throw fail()}
  const source=Reflect.get(raw,'nativeArtifactFile'),sha=Reflect.get(raw,'nativeSha256'),size=Reflect.get(raw,'nativeByteLength')
  if(typeof source!=='string'||!source.startsWith('/')||typeof sha!=='string'||!/^[0-9a-f]{64}$/.test(sha)||!Number.isSafeInteger(size)||size<=0) {throw fail()}
  const artifact=JSON.stringify([source,sha,size]),scope=JSON.stringify([config.inventory.apiOrigin,config.inventory.namespace,config.inventory.dataset])
  let byScope=services.get(pool)
  if(!byScope) {byScope=new Map();services.set(pool,byScope)}
  let service=byScope.get(scope)
  if(service&&(service.read!==read||service.artifact!==artifact)) {throw fail()}
  if(!service) {
    // Begin read-only preparation with service creation, not after a refresh
    // claim commits inside the native callback's eight-second budget.
    const prepared=prepareAccountNativeArtifact(source,sha,size)
    void prepared.catch(()=>{}) // the opener below observes the original failure
    const access=createManagedAccountAccess({pool,scope,read,
      onSourceFailure:failure=>console.warn(JSON.stringify({event:'CODEX_ACCOUNT_SOURCE_FAILURE',...failure})),
      async openSource(codexHome,assertCurrent){
      assertCurrent()
      const executable=await prepared
      assertCurrent()
      return openCodexAppServerConnection({command:executable,args:['-c','cli_auth_credentials_store="file"','app-server'],cwd:codexHome,
        env:{CODEX_HOME:codexHome},envToDelete:['OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN']})
    }})
    service={read,access,artifact};byScope.set(scope,service)
  }
  const broker=service.access
  return (rejected,current)=>{if(!current) {return Promise.reject(fail())};return broker.read(agentId,rejected,current)}
}
