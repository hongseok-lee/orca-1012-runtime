import {codexRolloutEvidence} from './native-rollout-evidence.ts'
import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

export type NativeSessionCheckpoint = Readonly<{state:'NONE'}|{state:'UNKNOWN'}|
  {state:'FOUND'|'PROVISIONAL';provider:'codex'|'claude';nativeSessionRef:string;
    inputState?:'NOT_STARTED'|'EFFECT_POSSIBLE'|'UNTRACKED'}>
const file = (home:string) => join(home,'.orca-native','native-session.json')
function bytes(path:string):string|null {
  let fd:number
  try {fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW)} catch(e) {
    if((e as NodeJS.ErrnoException).code==='ENOENT') {return null} throw e
  }
  try {return readFileSync(fd,'utf8')} finally {closeSync(fd)}
}
/** Protected per-Agent HOME identity, not a writer-stop proof. For Codex a
 * native response stays PROVISIONAL until matching native-owned history exists. */
export function readNativeSessionCheckpoint(home:string,provider:'codex'|'claude'):NativeSessionCheckpoint {
  const value=bytes(file(home))
  if(value!==null) {
    const parsed=JSON.parse(value)
    if(parsed.provider!==provider || typeof parsed.nativeSessionRef!=='string' || !parsed.nativeSessionRef || parsed.source!=='NATIVE_RESPONSE') {return {state:'UNKNOWN'}}
    if(provider==='claude') {return {state:'FOUND',provider,nativeSessionRef:parsed.nativeSessionRef}}
    const hint=bytes(join(home,'.orca-native','native-rollout.json'))
    const saved=hint===null?null:JSON.parse(hint)
    if(saved&&(saved.nativeSessionRef!==parsed.nativeSessionRef||typeof saved.path!=='string')) {return {state:'UNKNOWN'}}
    const state=codexRolloutEvidence(home,parsed.nativeSessionRef,saved?.path)
    if(state==='UNKNOWN') {return {state}}
    const boundary=bytes(join(home,'.orca-native','native-input-boundary.json'))
    if(boundary===null) {return {state,provider,nativeSessionRef:parsed.nativeSessionRef,inputState:'UNTRACKED'}}
    if(boundary!==JSON.stringify({protocolVersion:1,source:'BEFORE_FIRST_NATIVE_OPEN'})) {return {state:'UNKNOWN'}}
    const entered=bytes(join(home,'.orca-native','native-input-entered.json'))
    if(entered!==null && entered!==JSON.stringify({nativeSessionRef:parsed.nativeSessionRef,source:'BEFORE_NATIVE_TURN_START'})) {return {state:'UNKNOWN'}}
    return {state,provider,nativeSessionRef:parsed.nativeSessionRef,inputState:entered===null?'NOT_STARTED':'EFFECT_POSSIBLE'}
  }
  return {state:bytes(join(home,'.orca-native','native-entered'))===null?'NONE':'UNKNOWN'}
}
function create(path:string,value:string):void {
  let fd:number,fresh=true
  try {fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)} catch(e) {
    if((e as NodeJS.ErrnoException).code!=='EEXIST'||bytes(path)!==value) {throw e}
    // A prior attempt may have written these bytes but failed during fsync.
    // Reusing equal content must finish durability before permitting effects.
    fresh=false;fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  }
  try {if(fresh) {writeFileSync(fd,value)};fsyncSync(fd)} finally {closeSync(fd)}
  const parent=openSync(join(path,'..'),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
  try {fsyncSync(parent)} finally {closeSync(parent)}
}
export function markNativeEntered(home:string):void {create(join(home,'.orca-native','native-entered'),'native effect entered\n')}
/** Only a genuinely new HOME may opt into this protocol. Absence of a marker
 * on a legacy HOME is never proof that native input was not delivered. */
export function initializeNativeInputBoundary(home:string):void {
  if(readNativeSessionCheckpoint(home,'codex').state!=='NONE'||bytes(join(home,'.orca-native','native-input-entered.json'))!==null) {throw new Error('NATIVE_INPUT_BOUNDARY_ALREADY_ENTERED')}
  create(join(home,'.orca-native','native-input-boundary.json'),JSON.stringify({protocolVersion:1,source:'BEFORE_FIRST_NATIVE_OPEN'}))
}
/** Write and fsync BEFORE invoking turn/start. A crash after this marker is
 * ambiguous even when no native response or rollout was recorded. */
export function markNativeInputEntered(home:string,nativeSessionRef:unknown):void {
  const value=bytes(file(home)),checkpoint=value===null?null:JSON.parse(value)
  if(typeof nativeSessionRef!=='string'||checkpoint?.provider!=='codex'||checkpoint.source!=='NATIVE_RESPONSE'||
      checkpoint.nativeSessionRef!==nativeSessionRef) {throw new Error('NATIVE_INPUT_IDENTITY_UNCONFIRMED')}
  create(join(home,'.orca-native','native-input-entered.json'),JSON.stringify({nativeSessionRef,source:'BEFORE_NATIVE_TURN_START'}))
}
export function recordNativeSessionCheckpoint(home:string,provider:'codex'|'claude',nativeSessionRef:string,rolloutPath?:string):void {
  if(!nativeSessionRef || nativeSessionRef.length>512 || [...nativeSessionRef].some(c=>c.charCodeAt(0)<32)) {throw new Error('NATIVE_SESSION_IDENTITY')}
  const directory=lstatSync(join(home,'.orca-native'))
  if(!directory.isDirectory() || directory.isSymbolicLink() || directory.uid!==process.getuid?.()) {throw new Error('NATIVE_SESSION_HOME')}
  create(file(home),JSON.stringify({provider,nativeSessionRef,source:'NATIVE_RESPONSE'}))
  if(provider==='codex'&&rolloutPath) {
    const hint=join(home,'.orca-native','native-rollout.json'),prior=bytes(hint)
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
