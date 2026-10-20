import { createRequire } from 'node:module'
import { join } from 'node:path'
import type * as NodePty from 'node-pty'
import { createAgentTerminal } from './agent-terminal.ts'
import { nativeFileMatches } from './native-artifact-file.ts'
import type { CodexNativeArtifact } from './agent-codex-preparation.ts'
import type { AgentTerminalMethod } from './agent-terminal-protocol.ts'

/** Pod-side adapter. Only COLD calls open; the private request surface has no
 * spawn/restart operation. Files come from the existing verified preparation. */
export function createAgentTerminalControl(input: Readonly<{
  home: string; cwd: string; env: Record<string, string>
  artifact: NonNullable<CodexNativeArtifact['terminal']>
  assertCurrent(): void; send(frame: Record<string, unknown>): void
}>) {
  let attempted = false
  const terminal = createAgentTerminal({ cwd: input.cwd, env: { ...input.env }, assertCurrent: input.assertCurrent,
    spawn: async (file, args, options) => {
      input.assertCurrent()
      const directory = join(input.home, '.orca-native')
      const runtimeFile = join(directory, 'terminal-runtime.cjs'), addonFile = join(directory, 'terminal-pty.node')
      if (!nativeFileMatches(runtimeFile, input.artifact.runtime) || !nativeFileMatches(addonFile, input.artifact.addon)) {
        throw new Error('AGENT_TERMINAL_ARTIFACT_CHANGED')
      }
      const runtime: typeof NodePty = createRequire(runtimeFile)(runtimeFile)
      input.assertCurrent()
      return runtime.spawn(file, args, options)
    },
    onOutput(frame) { input.send({ event: 'PTY_OUTPUT', ...frame }) },
    onExit(incarnationId, exitCode, signal) { input.send({ event: 'PTY_EXIT', incarnationId, exitCode, signal }) }
  })
  return Object.freeze({
    async openDuringCold() { attempted = true; return terminal.open(80, 24) },
    /** Raw shell commands may leave detached descendants. The parent control
     * must retain protection until the lifecycle owner proves the Pod stopped. */
    requiresPhysicalStop: () => attempted,
    requestClose: terminal.requestClose,
    request(method: AgentTerminalMethod, params: unknown): unknown {
      input.assertCurrent()
      if (method === 'PTY_STATUS') { return terminal.inspect() }
      if (!params || typeof params !== 'object' || Array.isArray(params)) { throw new Error('AGENT_TERMINAL_PARAMS') }
      const p = params as Record<string, unknown>
      if (typeof p.incarnationId !== 'string') { throw new Error('AGENT_TERMINAL_INCARNATION') }
      if (method === 'PTY_READ' && typeof p.fromByte === 'number') { return terminal.read(p.incarnationId, p.fromByte) }
      if (method === 'PTY_RESIZE' && typeof p.cols === 'number' && typeof p.rows === 'number') {
        terminal.resize(p.incarnationId, p.cols, p.rows); return { resized: true }
      }
      if (method === 'PTY_WRITE' && typeof p.requestId === 'string' && typeof p.bytes === 'string') {
        return terminal.write(p.incarnationId, p.requestId, p.bytes)
      }
      throw new Error('AGENT_TERMINAL_PARAMS')
    }
  })
}
