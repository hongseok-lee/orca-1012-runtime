import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  AgentTerminalRegistry,
  _internals,
  createAgentControlAdapterHandler,
  forwardAgentHookToControlPlane,
  mapAgentStatus,
  maybeStartAgentControlAdapter,
  parseListenAddress,
  stopAgentControlAdapter
} from './agent-control-adapter'

type Runtime = Parameters<typeof createAgentControlAdapterHandler>[0]

function makeRuntime(overrides: Record<string, unknown> = {}): Runtime {
  return {
    createTerminal: vi.fn(async () => ({ handle: 'new-h', paneKey: 'tab:leaf' })),
    sendTerminal: vi.fn(async (handle: string) => ({ handle, accepted: true, bytesWritten: 1 })),
    getTerminalAgentStatus: vi.fn(async (handle: string) => ({
      handle,
      isRunningAgent: true,
      status: 'idle'
    })),
    sendTerminalAgentPrompt: vi.fn(async (handle: string) => ({
      handle,
      accepted: true,
      bytesWritten: 1
    })),
    listTerminals: vi.fn(async () => ({
      terminals: [],
      totalCount: 0,
      truncated: false
    })),
    getTerminalHandleForPaneKey: vi.fn(() => null),
    ...overrides
  } as unknown as Runtime
}

let servers: Server[] = []

