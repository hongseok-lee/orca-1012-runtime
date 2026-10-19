import { dirname,join } from 'node:path'
import { agentPodFields,agentPodText,agentPodInteger } from '../durable-runtime/runtime/agent-pod-policy.ts'
import { parseUniqueOrcadControllerJson,readPrivateOrcadControllerConfigBytes } from './orcad-controller-config.ts'

/** Deployment artifact metadata, produced from one installed upstream release.
 * Files are immutable content-addressed siblings, not extraction paths. */
export function readCodexNativeDistribution(file:string,main:Readonly<{file:string;sha256:string;byteLength:number}>) {
  const raw=agentPodFields(parseUniqueOrcadControllerJson(readPrivateOrcadControllerConfigBytes(file).toString('utf8')),
    ['format','version','target','files'])
  const version=agentPodText(raw.get('version')),target=agentPodText(raw.get('target')),files=raw.get('files')
  if(raw.get('format')!=='ORCA_CODEX_NATIVE_V1' || !/^\d+\.\d+\.\d+(?:[-.a-zA-Z0-9]+)?$/.test(version) ||
      !['x86_64-unknown-linux-musl','aarch64-unknown-linux-musl'].includes(target) || !Array.isArray(files) || files.length!==3) {throw Error('CODEX_NATIVE_DISTRIBUTION')}
  const entries=new Map(files.map(item=>{
    const row=agentPodFields(item,['name','file','sha256','byteLength']),name=agentPodText(row.get('name')),base=agentPodText(row.get('file')),sha256=agentPodText(row.get('sha256'))
    if(!['codex','codex-code-mode-host','codex-resources/bwrap'].includes(name) || !/^[a-zA-Z0-9._-]+$/.test(base) || base==='.' || base==='..' || !/^[0-9a-f]{64}$/.test(sha256)) {throw Error('CODEX_NATIVE_DISTRIBUTION')}
    return [name,Object.freeze({file:join(dirname(file),base),sha256,byteLength:agentPodInteger(row.get('byteLength'))})] as const
  }))
  const binary=entries.get('codex'),host=entries.get('codex-code-mode-host'),bwrap=entries.get('codex-resources/bwrap')
  if(!binary || !host || !bwrap || binary.file!==main.file || binary.sha256!==main.sha256 || binary.byteLength!==main.byteLength) {throw Error('CODEX_NATIVE_DISTRIBUTION_MISMATCH')}
  return Object.freeze({version,target,host,bwrap})
}
