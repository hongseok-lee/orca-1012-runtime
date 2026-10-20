export const AGENT_TERMINAL_CAPABILITY = 'orca-agent-terminal-v1'
export type AgentTerminalMethod = 'PTY_STATUS' | 'PTY_READ' | 'PTY_WRITE' | 'PTY_RESIZE'
export function isAgentTerminalMethod(value: unknown): value is AgentTerminalMethod {
  return typeof value === 'string' && ['PTY_STATUS', 'PTY_READ', 'PTY_WRITE', 'PTY_RESIZE'].includes(value)
}
export function supportsAgentTerminal(value: unknown): boolean {
  return Array.isArray(value) && value.includes(AGENT_TERMINAL_CAPABILITY)
}
export type AgentTerminalControl = Readonly<{ terminal: Readonly<{
  supported(): boolean
  request(method: AgentTerminalMethod, params?: Record<string, unknown>): Promise<unknown>
}> }>
export function createAgentTerminalClient(supported: () => boolean,
  request: (method: AgentTerminalMethod, params?: Record<string, unknown>) => Promise<unknown>): AgentTerminalControl {
  return Object.freeze({ terminal: Object.freeze({ supported, request(method, params) {
    if (!isAgentTerminalMethod(method)) { return Promise.reject(new Error('AGENT_CODEX_CONTROL_UNCONFIRMED')) }
    return request(method, params)
  } }) })
}
export type AgentTerminalFrame = Readonly<{ controlId: string; incarnationId: string; hostSeq: number } & (
  { event: 'PTY_OUTPUT'; startByte: number; endByte: number; bytes: string } |
  { event: 'PTY_EXIT'; exitCode: number; signal?: number }
)>

/** Validate replayed and live observations identically; bytes remain bytes. */
export function readAgentTerminalFrame(record: Record<string, unknown>, controlId: string): AgentTerminalFrame {
  const fail = (): never => { throw new Error('AGENT_TERMINAL_FRAME_INVALID') }
  if (record.controlId !== controlId || typeof record.incarnationId !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(record.incarnationId) || !Number.isSafeInteger(record.hostSeq) || Number(record.hostSeq) < 1) { fail() }
  const base = { controlId, incarnationId: record.incarnationId as string, hostSeq: Number(record.hostSeq) }
  if (record.event === 'PTY_OUTPUT') {
    if (!Number.isSafeInteger(record.startByte) || !Number.isSafeInteger(record.endByte) || Number(record.startByte) < 0 ||
        Number(record.endByte) < Number(record.startByte) || typeof record.bytes !== 'string' || record.bytes.length > 2 * 1024 * 1024) { fail() }
    const bytes = Buffer.from(record.bytes as string, 'base64')
    if (bytes.toString('base64') !== record.bytes || bytes.length !== Number(record.endByte) - Number(record.startByte)) { fail() }
    return Object.freeze({ ...base, event: 'PTY_OUTPUT', startByte: Number(record.startByte), endByte: Number(record.endByte), bytes: record.bytes as string })
  }
  if (record.event !== 'PTY_EXIT' || !Number.isSafeInteger(record.exitCode) ||
      record.signal !== undefined && (!Number.isSafeInteger(record.signal) || Number(record.signal) < 0)) { fail() }
  return Object.freeze({ ...base, event: 'PTY_EXIT', exitCode: Number(record.exitCode),
    ...(record.signal === undefined ? {} : { signal: Number(record.signal) }) })
}
