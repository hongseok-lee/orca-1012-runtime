import {readFileSync,lstatSync} from 'node:fs'
import {join} from 'node:path'
import {writeFileAtomicallyIfUnchanged} from '../../codex-accounts/fs-utils.ts'
import type {ManagedCodexCredential} from '../providers/codex/managed-credential-owner.ts'
import {readProtectedManagedCodexAuth} from './managed-codex-auth-file.ts'

export function captureManagedCodexCredential(value:unknown):ManagedCodexCredential {
  if(!value||typeof value!=='object'||Array.isArray(value)) {throw new Error('AGENT_MANAGED_CREDENTIAL_SOURCE')}
  const x=Object.fromEntries(Object.entries(value))
  if(Object.keys(x).some(k=>!['accountId','revision','authJson','expectedEmail'].includes(k))||
    !(x.accountId===null||typeof x.accountId==='string'&&x.accountId.length>0&&x.accountId.length<256)||
    typeof x.revision!=='string'||!/^\d+:\d+:\d+:\d+$/.test(x.revision)||typeof x.authJson!=='string'||Buffer.byteLength(x.authJson)>1048576||
    x.expectedEmail!==undefined&&typeof x.expectedEmail!=='string') {throw new Error('AGENT_MANAGED_CREDENTIAL_SOURCE')}
  const auth=JSON.parse(x.authJson)
  if(auth.auth_mode!=='chatgpt'||!auth.tokens||!['access_token','refresh_token','id_token'].every(k=>typeof auth.tokens[k]==='string'&&auth.tokens[k])) {throw new Error('AGENT_MANAGED_CREDENTIAL_SOURCE')}
  return x as ManagedCodexCredential
}
/** Native auth in the protected HOME is freshest within this selected source
 * revision. Never replace a refreshed native token with the same old bootstrap.
 * An actual selected-owner source revision change uses the existing CAS writer. */
export function supplyProtectedManagedCodexCredential(home:string,original:ManagedCodexCredential,assertRoot:()=>void):string {
  const source=captureManagedCodexCredential(original),directory=join(home,'.codex'),file=join(directory,'auth.json'),marker=join(directory,'.orca-managed-source.json')
  assertRoot()
  const dir=lstatSync(directory)
  if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid?.()||(dir.mode&0o777)!==0o700) {throw new Error('AGENT_MANAGED_CREDENTIAL_HOME')}
  let prior:string|null=null,current:string|null=null
  try {const s=lstatSync(marker);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o600) {throw new Error('AGENT_MANAGED_CREDENTIAL_MARKER')};prior=readFileSync(marker,'utf8')}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT') {throw e}}
  try {current=readProtectedManagedCodexAuth(home)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT') {throw e}}
  const key=JSON.stringify({accountId:source.accountId,revision:source.revision})
  if(prior===key&&current!==null) {assertRoot();return key}
  assertRoot()
  if(!writeFileAtomicallyIfUnchanged(file,current,source.authJson,{mode:0o600})) {throw new Error('AGENT_MANAGED_CREDENTIAL_CHANGED')}
  if(!writeFileAtomicallyIfUnchanged(marker,prior,key,{mode:0o600})) {throw new Error('AGENT_MANAGED_CREDENTIAL_CHANGED')}
  assertRoot();return key
}
