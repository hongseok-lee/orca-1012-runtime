// Why this file exists (ADR-008): a separate control plane (components/agent-control) keeps
// long-lived Claude/Codex agents running and feeds them queued messages. It needs three things
// from this Orca server and nothing else: the agent's idle/working/approval state, a safe way
// to type a message into its terminal, and the agent's turn-start/turn-stop hook events.
// This module is that seam. It is entirely opt-in through two env vars and does nothing when
// both are unset, so an unset environment is upstream-identical.
//
//   ORCA_AGENT_ADAPTER_LISTEN=127.0.0.1:<port>   inbound HTTP server (loopback only)
//   ORCA_AGENT_CONTROL_URL=http://127.0.0.1:<port>  outbound hook forwarding target
//
// Inbound contract (matches agent_control/orca_terminal.py):
//   GET  /agents/{id}/status[?folder=]  -> {"status": "idle|working|awaiting_approval|unknown"}
//   POST /agents/{id}/send  {"text", "folder"?, "workspace_id"?}  -> 200 {"accepted": true}
//   POST /agents/{id}/launch {"argv", "env", "command", "folder", "workspace_id"?}
//        -> 200 {"launched": bool, "already_running": bool, "created": bool, "terminal", "pane_key"?}
//   PUT  /agents/{id}/terminal {"terminal": "<handle>"}  -> explicit id-to-terminal binding
// launch types `command` (the finished shell line; the control plane owns every flag and env
// var, this file knows none of them) into the agent's terminal, or into a new one in the
// worktree at `folder`. It does nothing when an agent is already running there.
// Agent id resolution: explicit binding, else the one writable terminal whose worktree path
// equals `folder` (preferring one that Orca already identifies as an agent), else the id is
// itself taken as an Orca terminal handle. Ambiguity resolves to nothing, never to a guess.
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { assertTerminalAgentSendable } from './rpc/terminal-agent-send-guard'
import type { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeTerminalAgentStatus } from '../../shared/runtime-terminal-contracts'

export type ControlPlaneAgentStatus = 'idle' | 'working' | 'awaiting_approval' | 'unknown'

type AdapterRuntime = Pick<
  OrcaRuntimeService,
  | 'getTerminalAgentStatus'
  | 'sendTerminalAgentPrompt'
  | 'listTerminals'
  | 'getTerminalHandleForPaneKey'
  | 'createTerminal'
  | 'sendTerminal'
>

const MAX_BODY_BYTES = 1_000_000
const FORWARD_TIMEOUT_MS = 2_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const MAX_COMMAND_LENGTH = 8192
const AGENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const FORWARDED_SOURCES = new Set(['claude', 'codex'])

export function mapAgentStatus(status: RuntimeTerminalAgentStatus): ControlPlaneAgentStatus {
  // Why: a terminal with no recognised agent running (a shell prompt) must not look idle;
  // the control plane delivers only to 'idle'.
  if (!status.isRunningAgent) {
    return 'unknown'
  }
  if (status.status === 'permission') {
    return 'awaiting_approval'
  }
  return status.status === 'working' || status.status === 'idle' ? status.status : 'unknown'
}

export function parseListenAddress(
  value: string | undefined
): { host: string; port: number } | null {
  const trimmed = value?.trim()
  if (!trimmed) {
    return null
  }
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(trimmed)
  if (!match) {
    throw new Error('ORCA_AGENT_ADAPTER_LISTEN must be host:port')
  }
  const host = match[1].replace(/^\[|\]$/g, '')
  const port = Number(match[2])
  // Why: the adapter has no authentication; it can type into any terminal. Loopback only.
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error('ORCA_AGENT_ADAPTER_LISTEN must be a loopback address')
  }
  if (port < 1 || port > 65_535) {
    throw new Error('ORCA_AGENT_ADAPTER_LISTEN port out of range')
  }
  return { host, port }
}

export class AgentTerminalRegistry {
  private readonly handleByAgentId = new Map<string, string>()

  bind(agentId: string, handle: string): void {
    this.handleByAgentId.set(agentId, handle)
  }

  get(agentId: string): string | undefined {
    return this.handleByAgentId.get(agentId)
  }

  agentIdForHandle(handle: string): string | undefined {
    for (const [agentId, bound] of this.handleByAgentId) {
      if (bound === handle) {
        return agentId
      }
    }
    return undefined
  }
}

