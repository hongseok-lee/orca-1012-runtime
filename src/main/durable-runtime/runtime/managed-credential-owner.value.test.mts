import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,chmodSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createManagedCodexCredentialOwner} from '../providers/codex/managed-credential-owner.ts'
import {supplyProtectedManagedCodexCredential,captureManagedCodexCredential} from './managed-codex-credential-supply.ts'
import {managedCodexAuthControl,handleManagedCodexAuthRefresh,createResidentManagedCodexAuthRefresh} from './managed-codex-auth-refresh.ts'
import {getPersistedCodexPaneAccount,recordCodexPaneAccount,reconcileCodexPaneAccountsWithLivePtys} from '../../codex/codex-pane-account-registry.ts'
import {setAppEnvironment} from '../../../shared/app-environment.ts'

const auth=(token:string)=>JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:token,refresh_token:token,id_token:token}})
test('one persisted product owner drives cold/resume/live refresh; native revision survives and actual source change is supplied',async()=>{
 const root=mkdtempSync(join(tmpdir(),'orca-owner-'));chmodSync(root,0o700)
 try{
  const userData=join(root,'userData'),id='owned-account',sourceHome=join(userData,'codex-accounts',id,'home'),home=join(root,'agent-home')
  mkdirSync(sourceHome,{recursive:true,mode:0o700});writeFileSync(join(sourceHome,'.orca-managed-home'),`${id}\n`,{mode:0o600})
  writeFileSync(join(sourceHome,'auth.json'),auth('fixture-source-1'),{mode:0o600})
  mkdirSync(join(home,'.codex'),{recursive:true,mode:0o700})
  const settings={activeCodexManagedAccountId:id,activeCodexManagedAccountIdsByRuntime:{host:id,wsl:{}},codexManagedAccounts:[{id,email:'owned@example.invalid',managedHomePath:sourceHome,createdAt:1,updatedAt:1,lastAuthenticatedAt:1}]}
  setAppEnvironment({getPath:()=>userData,getAppPath:()=>root,getVersion:()=>'',isPackaged:()=>true,onWillQuit:()=>{},exit:()=>{},getAppMetrics:()=>[]})
  const owner=createManagedCodexCredentialOwner({userDataPath:userData,getSettings:()=>settings,readOwner:getPersistedCodexPaneAccount,recordOwner:recordCodexPaneAccount})
  settings.codexManagedAccounts.push({id:'missing-account',email:'missing@example.invalid',managedHomePath:join(userData,'codex-accounts','missing-account','home'),createdAt:1,updatedAt:1,lastAuthenticatedAt:1})
  settings.activeCodexManagedAccountId='missing-account';settings.activeCodexManagedAccountIdsByRuntime.host='missing-account'
  assert.throws(()=>owner.read('agent-missing',true),/CODEX_ACCOUNT_AUTH_MISSING/)
  assert.equal(getPersistedCodexPaneAccount('durable-agent:agent-missing'),null,'failed source read must not pin invalid selection')
  settings.activeCodexManagedAccountId=id;settings.activeCodexManagedAccountIdsByRuntime.host=id
  assert.equal(owner.read('agent-missing',true).accountId,id)
  assert.throws(()=>owner.read('agent-one',false),/UNATTRIBUTED/)
  const initial=owner.read('agent-one',true)
  supplyProtectedManagedCodexCredential(home,initial,()=>{})
  writeFileSync(join(home,'.codex','auth.json'),auth('fixture-native-refreshed'),{mode:0o600})
  settings.activeCodexManagedAccountId=null as never;settings.activeCodexManagedAccountIdsByRuntime.host=null as never
  reconcileCodexPaneAccountsWithLivePtys([])
  const resumed=owner.read('agent-one',false)
  assert.equal(resumed.accountId,id)
  supplyProtectedManagedCodexCredential(home,resumed,()=>{})
  assert.equal(readFileSync(join(home,'.codex','auth.json'),'utf8'),auth('fixture-native-refreshed'))
  let current=initial,calls=0
  const native={async request(method:string,params:unknown){calls++;assert.equal(method,'account/read');assert.deepEqual(params,{refreshToken:true});return {account:{type:'chatgpt',email:'owned@example.invalid'},requiresOpenaiAuth:true,secretToken:'never-project'}}}
  const refresh=createResidentManagedCodexAuthRefresh(()=>native,()=>JSON.stringify([current.accountId,current.revision]),()=>current.expectedEmail)
  const control=managedCodexAuthControl(()=>true,()=>true,(method,params)=>{
    assert.equal(method,'REFRESH_CODEX_MANAGED_AUTH')
    return handleManagedCodexAuthRefresh({provider:'codex',phase:'READY',connection:native,params,refresh,applyCredential:value=>{const source=captureManagedCodexCredential(value);supplyProtectedManagedCodexCredential(home,source,()=>{});current=source}})
  },()=>owner.read('agent-one',false))
  assert.deepEqual(await control.refreshManagedAuth(),{state:'COMPLETED',authMode:'chatgpt'})
  assert.deepEqual(await control.refreshManagedAuth(),{state:'COMPLETED',authMode:'chatgpt'});assert.equal(calls,1)
  writeFileSync(join(sourceHome,'auth.json'),auth('fixture-source-revised-longer'),{mode:0o600})
  assert.deepEqual(await control.refreshManagedAuth(),{state:'COMPLETED',authMode:'chatgpt'});assert.equal(calls,2)
  assert.equal(readFileSync(join(home,'.codex','auth.json'),'utf8'),auth('fixture-source-revised-longer'))
  assert.notEqual(current.revision,initial.revision)
  assert.equal(getPersistedCodexPaneAccount('durable-agent:agent-one')?.accountId,id)
  assert.equal(JSON.parse(readFileSync(join(userData,'codex-pane-accounts.json'),'utf8')).panes['durable-agent:agent-one'].lifetime,'durable-agent')
 }finally{rmSync(root,{recursive:true,force:true})}
})
