import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs'

const fail = (): Error => new Error('AGENT_CODEX_CONTROL_UNCONFIRMED')

/** Pin every deployment file before preparation; stream all siblings directly
 * into protected HOME. COLD is unreachable until the Agent verifies all files. */
export async function supplyNativeAndCold(request: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  file: string, byteLength: number, companion?: Readonly<{file:string;byteLength:number;sandboxBwrap?:Readonly<{file:string;byteLength:number}>}>): Promise<number | null> {
  const inputs=[{file,byteLength,name:undefined},...(companion?[{file:companion.file,byteLength:companion.byteLength,name:'codex-code-mode-host'}]:[]),
    ...(companion?.sandboxBwrap?[{...companion.sandboxBwrap,name:'codex-resources/bwrap'}]:[])]
  const opened:{fd:number;name:string|undefined}[]=[]
  try {
    for(const input of inputs) {
      const fd=openSync(input.file,constants.O_RDONLY|constants.O_NOFOLLOW);opened.push({fd,name:input.name})
      const stat=fstatSync(fd)
      if(!stat.isFile() || stat.size!==input.byteLength) {throw fail()}
    }
    await request('PREPARE_COLD')
    const buffer=Buffer.alloc(256*1024)
    for(const {fd,name} of opened) {
      let offset=0,count:number
      while((count=readSync(fd,buffer,0,buffer.length,null))>0) {
        await request('NATIVE_CHUNK',{offset,bytes:buffer.subarray(0,count).toString('base64'),...(name?{name}:{})});offset+=count
      }
    }
    await request('NATIVE_FINISH')
  } finally {for(const {fd} of opened) {closeSync(fd)}}
  const ack=await request('COLD'),pid=ack&&typeof ack==='object'?Reflect.get(ack,'nativePid'):null
  return Number.isSafeInteger(pid)&&Number(pid)>=1?Number(pid):null
}