function normalizeFolder(folder: string): string {
  return folder.length > 1 ? folder.replace(/\/+$/, '') : folder
}

export async function resolveAgentTerminal(
  runtime: AdapterRuntime,
  registry: AgentTerminalRegistry,
  agentId: string,
  folder: string | undefined
): Promise<string> {
  const bound = registry.get(agentId)
  if (bound) {
    return bound
  }
  if (folder) {
    const wanted = normalizeFolder(folder)
    const listed = await runtime.listTerminals(undefined, 500)
    const candidates = listed.terminals.filter(
      (terminal) =>
        terminal.connected && terminal.writable && normalizeFolder(terminal.worktreePath) === wanted
    )
    const agents = candidates.filter((terminal) => terminal.agentIdentity !== undefined)
    const chosen = agents.length > 0 ? agents : candidates
    if (chosen.length === 1) {
      registry.bind(agentId, chosen[0].handle)
      return chosen[0].handle
    }
    if (chosen.length > 1) {
      throw new AdapterHttpError(409, 'ambiguous_terminal')
    }
  }
  return agentId
}

export type LaunchRequest = { command: string; folder: string | undefined }

// Why: `command` is typed into a shell followed by Enter. A line break or other control
// character would run a second command, so the line must be a single printable line.
export function parseLaunchRequest(body: Record<string, unknown>): LaunchRequest {
  const { command, argv, env } = body
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new AdapterHttpError(400, 'command_required')
  }
  // eslint-disable-next-line no-control-regex
  if (command.length > MAX_COMMAND_LENGTH || /[\u0000-\u001f\u007f]/.test(command)) {
    throw new AdapterHttpError(400, 'command_invalid')
  }
  if (
    argv !== undefined &&
    (!Array.isArray(argv) || argv.length === 0 || argv.some((item) => typeof item !== 'string'))
  ) {
    throw new AdapterHttpError(400, 'argv_invalid')
  }
  if (
    env !== undefined &&
    (typeof env !== 'object' ||
      env === null ||
      Array.isArray(env) ||
      Object.values(env).some((value) => typeof value !== 'string'))
  ) {
    throw new AdapterHttpError(400, 'env_invalid')
  }
  return { command: command.trim(), folder: optionalString(body.folder) }
}

export type LaunchResult = {
  launched: boolean
  already_running: boolean
  created: boolean
  terminal: string
  pane_key?: string
}

async function findLaunchTerminal(
  runtime: AdapterRuntime,
  registry: AgentTerminalRegistry,
  agentId: string,
  folder: string | undefined
): Promise<{ handle: string; running: boolean } | null> {
  try {
    const handle = await resolveAgentTerminal(runtime, registry, agentId, folder)
    const status = await runtime.getTerminalAgentStatus(handle)
    return { handle, running: status.isRunningAgent }
  } catch (error) {
    if (error instanceof AdapterHttpError) {
      throw error
    }
    // Why: no such terminal (never created, or gone after a restart) means "open one".
    return null
  }
}

/**
 * Starts the agent CLI for `agentId`. Idempotent: a terminal that already runs an agent is left
 * alone. Otherwise the command is typed into the agent's existing terminal (a shell prompt after
 * the CLI died), or into a fresh terminal in the worktree at `folder`.
 */
export async function launchAgent(
  runtime: AdapterRuntime,
  registry: AgentTerminalRegistry,
  agentId: string,
  request: LaunchRequest
): Promise<LaunchResult> {
  const existing = await findLaunchTerminal(runtime, registry, agentId, request.folder)
  if (existing?.running) {
    return {
      launched: false,
      already_running: true,
      created: false,
      terminal: existing.handle
    }
  }
  let handle = existing?.handle
  let paneKey: string | undefined
  let created = false
  if (!handle) {
    if (!request.folder) {
      throw new AdapterHttpError(400, 'folder_required')
    }
    try {
      // Why: a bare terminal, not createTerminal's `command` option. Orca re-derives the launch
      // line of a recognised agent command from its own settings, which would drop the flags the
      // control plane chose.
      const terminal = await runtime.createTerminal(`path:${request.folder}`, {})
      handle = terminal.handle
      paneKey = terminal.paneKey ?? undefined
      created = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw message.includes('selector_not_found')
        ? new AdapterHttpError(404, 'worktree_not_found')
        : new AdapterHttpError(502, 'launch_failed')
    }
    registry.bind(agentId, handle)
  }
  try {
    await runtime.sendTerminal(handle, { text: request.command, enter: true })
  } catch (error) {
    throw classifySendError(error)
  }
  return {
    launched: true,
    already_running: false,
    created,
    terminal: handle,
    ...(paneKey ? { pane_key: paneKey } : {})
  }
}

