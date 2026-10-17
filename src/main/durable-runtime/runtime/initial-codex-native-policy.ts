import type { GlobalSettings } from '../../../shared/global-settings-types.ts'
import { resolveTuiAgentLaunchArgs, resolveTuiAgentLaunchEnv } from '../../../shared/tui-agent-launch-defaults.ts'
import { resolveStructuredLaunchSeedOptions } from '../../../shared/native-chat-session-option-defaults.ts'
import { resolveCodexStructuredAppServerArgs } from '../../codex/codex-structured-app-server-args.ts'
import { immutableSnapshot } from '../providers/shared/immutable-snapshot.ts'

export type InitialCodexNativeSettings = Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv' | 'nativeChatSessionOptions'>

/** Same production argument/default/seed conversion as the original host.
 * Explicit empty settings and explicit model/effort survive unchanged; worker
 * model names, inferred native fields and permission defaults are not invented. */
export function captureInitialCodexNativePolicy(original: InitialCodexNativeSettings) {
  const settings = immutableSnapshot(original)
  const args = resolveCodexStructuredAppServerArgs(resolveTuiAgentLaunchArgs('codex', settings.agentDefaultArgs), 'posix')
  const env = resolveTuiAgentLaunchEnv('codex', settings.agentDefaultEnv)
  const options = resolveStructuredLaunchSeedOptions(settings.nativeChatSessionOptions, 'codex') ?? {}
  return immutableSnapshot({ args, env, options })
}
