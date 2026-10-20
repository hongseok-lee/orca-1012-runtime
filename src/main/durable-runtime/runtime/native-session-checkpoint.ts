import {codexRolloutEvidence} from './native-rollout-evidence.ts'
import {nativeBytes as bytes,createNativeFile as create,nativeCheckpointDirectory,NATIVE_INPUT_BOUNDARY} from './native-checkpoint-files.ts'
import { join } from 'node:path'

export type NativeSessionCheckpoint = Readonly<{state:'NONE'}|{state:'UNKNOWN'}|
  {state:'UNBOUND';provider:'codex';generation:string;previousNativeSessionRef:string|null;inputState:'NOT_STARTED'}|
  {state:'FOUND'|'PROVISIONAL';provider:'codex'|'claude';nativeSessionRef:string;
    inputState?:'NOT_STARTED'|'EFFECT_POSSIBLE'|'UNTRACKED';generation?:string}>
const directory=(home:string)=>nativeCheckpointDirectory(home).path
const file=(home:string)=>join(directory(home),'native-session.json')
/** Protected per-Agent HOME identity, not a writer-stop proof. For Codex a
 * native response stays PROVISIONAL until matching native-owned history exists. */
export function readNativeSessionCheckpoint(home:string,provider:'codex'|'claude'):NativeSessionCheckpoint {
  const {path,generation}=nativeCheckpointDirectory(home),value=bytes(join(path,'native-session.json'))
  if(value!==null) {
    const parsed=JSON.parse(value)
    if(parsed.provider!==provider || typeof parsed.nativeSessionRef!=='string' || !parsed.nativeSessionRef || parsed.source!=='NATIVE_RESPONSE') {return {state:'UNKNOWN'}}
    if(provider==='claude') {return {state:'FOUND',provider,nativeSessionRef:parsed.nativeSessionRef}}
    const hint=bytes(join(directory(home),'native-rollout.json'))
    const saved=hint===null?null:JSON.parse(hint)
    if(saved&&(saved.nativeSessionRef!==parsed.nativeSessionRef||typeof saved.path!=='string')) {return {state:'UNKNOWN'}}
    const state=codexRolloutEvidence(home,parsed.nativeSessionRef,saved?.path)
    if(state==='UNKNOWN') {return {state}}
    const boundary=bytes(join(directory(home),'native-input-boundary.json'))
    if(boundary===null) {return {state,provider,nativeSessionRef:parsed.nativeSessionRef,inputState:'UNTRACKED'}}
    if(boundary!==NATIVE_INPUT_BOUNDARY) {return {state:'UNKNOWN'}}
    const entered=bytes(join(directory(home),'native-input-entered.json'))
    if(entered!==null && entered!==JSON.stringify({nativeSessionRef:parsed.nativeSessionRef,source:'BEFORE_NATIVE_TURN_START'})) {return {state:'UNKNOWN'}}
    return {state,provider,nativeSessionRef:parsed.nativeSessionRef,generation,inputState:entered===null?'NOT_STARTED':'EFFECT_POSSIBLE'}
  }
  const boundary=bytes(join(path,'native-input-boundary.json'))
  if(provider==='codex'&&boundary===NATIVE_INPUT_BOUNDARY&&bytes(join(path,'native-input-entered.json'))===null) {
    const raw=bytes(join(path,'initialization-origin.json')),origin=raw===null?null:JSON.parse(raw)
    if(origin && typeof origin.previousNativeSessionRef!=='string' && origin.previousNativeSessionRef!==null) {return {state:'UNKNOWN'}}
    return {state:'UNBOUND',provider,generation,previousNativeSessionRef:origin?.previousNativeSessionRef??null,inputState:'NOT_STARTED'}
  }
  return {state:boundary!==null||bytes(join(path,'native-entered'))!==null?'UNKNOWN':'NONE'}
}
export function markNativeEntered(home:string):void {create(join(directory(home),'native-entered'),'native effect entered\n')}
/** Only a genuinely new HOME may opt into this protocol. Absence of a marker
 * on a legacy HOME is never proof that native input was not delivered. */
export function initializeNativeInputBoundary(home:string):void {
  if(readNativeSessionCheckpoint(home,'codex').state!=='NONE'||bytes(join(directory(home),'native-input-entered.json'))!==null) {throw new Error('NATIVE_INPUT_BOUNDARY_ALREADY_ENTERED')}
  create(join(directory(home),'native-input-boundary.json'),NATIVE_INPUT_BOUNDARY)
}
/** Write and fsync BEFORE invoking turn/start. A crash after this marker is
 * ambiguous even when no native response or rollout was recorded. */
export function markNativeInputEntered(home:string,nativeSessionRef:unknown):void {
  const value=bytes(file(home)),checkpoint=value===null?null:JSON.parse(value)
  if(typeof nativeSessionRef!=='string'||checkpoint?.provider!=='codex'||checkpoint.source!=='NATIVE_RESPONSE'||
      checkpoint.nativeSessionRef!==nativeSessionRef) {throw new Error('NATIVE_INPUT_IDENTITY_UNCONFIRMED')}
  create(join(directory(home),'native-input-entered.json'),JSON.stringify({nativeSessionRef,source:'BEFORE_NATIVE_TURN_START'}))
}
export function recordNativeSessionCheckpoint(home:string,provider:'codex'|'claude',nativeSessionRef:string,rolloutPath?:string):void {
  if(!nativeSessionRef || nativeSessionRef.length>512 || [...nativeSessionRef].some(c=>c.charCodeAt(0)<32)) {throw new Error('NATIVE_SESSION_IDENTITY')}
  create(file(home),JSON.stringify({provider,nativeSessionRef,source:'NATIVE_RESPONSE'}))
  if(provider==='codex'&&rolloutPath) {
    const hint=join(directory(home),'native-rollout.json'),prior=bytes(hint)
    if(prior===null) {create(hint,JSON.stringify({nativeSessionRef,path:rolloutPath}))}
    else if(JSON.parse(prior).nativeSessionRef!==nativeSessionRef) {throw new Error('NATIVE_ROLLOUT_IDENTITY')}
  }
}
export function claudeResumeLaunch<T extends {args:readonly string[]}>(launch:T,nativeSessionRef:string):T {
  const args=[...launch.args],at=args.indexOf('--session-id')
  if(at===-1) {return launch}
  args.splice(at,2,'--resume',nativeSessionRef)
  return {...launch,args}
}
