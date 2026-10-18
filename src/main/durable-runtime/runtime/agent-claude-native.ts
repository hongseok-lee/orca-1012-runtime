import { openClaudeStreamJsonConnection } from '../../claude/claude-stream-json-connection.ts'
import { claudeSdkOptionsForLaunchArgs } from '../../claude/claude-structured-launch-resolution.ts'
import type { ClaudeStructuredSdkOptions } from '../../claude/claude-structured-launch-resolution.ts'

export type AgentClaudeLaunch = Readonly<{ command: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>> }>
export type AgentNativeConnection = Readonly<{
  pid: number | undefined
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  close(): Promise<boolean>
}>
export const AGENT_CLAUDE_METHODS: ReadonlySet<string> = new Set(['claude/send', 'claude/interrupt'])

/** Runs INSIDE the Agent Pod under its control host. The existing SDK stream-json
 * connection owns the Claude process; every SDK message leaves as one
 * `claude/message` notification, so a re-attached owner sees the same stream. */
export async function openAgentClaudeNative(launch: AgentClaudeLaunch, handlers: Readonly<{
  onNotification(method: string, params: unknown): void
  onExit(): void
}>): Promise<AgentNativeConnection> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the existing launch-args translator produces SDK options.
  const options = claudeSdkOptionsForLaunchArgs([...launch.args]) as ClaudeStructuredSdkOptions
  const connection = await openClaudeStreamJsonConnection({ pathToClaudeCodeExecutable: launch.command, options,
    cwd: launch.cwd, env: { ...launch.env } }, {
    onMessage: message => handlers.onNotification('claude/message', message),
    onFault: () => handlers.onExit(),
    onExit: () => handlers.onExit(),
  })
  return Object.freeze({
    get pid() { return connection.pid },
    async request(method: string, params: Record<string, unknown>): Promise<unknown> {
      if (method === 'claude/send') {
        const message = params.message
        if (!message || typeof message !== 'object' || Array.isArray(message)) { throw new Error('AGENT_CLAUDE_MESSAGE') }
        await connection.send(message as Record<string, unknown>)
        return { sent: true }
      }
      if (method === 'claude/interrupt') { return (await connection.interrupt({ cancelQueued: false })) ?? { interrupted: true } }
      throw new Error('AGENT_NATIVE_METHOD')
    },
    close: () => connection.close(),
  })
}
