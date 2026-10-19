import { spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, closeSync } from 'node:fs'
import { dirname } from 'node:path'
import { runAgentCodexControl } from './agent-codex-control.ts'
import { agentCodexBootstrap } from './agent-control-bootstrap.ts'
import { AGENT_CONTROL_HOST_FLAG, AGENT_CONTROL_HOST_SOCKET, runAgentControlBridge, startAgentControlHost } from './agent-control-host.ts'

const POD_TOKEN = '/var/run/secrets/orca-runtime-agent/token'

/** Trusted bundle entry. The exec'd process is only a bridge to the Pod-local
 * host; the host owns the control and its provider, so losing the exec stream
 * detaches instead of stranding the provider. Initialization still travels over
 * the private exec stdin, never command argv/query/audit, because launch env can
 * contain secrets. The backend waits for HELLO before sending any later frame. */
export function startAgentCodexControlEntry(): void {
  if (process.argv.includes(AGENT_CONTROL_HOST_FLAG)) {
    const host = startAgentControlHost({
      socketPath: AGENT_CONTROL_HOST_SOCKET,
      readPodBearer: () => readFileSync(POD_TOKEN, 'utf8').trim(),
      createControl(init, input, output) {
        const keys = Object.keys(init).sort().join(',')
        if (init.method !== 'INITIALIZE' || (keys !== 'method,policy' && keys !== 'method,policy,term')) {
          throw new Error('INIT_FRAME')
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the control validates its own deployment policy before any effect.
        return runAgentCodexControl(init.policy as Parameters<typeof runAgentCodexControl>[0], input, output)
      },
    })
    host.listening.catch(() => { process.exitCode = 20; process.exit() })
    void host.closed.then(() => process.exit(0))
    return
  }
  void runAgentControlBridge({
    socketPath: AGENT_CONTROL_HOST_SOCKET, input: process.stdin, output: process.stdout,
    spawnHost() {
      mkdirSync(dirname(AGENT_CONTROL_HOST_SOCKET), { recursive: true, mode: 0o700 })
      const log = openSync(`${dirname(AGENT_CONTROL_HOST_SOCKET)}/host.log`, 'a', 0o600)
      try {
        // Same fixed bootstrap and bundle digest; only the mode flag differs.
        spawn(process.execPath, ['-e', agentCodexBootstrap, process.argv[1], AGENT_CONTROL_HOST_FLAG],
          { detached: true, stdio: ['ignore', log, log] }).unref()
      } finally { closeSync(log) }
    },
  }).then(() => process.exit(0), () => {
    // No underlying error, stack, env, token, or bootstrap input is printed.
    process.stderr.write('AGENT_CONTROL_BRIDGE_FAILED\n')
    process.exit(1)
  })
}

startAgentCodexControlEntry()
