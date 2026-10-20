import {codexRolloutEvidence} from './native-rollout-evidence.ts'
import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

export type NativeSessionCheckpoint = Readonly<{state:'NONE'}|{state:'UNKNOWN'}|
  {state:'FOUND'|'PROVISIONAL';provider:'codex'|'claude';nativeSessionRef:string}>
const file = (home:string) => join(home,'.orca-native','native-session.json')
function bytes(path:string):string|null {
  let fd:number
  try {fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW)} catch(e) {
    if((e as NodeJS.ErrnoException).code==='ENOENT') {return null} throw e
  }
  try {return readFileSync(fd,'utf8')} finally {closeSync(fd)}
}
/** Protected per-Agent HOME checkpoint, not a Google/cloud audit record or a
 * writer-stop proof. Only actual native thread/init responses write FOUND. */
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
    return state==='UNKNOWN'?{state}:{state,provider,nativeSessionRef:parsed.nativeSessionRef}
  }
  return {state:bytes(join(home,'.orca-native','native-entered'))===null?'NONE':'UNKNOWN'}
}
function create(path:string,value:string):void {
  let fd:number
  try {fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)} catch(e) {
    if((e as NodeJS.ErrnoException).code==='EEXIST' && bytes(path)===value) {return} throw e
  }
  try {writeFileSync(fd,value);fsyncSync(fd)} finally {closeSync(fd)}
  const parent=openSync(join(path,'..'),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
  try {fsyncSync(parent)} finally {closeSync(parent)}
}
export function markNativeEntered(home:string):void {create(join(home,'.orca-native','native-entered'),'native effect entered\n')}
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
