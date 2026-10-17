import { createInterface } from 'node:readline'
import { runAgentCodexControl } from './agent-codex-control.ts'

/** Trusted bundle entry. Initialization travels over the private exec stdin,
 * never command argv/query/audit, because launch env can contain secrets.
 * The backend waits for HELLO before sending any later frame. */
export function startAgentCodexControlEntry(): void {
  const init = createInterface({ input: process.stdin, crlfDelay: Infinity })
  init.once('line', line => {
    init.close()
    try {
      if (Buffer.byteLength(line) > 1024 * 1024) { throw new Error('INIT_SIZE') }
      const value = JSON.parse(line)
      if (!value || value.method !== 'INITIALIZE' || Object.keys(value).sort().join(',') !== 'method,policy') {
        throw new Error('INIT_FRAME')
      }
      runAgentCodexControl(value.policy)
    } catch {
      // No underlying error, stack, env, token, or bootstrap input is printed.
      process.stderr.write('AGENT_CONTROL_INITIALIZATION_FAILED\n')
      process.exitCode = 1
    }
  })
}

startAgentCodexControlEntry()
