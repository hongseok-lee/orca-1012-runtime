import {constants,openSync,closeSync,readFileSync,fstatSync,lstatSync} from 'node:fs'
import {join} from 'node:path'
/** Same protected per-Agent credential file the normal supplier/native owns.
 * Read only to identify a new supply; never write/hash/log its bytes here. */
export function readProtectedManagedCodexAuth(home:string):string {
  const directory=lstatSync(join(home,'.codex'))
  if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==process.getuid?.()) {throw new Error('AGENT_MANAGED_AUTH_FILE')}
  const fd=openSync(join(home,'.codex','auth.json'),constants.O_RDONLY|constants.O_NOFOLLOW)
  try {
    const stat=fstatSync(fd)
    if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>1024*1024) {throw new Error('AGENT_MANAGED_AUTH_FILE')}
    const bytes=readFileSync(fd,'utf8'),auth:unknown=JSON.parse(bytes)
    if(!auth||typeof auth!=='object'||Array.isArray(auth)||Reflect.get(auth,'auth_mode')!=null&&Reflect.get(auth,'auth_mode')!=='chatgpt') {throw new Error('AGENT_MANAGED_AUTH_FILE')}
    const tokens=Reflect.get(auth,'tokens')
    if(!tokens||typeof tokens!=='object'||!['access_token','id_token','refresh_token'].every(k=>typeof Reflect.get(tokens,k)==='string'&&Reflect.get(tokens,k).trim())) {throw new Error('AGENT_MANAGED_AUTH_FILE')}
    return bytes
  } finally {closeSync(fd)}
}
