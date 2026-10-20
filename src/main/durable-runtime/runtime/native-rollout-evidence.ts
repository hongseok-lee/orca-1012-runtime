import {constants,openSync,closeSync,readSync,fstatSync,lstatSync,readdirSync,realpathSync} from 'node:fs'
import {join,resolve,sep} from 'node:path'

/** Read native-owned metadata, never fabricate or rewrite provider history.
 * Missing history is provisional; IO failure/ambiguous identity is unknown. */
export function codexRolloutEvidence(home:string,id:string,path?:string):'FOUND'|'PROVISIONAL'|'UNKNOWN' {
  const root=resolve(home,'.codex'),matches:string[]=[]
  let visited=0
  const inspect=(candidate:string)=>{
    if(!realpathSync(candidate).startsWith(`${root}${sep}`)) {throw new Error('ROLLOUT_SCOPE')}
    const fd=openSync(candidate,constants.O_RDONLY|constants.O_NOFOLLOW)
    try {
      const stat=fstatSync(fd)
      if(!stat.isFile()||stat.uid!==process.getuid?.()) {throw new Error('ROLLOUT_OWNER')}
      const head=Buffer.alloc(64*1024),count=readSync(fd,head,0,head.length,0)
      const end=head.subarray(0,count).indexOf(10)
      if(end===-1) {throw new Error('ROLLOUT_HEADER_INCOMPLETE')}
      const meta=JSON.parse(head.subarray(0,end).toString('utf8'))
      const native=meta.payload?.id??meta.payload?.session_id??meta.payload?.thread_id??meta.id??meta.session_id??meta.thread_id
      if(meta.type!=='session_meta'||native!==id) {throw new Error('ROLLOUT_IDENTITY')}
      matches.push(candidate)
    } finally {closeSync(fd)}
  }
  const scan=(directory:string,depth:number)=>{
    let stat
    try {stat=lstatSync(directory)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT') {return};throw e}
    if(!stat.isDirectory()||stat.isSymbolicLink()||depth>5) {throw new Error('ROLLOUT_DIRECTORY')}
    for(const entry of readdirSync(directory,{withFileTypes:true})) {
      if(++visited>10000) {throw new Error('ROLLOUT_SCAN_LIMIT')}
      const child=join(directory,entry.name)
      if(entry.isDirectory()) {scan(child,depth+1)}
      else if(entry.name.endsWith(`-${id}.jsonl`)) {inspect(child)}
    }
  }
  try {
    if(path) {
      if(!resolve(path).startsWith(`${root}${sep}`)) {return 'UNKNOWN'}
      try {inspect(path)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT') {throw e}}
      if(matches.length===1) {return 'FOUND'}
    }
    scan(join(root,'sessions'),0);scan(join(root,'archived_sessions'),0)
    return matches.length===1?'FOUND':matches.length===0?'PROVISIONAL':'UNKNOWN'
  }catch{return 'UNKNOWN'}
}