async function serve(runtime: Runtime, registry = new AgentTerminalRegistry()): Promise<string> {
  const handler = createAgentControlAdapterHandler(runtime, registry)
  const server = createServer((req, res) => void handler(req, res))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

afterEach(() => {
  for (const server of servers) {
    server.close()
  }
  servers = []
  stopAgentControlAdapter()
})

describe('mapAgentStatus', () => {
  it.each([
    [{ isRunningAgent: true, status: 'idle' }, 'idle'],
    [{ isRunningAgent: true, status: 'working' }, 'working'],
    [{ isRunningAgent: true, status: 'permission' }, 'awaiting_approval'],
    [{ isRunningAgent: true, status: null }, 'unknown'],
    [{ isRunningAgent: false, status: 'idle' }, 'unknown']
  ] as const)('maps %j to %s', (input, expected) => {
    expect(mapAgentStatus({ handle: 'h', ...input })).toBe(expected)
  })
})

describe('parseListenAddress', () => {
  it('accepts loopback and rejects everything else', () => {
    expect(parseListenAddress(undefined)).toBeNull()
    expect(parseListenAddress('127.0.0.1:9100')).toEqual({ host: '127.0.0.1', port: 9100 })
    expect(parseListenAddress('[::1]:9100')).toEqual({ host: '::1', port: 9100 })
    expect(() => parseListenAddress('0.0.0.0:9100')).toThrow(/loopback/)
    expect(() => parseListenAddress('nonsense')).toThrow()
  })
})

describe('adapter HTTP', () => {
  it('reports status for a terminal handle used as the agent id', async () => {
    const runtime = makeRuntime({
      getTerminalAgentStatus: vi.fn(async () => ({
        handle: 'term_1',
        isRunningAgent: true,
        status: 'permission'
      }))
    })
    const base = await serve(runtime)
    const res = await fetch(`${base}/agents/term_1/status`)
    expect(await res.json()).toEqual({ status: 'awaiting_approval' })
  })

  it('reports unknown when the terminal cannot be read', async () => {
    const runtime = makeRuntime({
      getTerminalAgentStatus: vi.fn(async () => {
        throw new Error('terminal_handle_stale')
      })
    })
    const base = await serve(runtime)
    expect(await (await fetch(`${base}/agents/x/status`)).json()).toEqual({ status: 'unknown' })
  })

  it('resolves the terminal by folder and remembers it', async () => {
    const runtime = makeRuntime({
      listTerminals: vi.fn(async () => ({
        terminals: [
          { handle: 'a', connected: true, writable: true, worktreePath: '/w/one' },
          {
            handle: 'b',
            connected: true,
            writable: true,
            worktreePath: '/w/two/',
            agentIdentity: 'claude'
          },
          { handle: 'c', connected: true, writable: true, worktreePath: '/w/two', title: 'shell' }
        ],
        totalCount: 3,
        truncated: false
      }))
    })
    const registry = new AgentTerminalRegistry()
    const base = await serve(runtime, registry)
    await fetch(`${base}/agents/ag1/status?folder=${encodeURIComponent('/w/two')}`)
    expect(runtime.getTerminalAgentStatus).toHaveBeenCalledWith('b')
    expect(registry.get('ag1')).toBe('b')
  })

  it('refuses an ambiguous folder instead of guessing', async () => {
    const runtime = makeRuntime({
      listTerminals: vi.fn(async () => ({
        terminals: [
          {
            handle: 'a',
            connected: true,
            writable: true,
            worktreePath: '/w',
            agentIdentity: 'claude'
          },
          {
            handle: 'b',
            connected: true,
            writable: true,
            worktreePath: '/w',
            agentIdentity: 'codex'
          }
        ],
        totalCount: 2,
        truncated: false
      }))
    })
    const base = await serve(runtime)
    const res = await fetch(`${base}/agents/ag/send`, {
      method: 'POST',
      body: JSON.stringify({ text: 'hi', folder: '/w' })
    })
    expect(res.status).toBe(409)
    expect(runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('sends through the agent prompt path with the send guard as beforeWrite', async () => {
    const runtime = makeRuntime()
    const base = await serve(runtime)
    await fetch(`${base}/agents/ag/terminal`, {
      method: 'PUT',
      body: JSON.stringify({ terminal: 'term_9' })
    })
    const res = await fetch(`${base}/agents/ag/send`, {
      method: 'POST',
      body: JSON.stringify({ text: 'do the thing' })
    })
    expect(res.status).toBe(200)
    const [handle, text, options] = (runtime.sendTerminalAgentPrompt as ReturnType<typeof vi.fn>)
      .mock.calls[0]
    expect([handle, text]).toEqual(['term_9', 'do the thing'])
    await expect(options.beforeWrite()).resolves.toBeUndefined()
    // Returns once the input landed instead of waiting for the turn to start (I2 live finding).
    expect(options).toMatchObject({ acceptQueued: true, observationTimeoutMs: 0 })
    expect(typeof options.requestId).toBe('string')
  })

  it('refuses to send during a permission prompt', async () => {
    const runtime = makeRuntime({
      getTerminalAgentStatus: vi.fn(async () => ({
        handle: 't',
        isRunningAgent: true,
        status: 'permission'
      })),
      sendTerminalAgentPrompt: vi.fn(async (_h: string, _t: string, options: any) => {
        await options.beforeWrite()
        return { accepted: true }
      })
    })
    const base = await serve(runtime)
    const res = await fetch(`${base}/agents/t/send`, {
      method: 'POST',
      body: JSON.stringify({ text: 'y' })
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'awaiting_approval' })
  })

  it('validates input', async () => {
    const base = await serve(makeRuntime())
    expect((await fetch(`${base}/agents/a/send`, { method: 'POST', body: '{}' })).status).toBe(400)
    expect((await fetch(`${base}/agents/a/send`, { method: 'POST', body: 'x' })).status).toBe(400)
    expect((await fetch(`${base}/nope`)).status).toBe(404)
    expect((await fetch(`${base}/agents/a/status`, { method: 'POST' })).status).toBe(405)
  })
})

describe('maybeStartAgentControlAdapter', () => {
  it('is inert when the env var is unset', () => {
    expect(maybeStartAgentControlAdapter(makeRuntime(), {})).toBeNull()
  })

  it('does not throw on a non-loopback address', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(
      maybeStartAgentControlAdapter(makeRuntime(), { ORCA_AGENT_ADAPTER_LISTEN: '0.0.0.0:1' })
    ).toBeNull()
    error.mockRestore()
  })
})

describe('forwardAgentHookToControlPlane', () => {
  const env = { ORCA_AGENT_CONTROL_URL: 'http://127.0.0.1:9' }
  const stop = {
    paneKey: 'tab:leaf',
    payload: JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' })
  }

  it('does nothing without ORCA_AGENT_CONTROL_URL', () => {
    const fetchImpl = vi.fn()
    forwardAgentHookToControlPlane('claude', stop, {}, fetchImpl as never)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('forwards lifecycle events with the agent id hint', () => {
    maybeStartAgentControlAdapter(
      makeRuntime({ getTerminalHandleForPaneKey: vi.fn(() => 'term_7') }),
      {}
    )
    _internals.activeRegistry.bind('agent-7', 'term_7')
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    forwardAgentHookToControlPlane('claude', stop, env, fetchImpl as never)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('http://127.0.0.1:9/hooks/claude?agent_id=agent-7')
    expect(JSON.parse(init.body as string)).toEqual({ hook_event_name: 'Stop', session_id: 's1' })
  })

  it('skips other providers and non-lifecycle events', () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    forwardAgentHookToControlPlane('gemini', stop, env, fetchImpl as never)
    forwardAgentHookToControlPlane(
      'claude',
      { paneKey: 'p', payload: { hook_event_name: 'PreToolUse' } },
      env,
      fetchImpl as never
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('swallows a failing control plane', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(() =>
      forwardAgentHookToControlPlane(
        'codex',
        {
          paneKey: 'p',
          payload: { type: 'agent-turn-complete', 'thread-id': 't' }
        },
        env,
        fetchImpl as never
      )
    ).not.toThrow()
    await Promise.resolve()
  })
})

describe('POST /agents/{id}/launch', () => {
  const body = {
    argv: ['claude', '--dangerously-skip-permissions', '--resume', 's1'],
    env: { DISABLE_AUTOUPDATER: '1' },
    command: "env DISABLE_AUTOUPDATER=1 claude --dangerously-skip-permissions --resume s1",
    folder: '/w/one',
    workspace_id: 'ws'
  }
  const post = (base: string, payload: unknown, id = 'ag1') =>
    fetch(`${base}/agents/${id}/launch`, { method: 'POST', body: JSON.stringify(payload) })
  const notRunning = { handle: 'x', isRunningAgent: false, status: null }

  it('opens a terminal in the worktree and types the supplied command verbatim', async () => {
    const runtime = makeRuntime({
      getTerminalAgentStatus: vi.fn(async () => {
        throw new Error('terminal_handle_stale')
      })
    })
    const registry = new AgentTerminalRegistry()
    const res = await post(await serve(runtime, registry), body)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      launched: true,
      already_running: false,
      created: true,
      terminal: 'new-h',
      pane_key: 'tab:leaf'
    })
    expect(runtime.createTerminal).toHaveBeenCalledWith('path:/w/one', {})
    expect(runtime.sendTerminal).toHaveBeenCalledWith('new-h', { text: body.command, enter: true })
    expect(registry.get('ag1')).toBe('new-h')
  })

  it('reuses the existing terminal when no agent runs in it', async () => {
    const runtime = makeRuntime({ getTerminalAgentStatus: vi.fn(async () => notRunning) })
    const registry = new AgentTerminalRegistry()
    registry.bind('ag1', 'old-h')
    const res = await post(await serve(runtime, registry), body)
    expect(await res.json()).toMatchObject({ launched: true, created: false, terminal: 'old-h' })
    expect(runtime.createTerminal).not.toHaveBeenCalled()
    expect(runtime.sendTerminal).toHaveBeenCalledWith('old-h', { text: body.command, enter: true })
  })

  it('is a no-op when an agent already runs in the terminal', async () => {
    const runtime = makeRuntime()
    const registry = new AgentTerminalRegistry()
    registry.bind('ag1', 'old-h')
    const res = await post(await serve(runtime, registry), body)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      launched: false,
      already_running: true,
      created: false,
      terminal: 'old-h'
    })
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
    expect(runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('types the command once for overlapping requests', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const runtime = makeRuntime({
      getTerminalAgentStatus: vi.fn(async () => {
        await gate
        return notRunning
      })
    })
    const registry = new AgentTerminalRegistry()
    registry.bind('ag1', 'old-h')
    const base = await serve(runtime, registry)
    const first = post(base, body)
    const second = post(base, body)
    await new Promise((resolve) => setTimeout(resolve, 150))
    release()
    await Promise.all([first, second])
    expect(runtime.sendTerminal).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ ...body, command: undefined }, 'command_required'],
    [{ ...body, command: 'claude\nrm -rf /' }, 'command_invalid'],
    [{ ...body, argv: [] }, 'argv_invalid'],
    [{ ...body, env: { A: 1 } }, 'env_invalid']
  ])('rejects a malformed request (%#)', async (payload, code) => {
    const runtime = makeRuntime()
    const res = await post(await serve(runtime), payload)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: code })
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('needs a folder to open a terminal, and maps a missing worktree to 404', async () => {
    const gone = vi.fn(async () => {
      throw new Error('nope')
    })
    const noFolder = await post(
      await serve(makeRuntime({ getTerminalAgentStatus: gone })),
      { ...body, folder: undefined }
    )
    expect(noFolder.status).toBe(400)
    const missing = makeRuntime({
      getTerminalAgentStatus: gone,
      createTerminal: vi.fn(async () => {
        throw new Error('selector_not_found')
      })
    })
    const res = await post(await serve(missing), body)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'worktree_not_found' })
  })

  it('reports a failing terminal write instead of claiming success', async () => {
    const runtime = makeRuntime({
      getTerminalAgentStatus: vi.fn(async () => notRunning),
      sendTerminal: vi.fn(async () => {
        throw new Error('terminal_not_writable')
      })
    })
    const registry = new AgentTerminalRegistry()
    registry.bind('ag1', 'old-h')
    const res = await post(await serve(runtime, registry), body)
    expect(res.status).toBe(404)
  })
})
