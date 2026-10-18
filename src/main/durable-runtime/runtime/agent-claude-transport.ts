import type { CodexAppServerConnection, CodexAppServerConnectionHandlers } from '../../codex/codex-app-server-connection-types.ts'
import type { CodexNativeNotification } from '../providers/codex/protocol.ts'
import type { ClaudeProtocolConnection, OpenClaudeTransport } from '../providers/claude/transport.ts'

type HostedOpen = (handlers: CodexAppServerConnectionHandlers) => Promise<CodexAppServerConnection>
export type AgentClaudeHostedControl = Readonly<{ controlId: string; frameSequence(): number }>

/** Claude driver transport over a Pod-local control host. Each SDK message is
 * one `claude/message` frame; its hostSeq names the output notification, so a
 * replay after re-attach or a later backend process lands on the same key. */
export function agentClaudeTransport(control: AgentClaudeHostedControl, open: HostedOpen,
  onNativeNotification?: (notification: CodexNativeNotification) => void): (handlers: Parameters<OpenClaudeTransport>[1]) => Promise<ClaudeProtocolConnection> {
  return async handlers => {
    const connection = await open({
      onNotification: (method, params) => {
        if (method !== 'claude/message' || !params || typeof params !== 'object' || Array.isArray(params)) { return }
        const sequence = control.frameSequence()
        if (sequence > 0) {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: hostSeq of the frame being delivered is the producer sequence.
          onNativeNotification?.(Object.freeze({ connectionId: control.controlId, sequence: String(sequence), method, params,
            observedAt: new Date().toISOString() }) as unknown as CodexNativeNotification)
        }
        handlers.onMessage(params as Record<string, unknown>)
      },
      onExit: () => handlers.onExit(),
    })
    return Object.freeze({
      get closed() { return connection.closed },
      async send(message: Record<string, unknown>) { await connection.request('claude/send', { message }) },
      interrupt: () => connection.request('claude/interrupt', {}),
    })
  }
}
