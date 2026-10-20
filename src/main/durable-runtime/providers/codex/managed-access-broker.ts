import type {ManagedCodexCredential, ManagedCodexCredentialReader} from './managed-credential-owner.ts'

/** Private wire value: deliberately excludes refresh/id tokens and auth.json. */
export type ManagedCodexAccess = Readonly<{
  accountId: string | null
  revision: string
  accessToken: string
  chatgptAccountId: string
  expiresAt: number
}>
const fail=(code:string):never=>{throw new Error(`CODEX_ACCESS_${code}`)}
/** The already authenticated selected credential owner supplies this file.
 * JWT decoding reads expiry/account claims; it does not authenticate arbitrary callers. */
export function selectedManagedCodexAccess(source:ManagedCodexCredential):ManagedCodexAccess {
  try {
    const auth=JSON.parse(source.authJson),token=auth.tokens?.access_token,account=auth.tokens?.account_id
    if(auth.auth_mode!=='chatgpt'||typeof token!=='string'||typeof account!=='string'||!account.trim()||account.trim()!==account) {return fail('SOURCE')}
    const parts=token.split('.')
    if(parts.length!==3||!parts.every((part:string)=>/^[A-Za-z0-9_-]+$/.test(part))) {return fail('SOURCE')}
    const claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'))
    const accountClaim=claims['https://api.openai.com/auth']?.chatgpt_account_id
    if(accountClaim!==undefined&&accountClaim!==account) {return fail('ACCOUNT_MISMATCH')}
    if(!Number.isSafeInteger(claims.exp)||claims.exp<=0) {return fail('EXPIRY')}
    return Object.freeze({accountId:source.accountId,revision:source.revision,accessToken:token,
      chatgptAccountId:account,expiresAt:claims.exp*1000})
  } catch(error) {
    // Neither malformed JSON nor a provider error may echo token bytes.
    if(error instanceof Error&&/^CODEX_ACCESS_[A-Z_]+$/.test(error.message)) {throw error}
    return fail('SOURCE')
  }
}

/** Source-owner renewal, shared across Agents. The caller supplies its account
 * lock and a refresh operation on the ORIGINAL account home, never an Agent copy.
 * A lost/failed rotation is retained for that revision; no polling OAuth retries.
 * All hooks are private server composition, not public RPC arguments. */
export function createManagedCodexAccessBroker(input:Readonly<{
  read:ManagedCodexCredentialReader
  withAccountLock<T>(accountId:string|null,body:()=>Promise<T>):Promise<T>
  refreshSource(agentId:string,source:ManagedCodexCredential):Promise<void>
  /** Durable under the same account lock; STARTED survives owner loss. */
  readRotation(accountId:string|null):Promise<Readonly<{revision:string;state:'STARTED'|'COMPLETED'}>|null>
  recordRotation(accountId:string|null,revision:string,state:'STARTED'|'COMPLETED'):Promise<void>
  now?():number
}>) {
  const now=input.now??Date.now
  const inFlight=new Map<string,Promise<ManagedCodexAccess>>()
  const usable=(access:ManagedCodexAccess)=>access.expiresAt>now()+60_000
  const key=(accountId:string|null)=>JSON.stringify(['account',accountId])
  return Object.freeze({async read(agentId:string, rejected?:Readonly<{revision:string;chatgptAccountId:string}>):Promise<ManagedCodexAccess> {
    const original=input.read(agentId,false),initial=selectedManagedCodexAccess(original),owner=key(original.accountId)
    if(rejected&&rejected.chatgptAccountId!==initial.chatgptAccountId) {return fail('ACCOUNT_MISMATCH')}
    const assertOwner=(access:ManagedCodexAccess)=>{
      const current=selectedManagedCodexAccess(input.read(agentId,false))
      if(current.accountId!==initial.accountId||current.chatgptAccountId!==initial.chatgptAccountId||
          access.accountId!==current.accountId||access.chatgptAccountId!==current.chatgptAccountId) {return fail('OWNER_CHANGED')}
      if(current.revision!==access.revision) {return fail('SOURCE_CHANGED')}
      if(!usable(access)) {return fail('EXPIRED')}
      return access
    }
    if(usable(initial)&&(!rejected||rejected.revision!==initial.revision)) {return assertOwner(initial)}
    const pending=inFlight.get(owner)
    if(pending) {return assertOwner(await pending)}
    const renewal=input.withAccountLock(original.accountId,async()=>{
      const source=input.read(agentId,false),access=selectedManagedCodexAccess(source)
      if(source.accountId!==original.accountId||access.chatgptAccountId!==initial.chatgptAccountId) {return fail('OWNER_CHANGED')}
      if(source.revision!==original.revision&&usable(access)) {return access}
      const prior=await input.readRotation(source.accountId)
      if(prior?.revision===source.revision&&prior.state==='STARTED') {return fail('REFRESH_UNCONFIRMED')}
      // Set before I/O: even a timeout must not consume the same rotating token twice.
      await input.recordRotation(source.accountId,source.revision,'STARTED')
      try {await input.refreshSource(agentId,source)}catch{return fail('REFRESH_UNCONFIRMED')}
      const refreshed=selectedManagedCodexAccess(input.read(agentId,false))
      if(refreshed.accountId!==initial.accountId||refreshed.chatgptAccountId!==initial.chatgptAccountId) {return fail('OWNER_CHANGED')}
      if(refreshed.revision===source.revision||!usable(refreshed)) {return fail('REFRESH_UNCONFIRMED')}
      await input.recordRotation(source.accountId,source.revision,'COMPLETED')
      return refreshed
    })
    inFlight.set(owner,renewal)
    try {return assertOwner(await renewal)}finally{if(inFlight.get(owner)===renewal) {inFlight.delete(owner)}}
  }})
}
