import { randomUUID } from 'node:crypto'
import { captureCodexTurnProcesses, terminateCodexTurnProcesses, type CodexTurnProcessSnapshot } from '../../codex/codex-structured-turn-processes.ts'
import type { CodexProtocolDependencies } from '../providers/codex/protocol.ts'

export const TURN_PROCESSES_CAPABILITY = 'codex-turn-processes-v1'
export const CAPTURE_TURN_PROCESSES = 'CAPTURE_TURN_PROCESSES'
export const STOP_TURN_PROCESSES = 'STOP_TURN_PROCESSES'
export const supportsTurnProcesses = (value: unknown): boolean => Array.isArray(value) && value.includes(TURN_PROCESSES_CAPABILITY)

/** The snapshot stays in the Pod which owns the processes. A backend PID is
 * never used to signal a local process or supplied as a target by a client. */
export function agentTurnProcesses() {
  let held: { token: string; pid: number; snapshot: CodexTurnProcessSnapshot } | null = null
  return {
    async capture(pid: number) {
      held = null
      const snapshot = await captureCodexTurnProcesses(pid)
      if (!snapshot) { throw new Error('AGENT_TURN_PROCESS_CAPTURE_FAILED') }
      held = { token: randomUUID(), pid, snapshot }
      return { token: held.token }
    },
    async stop(pid: number, params: unknown) {
      if (!held || held.pid !== pid || !params || typeof params !== 'object' || Reflect.get(params, 'token') !== held.token) {
        throw new Error('AGENT_TURN_PROCESS_TARGET_CHANGED')
      }
      const original = held
      held = null
      return { stopped: await terminateCodexTurnProcesses(pid, original.snapshot) }
    }
  }
}

export function remoteTurnProcesses(supported: () => boolean, request: (method: string, params?: Record<string, unknown>) => Promise<unknown>): Pick<CodexProtocolDependencies, 'capture' | 'terminate'> {
  const issued = new WeakSet<object>()
  return {
    async capture() {
      if (!supported()) { return undefined }
      const value = await request(CAPTURE_TURN_PROCESSES)
      if (!value || typeof value !== 'object' || typeof Reflect.get(value, 'token') !== 'string') { throw new Error('AGENT_TURN_PROCESS_CAPTURE_FAILED') }
      issued.add(value)
      return value
    },
    async terminate(_pid, baseline) {
      if (!baseline || typeof baseline !== 'object' || !issued.has(baseline)) { return false }
      issued.delete(baseline)
      const result = await request(STOP_TURN_PROCESSES, { token: Reflect.get(baseline, 'token') })
      return !!result && typeof result === 'object' && Reflect.get(result, 'stopped') === true
    }
  }
}
