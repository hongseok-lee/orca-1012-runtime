export type ClaudeInitObservation = {
  providerSessionId: string
  uuid: string | null
  model: string | null
  message: Record<string, unknown>
}
export function readClaudeFrameString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}
export function readClaudeInit(message: Record<string, unknown>): ClaudeInitObservation | null {
  const hookName = readClaudeFrameString(message, 'hook_name')
  const isInit = message.type === 'system' && message.subtype === 'init'
  const isSessionStart = message.type === 'system' &&
    (message.subtype === 'hook_started' || message.subtype === 'hook_response') &&
    hookName?.startsWith('SessionStart:') === true
  if (!isInit && !isSessionStart) return null
  const providerSessionId = readClaudeFrameString(message, 'session_id')
  return providerSessionId ? {
    providerSessionId,
    uuid: isInit ? readClaudeFrameString(message, 'uuid') : null,
    model: isInit ? readClaudeFrameString(message, 'model') : null,
    message
  } : null
}
