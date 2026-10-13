import type { ClaudeStructuredSdkOptions } from '../../../claude/claude-structured-launch-resolution.ts'
import type { JsonValue } from '../../db/atomic.ts'
import type { OpenClaudeTransport } from './transport.ts'

/** Only invoked behind the cold effect boundary. Fixtures never load or call the SDK. */
export const openClaudeNativeTransport: OpenClaudeTransport = async (request, handlers) => {
  const [{ openClaudeStreamJsonConnection }, { claudeSdkOptionsForLaunchArgs }] = await Promise.all([
    import('../../../claude/claude-stream-json-connection.ts'),
    import('../../../claude/claude-structured-launch-resolution.ts')
  ])
  const translated = claudeSdkOptionsForLaunchArgs(request.launch.args)
  for (const [key, value] of Object.entries(translated)) {
    const original = request.launch.options[key]
    if (key !== 'extraArgs' && original !== undefined && original !== value) {
      throw new Error('CLAUDE_LAUNCH_SETTINGS_CONFLICT')
    }
  }
  const configuredExtra = request.launch.options.extraArgs
  if (configuredExtra !== undefined && (!configuredExtra || typeof configuredExtra !== 'object' || Array.isArray(configuredExtra))) {
    throw new Error('CLAUDE_LAUNCH_SETTINGS_INVALID')
  }
  for (const [key, value] of Object.entries(translated.extraArgs ?? {})) {
    if (configuredExtra && key in configuredExtra && configuredExtra[key] !== value) {
      throw new Error('CLAUDE_LAUNCH_SETTINGS_CONFLICT')
    }
  }
  const options: Record<string, JsonValue | undefined> = { ...request.launch.options, ...translated,
    extraArgs: { ...configuredExtra, ...translated.extraArgs } }
  const expected = request.native.kind === 'RESUME' ? request.native.providerRef.nativeSessionRef : undefined
  if (options.resume !== undefined && options.resume !== expected ||
      expected !== undefined && options.sessionId !== undefined && options.sessionId !== expected) {
    throw new Error('CLAUDE_RESUME_OPTIONS_CONFLICT')
  }
  if (expected !== undefined) options.resume = expected
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Existing SDK argument translator preserves native flags; this internal caller supplies SDK-compatible options, not workload evidence.
  const sdkOptions = options as ClaudeStructuredSdkOptions
  return openClaudeStreamJsonConnection({ pathToClaudeCodeExecutable: request.launch.executable,
    options: sdkOptions, cwd: request.checkout, env: { ...request.launch.env } }, handlers)
}
