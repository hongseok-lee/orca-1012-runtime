import { constants,openSync,closeSync,fstatSync,readFileSync,lstatSync } from 'node:fs'
import {join,dirname} from 'node:path'
import {homedir} from 'node:os'
import type {GlobalSettings} from '../../../../shared/global-settings-types.ts'
import type {CodexPaneAccountRecord} from '../../../codex/codex-pane-account-registry-types.ts'
import {getSelectedCodexAccountIdForTarget} from '../../../codex-accounts/runtime-selection.ts'
import {readNodeCodexManagedAuth} from './managed-auth-source.ts'

export type ManagedCodexCredential = Readonly<{accountId:string|null;revision:string;authJson:string;expectedEmail?:string}>
export type ManagedCodexCredentialReader = ((agentId:string,captureSelection?:boolean)=>ManagedCodexCredential) & {
  /** Backend-only source location; never included in the Agent credential DTO. */
  sourceHome?(agentId:string,expected:ManagedCodexCredential):string
}
export type ManagedCodexAccountSettings=Pick<GlobalSettings,'codexManagedAccounts'|'activeCodexManagedAccountId'|'activeCodexManagedAccountIdsByRuntime'>
/** Adapter to the ORIGINAL Store account selection + persistent pane owner.
 * No deployment file map, account fallback on resume, token hash or new auth DB. */
export function createManagedCodexCredentialOwner(input:Readonly<{
  userDataPath:string;getSettings():ManagedCodexAccountSettings;
  readOwner(identity:string):CodexPaneAccountRecord|null;
  recordOwner(identity:string,record:CodexPaneAccountRecord):void;
}>) {
  const key=(agentId:string)=>{if(!/^[a-zA-Z0-9-]+$/.test(agentId)){throw new Error('CODEX_AGENT_IDENTITY')};return `durable-agent:${agentId}`}
  function select(agentId:string,accountId:string|null):void {
    const settings=input.getSettings()
    if(accountId!==null&&!settings.codexManagedAccounts.some(a=>a.id===accountId&&a.managedHomeRuntime!=='wsl')) {throw new Error('CODEX_ACCOUNT_OWNER_UNAVAILABLE')}
    const identity=key(agentId),record:CodexPaneAccountRecord={selectionKey:'host',accountId,homeRoute:accountId===null?'real-home':'account-home',lifetime:'durable-agent'}
    input.recordOwner(identity,record)
    const stored=input.readOwner(identity)
    if(stored?.accountId!==accountId||stored.lifetime!=='durable-agent') {throw new Error('CODEX_ACCOUNT_OWNER_NOT_DURABLE')}
  }
  const locations=new WeakMap<ManagedCodexCredential,string>()
  const read:ManagedCodexCredentialReader=(agentId,captureSelection=false)=>{
    let owner=input.readOwner(key(agentId))
    if(!owner&&captureSelection) {select(agentId,getSelectedCodexAccountIdForTarget(input.getSettings(),{runtime:'host'}));owner=input.readOwner(key(agentId))}
    if(!owner||owner.lifetime!=='durable-agent'||owner.selectionKey!=='host') {throw new Error('CODEX_ACCOUNT_OWNER_UNATTRIBUTED')}
    const settings=input.getSettings(),account=owner.accountId===null?null:settings.codexManagedAccounts.find(a=>a.id===owner!.accountId)
    if(owner.accountId!==null&&(!account||account.managedHomeRuntime==='wsl')) {throw new Error('CODEX_ACCOUNT_OWNER_UNAVAILABLE')}
    const file=join(account?.managedHomePath??join(homedir(),'.codex'),'auth.json')
    const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW)
    try {
      const before=fstatSync(fd,{bigint:true})
      if(!before.isFile()||before.uid!==BigInt(process.getuid!())||(before.mode&0o777n)!==0o600n||before.size>1048576n) {throw new Error('CODEX_ACCOUNT_AUTH_METADATA')}
      const authJson=account?readNodeCodexManagedAuth(input.userDataPath,{accountId:account.id,managedHomePath:account.managedHomePath}):readFileSync(fd,'utf8')
      const after=lstatSync(file,{bigint:true})
      if(before.dev!==after.dev||before.ino!==after.ino||before.mtimeNs!==after.mtimeNs||before.size!==after.size) {throw new Error('CODEX_ACCOUNT_AUTH_CHANGED')}
      if(input.readOwner(key(agentId))?.accountId!==owner.accountId) {throw new Error('CODEX_ACCOUNT_OWNER_CHANGED')}
      const result={accountId:owner.accountId,revision:[before.dev,before.ino,before.mtimeNs,before.size].join(':'),authJson,...(account?{expectedEmail:account.email}:{})}
      locations.set(result,dirname(file));return result
    }finally{closeSync(fd)}
  }
  const sourceHome=(agentId:string,expected:ManagedCodexCredential):string=>{
    const actual=read(agentId,false)
    if(actual.accountId!==expected.accountId||actual.revision!==expected.revision) {throw new Error('CODEX_ACCOUNT_SOURCE_CHANGED')}
    return locations.get(actual)!
  }
  return Object.freeze({read:Object.assign(read,{sourceHome}),select})
}
