import {constants,openSync,closeSync,readFileSync,writeFileSync,fsyncSync,lstatSync} from 'node:fs'
import {join} from 'node:path'

export type NativeInitializationProof=Readonly<{generation:string;previousNativeSessionRef:string|null}>
export function nativeBytes(path:string):string|null {
  let fd:number
  try {fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW)}catch(e) {
    if((e as NodeJS.ErrnoException).code==='ENOENT') {return null};throw e
  }
  try{return readFileSync(fd,'utf8')}finally{closeSync(fd)}
}
export function syncNativeDirectory(path:string):void {
  const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
  try{fsyncSync(fd)}finally{closeSync(fd)}
}
export function createNativeFile(path:string,value:string):void {
  let fd:number,fresh=true
  try{fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)}catch(e) {
    if((e as NodeJS.ErrnoException).code!=='EEXIST'||nativeBytes(path)!==value) {throw e}
    fresh=false;fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  }
  try{if(fresh) {writeFileSync(fd,value)};fsyncSync(fd)}finally{closeSync(fd)}
  syncNativeDirectory(join(path,'..'))
}
export function ownedDirectory(path:string):void {
  const stat=lstatSync(path)
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()) {throw new Error('NATIVE_SESSION_HOME')}
}
export function nativeCheckpointDirectory(home:string):Readonly<{path:string;generation:string}> {
  const root=join(home,'.orca-native');ownedDirectory(root)
  const pointer=nativeBytes(join(root,'active-generation.json'))
  if(pointer===null) {return {path:root,generation:'base'}}
  const {generation}=JSON.parse(pointer)
  if(typeof generation!=='string'||!/^[0-9a-f-]{36}$/.test(generation)) {throw new Error('NATIVE_GENERATION_IDENTITY')}
  const generations=join(root,'generations'),path=join(generations,generation)
  ownedDirectory(generations);ownedDirectory(path)
  return {path,generation}
}
export const NATIVE_INPUT_BOUNDARY=JSON.stringify({protocolVersion:1,source:'BEFORE_FIRST_NATIVE_OPEN'})

