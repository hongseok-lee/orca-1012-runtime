import type { CodexProtocolDependencies } from './protocol.ts'
import type { CodexTurnProcessSnapshot } from '../../../codex/codex-structured-turn-processes'

/** No process is started by construction. The upper committed executor invokes open. */
export function codexNativeTransport(): Pick<CodexProtocolDependencies, 'open' | 'capture' | 'terminate'> {
  const captured = new Map<object, CodexTurnProcessSnapshot>()
  return {
    open: async (launch, handlers) => {
      const { openCodexAppServerConnection } = await import('../../../codex/codex-app-server-connection')
      return openCodexAppServerConnection(launch, handlers)
    },
    capture: async (pid) => {
      const { captureCodexTurnProcesses } = await import('../../../codex/codex-structured-turn-processes')
      const snapshot = await captureCodexTurnProcesses(pid)
      if (snapshot) {captured.set(snapshot, snapshot)}
      return snapshot
    },
    terminate: async (pid, candidate) => {
      if (typeof candidate !== 'object' || candidate === null) {return false}
      const snapshot = captured.get(candidate)
      if (!snapshot) {return false}
      const { terminateCodexTurnProcesses } = await import('../../../codex/codex-structured-turn-processes')
      const stopped = await terminateCodexTurnProcesses(pid, snapshot)
      captured.delete(candidate)
      return stopped
    }
  }
}
