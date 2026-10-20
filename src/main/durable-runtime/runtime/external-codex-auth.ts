import type {CodexAppServerConnection, CodexAppServerServerRequest} from '../../codex/codex-app-server-connection-types.ts'
import type {ManagedCodexAccess} from '../providers/codex/managed-access-broker.ts'

const refreshMethod='account/chatgptAuthTokens/refresh'
const failure=()=>new Error('CODEX_EXTERNAL_AUTH_UNCONFIRMED')
/** Pod-local private auth channel. The backend owns renewal; this process never
 * receives an OAuth refresh token and never persists a token-bearing event. */
export function createExternalCodexAuth(input:Readonly<{
  connection():CodexAppServerConnection|null
  readAccess(rejected?:Readonly<{revision:string;chatgptAccountId:string}>):Promise<ManagedCodexAccess>
  now?():number
}>) {
  let installed:ManagedCodexAccess|null=null, initializationStarted=false
  const pending=new Set<string>()
  const now=input.now??Date.now
  function check(access:ManagedCodexAccess) {
    if(!access.accessToken||!access.chatgptAccountId||access.expiresAt<=now()+1000 ||
      installed&&(installed.accountId!==access.accountId||installed.chatgptAccountId!==access.chatgptAccountId)) {throw failure()}
  }
  const tokens=(access:ManagedCodexAccess)=>({accessToken:access.accessToken,chatgptAccountId:access.chatgptAccountId})
  return Object.freeze({
    ready:()=>installed!==null,
    async initialize():Promise<void> {
      if(initializationStarted) {throw failure()}
      initializationStarted=true
      const connection=input.connection()
      if(!connection||connection.closed) {throw failure()}
      try {
        const access=await input.readAccess();check(access)
        const result=await connection.request('account/login/start',{type:'chatgptAuthTokens',...tokens(access)},{timeoutMs:8000})
        if(input.connection()!==connection||connection.closed||!result||typeof result!=='object'||Reflect.get(result,'type')!=='chatgptAuthTokens') {throw failure()}
        installed=access
      }catch{throw failure()}
    },
    /** Returns false for unrelated requests so the original prompt owner keeps them. */
    handle(request:CodexAppServerServerRequest):boolean {
      if(request.method!==refreshMethod) {return false}
      const connection=input.connection(),prior=installed,id=JSON.stringify(request.id)
      if(pending.has(id)) {return true}
      const params=request.params
      if(!connection||connection.closed) {return true}
      if(!prior||!params||typeof params!=='object'||Reflect.get(params,'reason')!=='unauthorized'||
        Reflect.get(params,'previousAccountId')!==prior.chatgptAccountId) {
        connection.respondWithError(request.id,-32001,'Selected account refresh unavailable');return true
      }
      pending.add(id)
      void (async()=>{
        try {
          let timer:ReturnType<typeof setTimeout>|undefined
          let access:ManagedCodexAccess
          try {access=await Promise.race([input.readAccess({revision:prior.revision,chatgptAccountId:prior.chatgptAccountId}),
            new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(failure()),8000)})])}
          finally {clearTimeout(timer)}
          check(access)
          if(input.connection()!==connection||connection.closed) {return}
          connection.respond(request.id,tokens(access));installed=access
        }catch{
          if(input.connection()===connection&&!connection.closed) {connection.respondWithError(request.id,-32001,'Selected account refresh unavailable')}
        }finally{pending.delete(id)}
      })()
      return true
    }
  })
}
