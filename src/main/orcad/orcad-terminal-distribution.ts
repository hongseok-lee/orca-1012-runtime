import { dirname, join } from 'node:path'
import { agentPodFields, agentPodText, agentPodInteger } from '../durable-runtime/runtime/agent-pod-policy.ts'
import { parseUniqueOrcadControllerJson, readPrivateOrcadControllerConfigBytes } from './orcad-controller-config.ts'

/** Fixed siblings from the existing installed node-pty. No archive filenames
 * or arbitrary executable paths are accepted from the manifest. */
export function readAgentTerminalDistribution(file: string) {
  const raw = agentPodFields(parseUniqueOrcadControllerJson(readPrivateOrcadControllerConfigBytes(file).toString('utf8')),
    ['version', 'platform', 'arch', 'nodeAbi', 'files'])
  const files = raw.get('files'), arch = agentPodText(raw.get('arch')), nodeAbi = agentPodText(raw.get('nodeAbi'))
  if (raw.get('version') !== 1 || raw.get('platform') !== 'linux' ||
      !['x64', 'arm64'].includes(arch) || !/^[1-9]\d*$/.test(nodeAbi) || !Array.isArray(files) || files.length !== 2) {
    throw new Error('AGENT_TERMINAL_DISTRIBUTION')
  }
  const entries = new Map(files.map(item => {
    const row = agentPodFields(item, ['name', 'sha256', 'byteLength'])
    const name = agentPodText(row.get('name')), sha256 = agentPodText(row.get('sha256'))
    if (!['terminal-runtime.cjs', 'terminal-pty.node'].includes(name) || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error('AGENT_TERMINAL_DISTRIBUTION')
    }
    return [name, Object.freeze({ file: join(dirname(file), name), sha256, byteLength: agentPodInteger(row.get('byteLength')) })] as const
  }))
  const runtime = entries.get('terminal-runtime.cjs'), addon = entries.get('terminal-pty.node')
  if (!runtime || !addon) { throw new Error('AGENT_TERMINAL_DISTRIBUTION') }
  return Object.freeze({ platform: 'linux' as const, arch, nodeAbi, runtime, addon })
}
