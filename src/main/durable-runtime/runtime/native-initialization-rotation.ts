import {mkdirSync,renameSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {readNativeSessionCheckpoint} from './native-session-checkpoint.ts'
import {nativeInitializationProof} from './native-initialization-proof.ts'
import {nativeCheckpointDirectory,ownedDirectory,syncNativeDirectory,createNativeFile,NATIVE_INPUT_BOUNDARY} from './native-checkpoint-files.ts'
import type {NativeInitializationProof} from './native-checkpoint-files.ts'

/** Caller must hold the original actual-COMMIT cold permit and revalidate the
 * authenticated checkpoint. Old generations are never deleted or overwritten.
 * Before/after the atomic pointer switch, a reader sees one complete generation. */
export function rotateNativeInitialization(home:string,proof:NativeInitializationProof):void {
  if(!isDeepStrictEqual(nativeInitializationProof(readNativeSessionCheckpoint(home,'codex')),proof)) {throw new Error('NATIVE_INITIALIZATION_CHANGED')}
  const current=nativeCheckpointDirectory(home)
  if(current.generation!==proof.generation) {throw new Error('NATIVE_GENERATION_CHANGED')}
  const root=join(home,'.orca-native'),generations=join(root,'generations')
  mkdirSync(generations,{recursive:true,mode:0o700});ownedDirectory(generations);syncNativeDirectory(root)
  const generation=randomUUID(),next=join(generations,generation)
  mkdirSync(next,{mode:0o700});syncNativeDirectory(generations)
  createNativeFile(join(next,'native-input-boundary.json'),NATIVE_INPUT_BOUNDARY)
  createNativeFile(join(next,'initialization-origin.json'),JSON.stringify(proof))
  const temporary=join(root,`active-generation-${generation}.tmp`)
  createNativeFile(temporary,JSON.stringify({generation}))
  renameSync(temporary,join(root,'active-generation.json'));syncNativeDirectory(root)
}