const launchInFlight = new Map<string, Promise<LaunchResult>>()

// Why: a retry that overlaps a slow launch must not type the command twice.
function launchOnce(
  runtime: AdapterRuntime,
  registry: AgentTerminalRegistry,
  agentId: string,
  request: LaunchRequest
): Promise<LaunchResult> {
  const pending = launchInFlight.get(agentId)
  if (pending) {
    return pending
  }
  const run = launchAgent(runtime, registry, agentId, request).finally(() => {
    launchInFlight.delete(agentId)
  })
  launchInFlight.set(agentId, run)
  return run
}

class AdapterHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string
  ) {
    super(code)
  }
}

function classifySendError(error: unknown): AdapterHttpError {
  if (error instanceof AdapterHttpError) {
    return error
  }
  const message = error instanceof Error ? error.message : String(error)
  // Why: both the send guard and the prompt writer refuse while a permission prompt is open;
  // typed text there would answer the prompt.
  if (message.includes('permission') || message.includes('agent_prompt_blocked')) {
    return new AdapterHttpError(409, 'awaiting_approval')
  }
  if (message.includes('terminal_guard_no_agent')) {
    return new AdapterHttpError(409, 'no_agent')
  }
  if (
    [
      'terminal_not_writable',
      'terminal_guard_not_writable',
      'terminal_handle_stale',
      'terminal_gone',
      'terminal_exited'
    ].some((code) => message.includes(code))
  ) {
    return new AdapterHttpError(404, 'terminal_unavailable')
  }
  return new AdapterHttpError(502, 'send_failed')
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) {
      throw new AdapterHttpError(413, 'body_too_large')
    }
    chunks.push(chunk as Buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through
  }
  throw new AdapterHttpError(400, 'invalid_json')
}

function reply(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function createAgentControlAdapterHandler(
  runtime: AdapterRuntime,
  registry: AgentTerminalRegistry
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const match = /^\/agents\/([^/]+)\/(status|send|launch|terminal)$/.exec(url.pathname)
      const agentId = match ? decodeURIComponent(match[1]) : ''
      if (!match || !AGENT_ID_PATTERN.test(agentId)) {
        reply(res, 404, { error: 'not_found' })
        return
      }
      const action = match[2]
      if (action === 'status' && req.method === 'GET') {
        const folder = optionalString(url.searchParams.get('folder') ?? undefined)
        try {
          const handle = await resolveAgentTerminal(runtime, registry, agentId, folder)
          reply(res, 200, {
            status: mapAgentStatus(await runtime.getTerminalAgentStatus(handle))
          })
        } catch {
          // Why: an unknown/stale terminal is a state, not a server error; the control plane
          // treats 'unknown' as "do not deliver".
          reply(res, 200, { status: 'unknown' })
        }
        return
      }
      if (action === 'terminal' && req.method === 'PUT') {
        const terminal = optionalString((await readJsonBody(req)).terminal)
        if (!terminal) {
          throw new AdapterHttpError(400, 'terminal_required')
        }
        registry.bind(agentId, terminal)
        reply(res, 200, { bound: true })
        return
      }
      if (action === 'send' && req.method === 'POST') {
        const body = await readJsonBody(req)
        const text = optionalString(body.text)
        if (!text) {
          throw new AdapterHttpError(400, 'text_required')
        }
        try {
          const handle = await resolveAgentTerminal(
            runtime,
            registry,
            agentId,
            optionalString(body.folder)
          )
          // Why: sendTerminalAgentPrompt is Orca's own bracketed-paste + Enter path; the guard
          // runs before the paste and again before the Enter and refuses during a permission prompt.
          // Why: acceptQueued + observationTimeoutMs 0 (as Orchestration dispatch does) returns once
          // the input landed. Without it the call waits for the turn to start, which can exceed the
          // control plane's HTTP timeout; the claim was then released and the prompt typed again.
          // Turn start arrives as the UserPromptSubmit hook instead.
          await runtime.sendTerminalAgentPrompt(handle, text, {
            acceptQueued: true,
            observationTimeoutMs: 0,
            requestId: randomUUID(),
            beforeWrite: () =>
              assertTerminalAgentSendable({
                runtime: runtime as OrcaRuntimeService,
                handle,
                assertWritable: () => {}
              })
          })
        } catch (error) {
          throw classifySendError(error)
        }
        reply(res, 200, { accepted: true })
        return
      }
      if (action === 'launch' && req.method === 'POST') {
        const request = parseLaunchRequest(await readJsonBody(req))
        reply(res, 200, await launchOnce(runtime, registry, agentId, request))
        return
      }
      reply(res, 405, { error: 'method_not_allowed' })
    } catch (error) {
      if (error instanceof AdapterHttpError) {
        reply(res, error.statusCode, { error: error.code })
        return
      }
      reply(res, 500, { error: 'internal' })
    }
  }
}

