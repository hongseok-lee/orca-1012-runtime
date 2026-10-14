import type { JsonValue } from '../../db/atomic.ts'
import type { ProviderColdRequest } from '../shared/contracts.ts'

export type ClaudeLaunchSettings = {
  readonly executable: string
  readonly args: readonly string[]
  readonly options: Readonly<Record<string, JsonValue | undefined>>
  readonly env: Readonly<Record<string, string>>
}
export type ClaudeColdRequest = ProviderColdRequest<ClaudeLaunchSettings>
export type ClaudeProtocolHandlers = {
  onMessage(message: Record<string, unknown>): void
  onFault(): void
  onExit(): void
}
/** The existing SDK connection satisfies this narrow surface; no new CLI runner. */
export interface ClaudeProtocolConnection {
  readonly closed: boolean
  send(message: Record<string, unknown>): Promise<void>
  interrupt(options: { cancelQueued: false }): Promise<unknown>
}
export type OpenClaudeTransport = (
  request: ClaudeColdRequest,
  handlers: ClaudeProtocolHandlers
) => Promise<ClaudeProtocolConnection>
