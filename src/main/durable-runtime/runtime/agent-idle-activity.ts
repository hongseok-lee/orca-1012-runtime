import { readdirSync, readFileSync } from 'node:fs'

export const AGENT_IDLE_CAPABILITY = 'orca-agent-idle-v1'
export const supportsAgentIdle = (value: unknown): boolean => Array.isArray(value) && value.includes(AGENT_IDLE_CAPABILITY)
export const AGENT_IDLE_METHODS = ['IDLE_OBSERVE', 'IDLE_QUIESCE', 'IDLE_RESUME'] as const
export type AgentIdleMethod = typeof AGENT_IDLE_METHODS[number]
export type AgentIdleControl = Readonly<{
  supported(): boolean
  request(method: AgentIdleMethod): Promise<unknown>
}>

type ProcessIdentity = Readonly<{ pid: number; parent: number; start: string; state: string }>
/** The Pod has its own PID namespace. Track PID 1's tree, including tools
 * reparented to PID 1 after double-fork. Exec transport processes have parent 0
 * and do not belong to the workload. PID + start ticks prevents PID reuse. */
export function readPodWorkloadProcesses(): readonly ProcessIdentity[] {
  const rows: ProcessIdentity[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^[1-9]\d*$/.test(entry)) { continue }
    try {
      const text = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
      rows.push({ pid: Number(entry), parent: Number(fields[1]), state: fields[0], start: fields[19] })
    } catch (error) {
      if (Reflect.get(Object(error), 'code') !== 'ENOENT' && Reflect.get(Object(error), 'code') !== 'ESRCH') { throw error }
    }
  }
  if (!rows.some(row => row.pid === 1)) { throw new Error('AGENT_PROCESS_NAMESPACE_UNKNOWN') }
  const owned = new Set([1])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true }
    }
  }
  return rows.filter(row => owned.has(row.pid) && row.state !== 'Z' && row.state !== 'X')
}

/** One admission gate shared by native input and raw PTY input. Queries do not
 * change activity. The gate stays resident across backend disconnection. */
export function createAgentIdleActivity(readProcesses = readPodWorkloadProcesses) {
  let baseline: ReadonlyMap<number, string> | null = null
  let active = false, quiesced = false, sequence = 0, lastWorkAt = Date.now()
  const work = () => { sequence++; lastWorkAt = Date.now() }
  return Object.freeze({
    initialize() { baseline = new Map(readProcesses().map(row => [row.pid, row.start])); work() },
    assertInput() { if (quiesced) { throw new Error('AGENT_IDLE_QUIESCED') } },
    beginTurn() { if (quiesced) { throw new Error('AGENT_IDLE_QUIESCED') }; active = true; work() },
    notification(method: string, params: unknown) {
      if (method.startsWith('turn/') || method.startsWith('item/') || method === 'claude/message') { work() }
      if (method === 'turn/started') { active = true }
      if (method === 'turn/completed' || method === 'claude/message' && params && typeof params === 'object' && Reflect.get(params, 'type') === 'result') { active = false }
    },
    work,
    resume() { quiesced = false; return { resumed: true } },
    observe(quiesce = false) {
      if (!baseline) { throw new Error('AGENT_ACTIVITY_UNAVAILABLE') }
      // No await between closing admission and observing all workload processes.
      const previous = quiesced
      if (quiesce) { quiesced = true }
      try {
        const backgroundWriter = readProcesses().some(row => baseline!.get(row.pid) !== row.start)
        if (active || backgroundWriter) { quiesced = previous; return { idle: false, activeTurn: active, backgroundWriter, lastWorkAt, sequence: String(sequence) } }
        return { idle: true, quiesced, sequence: String(sequence), lastWorkAt, observedAt: Date.now() }
      } catch (error) { quiesced = previous; throw error }
    }
  })
}