let activeRuntime: AdapterRuntime | null = null
const activeRegistry = new AgentTerminalRegistry()
let adapterServer: Server | null = null

/** Starts the inbound adapter when ORCA_AGENT_ADAPTER_LISTEN is set. Never throws into startup. */
export function maybeStartAgentControlAdapter(
  runtime: AdapterRuntime,
  env: NodeJS.ProcessEnv = process.env
): Server | null {
  activeRuntime = runtime
  if (adapterServer) {
    return adapterServer
  }
  let address
  try {
    address = parseListenAddress(env.ORCA_AGENT_ADAPTER_LISTEN)
  } catch (error) {
    console.error('[agent-control-adapter] disabled:', (error as Error).message)
    return null
  }
  if (!address) {
    return null
  }
  const handler = createAgentControlAdapterHandler(runtime, activeRegistry)
  const server = createServer((req, res) => {
    void handler(req, res)
  })
  server.on('error', (error) => console.error('[agent-control-adapter] server error', error))
  server.listen(address.port, address.host, () =>
    console.error(`[agent-control-adapter] listening on ${address.host}:${address.port}`)
  )
  adapterServer = server
  return server
}

export function stopAgentControlAdapter(): void {
  adapterServer?.close()
  adapterServer = null
  activeRuntime = null
}

function parseHookPayload(envelope: Record<string, unknown>): Record<string, unknown> | null {
  const payload = envelope.payload
  try {
    const value = typeof payload === 'string' ? (JSON.parse(payload) as unknown) : payload
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function isLifecycleEvent(payload: Record<string, unknown>): boolean {
  return (
    payload.hook_event_name === 'UserPromptSubmit' ||
    payload.hook_event_name === 'Stop' ||
    payload.type === 'agent-turn-complete'
  )
}

/**
 * Best-effort, non-blocking forward of a Claude/Codex lifecycle hook that Orca's own hook
 * server already received. Never throws and never awaits: a down control plane must not slow
 * or break Orca's hook handling.
 */
export function forwardAgentHookToControlPlane(
  source: string,
  envelope: unknown,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): void {
  try {
    const base = env.ORCA_AGENT_CONTROL_URL?.trim()
    if (
      !base ||
      !FORWARDED_SOURCES.has(source) ||
      typeof envelope !== 'object' ||
      envelope === null
    ) {
      return
    }
    const record = envelope as Record<string, unknown>
    const payload = parseHookPayload(record)
    if (!payload || !isLifecycleEvent(payload)) {
      return
    }
    const target = new URL(`/hooks/${source}`, base)
    const paneKey = typeof record.paneKey === 'string' ? record.paneKey : ''
    let handle: string | null = null
    try {
      handle = paneKey && activeRuntime ? activeRuntime.getTerminalHandleForPaneKey(paneKey) : null
    } catch {
      handle = null
    }
    const agentId = handle ? (activeRegistry.agentIdForHandle(handle) ?? handle) : undefined
    if (agentId) {
      target.searchParams.set('agent_id', agentId)
    }
    void fetchImpl(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS)
    }).catch(() => {})
  } catch {
    // Best effort by design.
  }
}

export const _internals = { activeRegistry }
