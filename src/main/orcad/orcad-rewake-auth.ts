import { isAbsolute, normalize } from 'node:path'
import { agentPodFields, agentPodText } from '../durable-runtime/runtime/agent-pod-policy.ts'

/** Trusted deployment selection, scoped to an actual catalog Agent. No public
 * request can choose a credential file or change another Agent's source. */
export function captureRewakeCodexAuthSources(value: unknown): ReadonlyMap<string, string> {
  const sources = new Map<string, string>()
  if (value === undefined) { return sources }
  if (!Array.isArray(value)) { throw new Error('REWAKE_CODEX_AUTH_SOURCES') }
  for (const item of value) {
    const fields = agentPodFields(item, ['agentId', 'codexAuthFile'])
    const agentId = agentPodText(fields.get('agentId')), path = agentPodText(fields.get('codexAuthFile'))
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(agentId) ||
        !isAbsolute(path) || normalize(path) !== path || sources.has(agentId)) { throw new Error('REWAKE_CODEX_AUTH_SOURCE') }
    sources.set(agentId, path)
  }
  return sources
}

export function rewakeNativeFiles<T extends Readonly<Record<string, unknown>>>(
  provider: 'codex' | 'claude', agentId: string, defaults: T, sources: ReadonlyMap<string, string>
): T {
  const codexAuthFile = provider === 'codex' ? sources.get(agentId) : undefined
  return codexAuthFile ? { ...defaults, codexAuthFile } : defaults
}
