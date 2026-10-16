import { isIP } from 'node:net'
import { posix } from 'node:path'

export class AgentPodPlanError extends Error {
  constructor(readonly code: 'POLICY_INVALID' | 'INPUT_INVALID' | 'PROTECTED_BINDING_COUNT_UNSUPPORTED' | 'MOUNT_SCOPE_INVALID') {
    super(`AGENT_POD_${code}`)
    this.name = 'AgentPodPlanError'
  }
}

// Capture plain own data only. Getters, prototype policy and extra overrides never run.
export function agentPodFields(value: unknown, keys: readonly string[]): ReadonlyMap<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new AgentPodPlanError('INPUT_INVALID')
  }
  const own = Reflect.ownKeys(value)
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) {
    throw new AgentPodPlanError('INPUT_INVALID')
  }
  const result = new Map<string, unknown>()
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) { throw new AgentPodPlanError('INPUT_INVALID') }
    result.set(key, descriptor.value)
  }
  return result
}

export function agentPodText(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value ||
      Array.from(value).some(char => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) {
    throw new AgentPodPlanError('INPUT_INVALID')
  }
  return value
}

export function agentPodName(value: unknown, label = false): string {
  const name = agentPodText(value)
  if (name.length > (label ? 63 : 253) || label && name.includes('.') ||
      name.split('.').some(part => part.length > 63 || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/u.test(part))) {
    throw new AgentPodPlanError('INPUT_INVALID')
  }
  return name
}

export function agentPodPath(value: unknown): string {
  const path = agentPodText(value)
  if (!path.startsWith('/') || path.includes('\\') || path !== posix.normalize(path) ||
      path !== '/' && path.endsWith('/') || path.split('/').some(part => part === '.' || part === '..')) {
    throw new AgentPodPlanError('INPUT_INVALID')
  }
  return path
}

export function agentPodWithin(parent: string, child: string): boolean {
  return parent === '/' || child === parent || child.startsWith(`${parent}/`)
}

export function agentPodInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) { throw new AgentPodPlanError('INPUT_INVALID') }
  return value
}

export function agentPodArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1) { throw new AgentPodPlanError('INPUT_INVALID') }
  const result: unknown[] = []
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
    if (!descriptor || !('value' in descriptor)) { throw new AgentPodPlanError('INPUT_INVALID') }
    result.push(descriptor.value)
  }
  return Object.freeze(result)
}

export function agentPodUuid(value: unknown): string {
  const uuid = agentPodText(value)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(uuid)) {
    throw new AgentPodPlanError('INPUT_INVALID')
  }
  return uuid
}

/** Server composition input only. Capture validates shape, not the caller's authority. */
export function captureAgentPodPolicy(value: unknown) {
  try {
    const input = agentPodFields(value, ['namespace', 'dataset', 'image', 'entrypoint', 'paths', 'nfsServer', 'protectedExportRoot', 'shared'])
    const namespace = agentPodName(input.get('namespace'), true), dataset = agentPodName(input.get('dataset'), true)
    const image = agentPodText(input.get('image'))
    if (!/^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/u.test(image) || image.includes('://')) {
      throw new AgentPodPlanError('POLICY_INVALID')
    }
    const entrypointInput = agentPodFields(input.get('entrypoint'), ['command', 'args'])
    const command = Object.freeze(agentPodArray(entrypointInput.get('command')).map(agentPodText))
    const args = Object.freeze(agentPodArray(entrypointInput.get('args')).map(value => {
      // Empty argv elements are meaningful; control characters are not accepted.
      if (value === '') { return '' }
      return agentPodText(value)
    }))
    if (!command.length) { throw new AgentPodPlanError('POLICY_INVALID') }
    const pathsInput = agentPodFields(input.get('paths'), ['home', 'claudeState', 'codexState', 'checkout'])
    const paths = Object.freeze({ home: agentPodPath(pathsInput.get('home')), claudeState: agentPodPath(pathsInput.get('claudeState')),
      codexState: agentPodPath(pathsInput.get('codexState')), checkout: agentPodPath(pathsInput.get('checkout')) })
    for (const path of Object.values(paths)) {
      if (path === '/agent' || !agentPodWithin('/agent', path)) { throw new AgentPodPlanError('POLICY_INVALID') }
    }
    const nfsServer = agentPodText(input.get('nfsServer'))
    if (!isIP(nfsServer)) { agentPodName(nfsServer) }
    const protectedExportRoot = agentPodPath(input.get('protectedExportRoot'))
    const sharedInput = agentPodFields(input.get('shared'), ['claimName', 'claimUid', 'pvUid', 'serverPath'])
    const shared = Object.freeze({ claimName: agentPodName(sharedInput.get('claimName')), claimUid: agentPodText(sharedInput.get('claimUid')),
      pvUid: agentPodText(sharedInput.get('pvUid')), serverPath: agentPodPath(sharedInput.get('serverPath')) })
    if (protectedExportRoot !== `/exports/runtime-domains/${dataset}` || shared.serverPath !== `/exports/shared/${dataset}` ||
        agentPodWithin(protectedExportRoot, shared.serverPath) || agentPodWithin(shared.serverPath, protectedExportRoot)) {
      throw new AgentPodPlanError('POLICY_INVALID')
    }
    return Object.freeze({ namespace, dataset, image, entrypoint: Object.freeze({ command, args }), paths,
      nfsServer, protectedExportRoot, shared })
  } catch { throw new AgentPodPlanError('POLICY_INVALID') }
}

export type CapturedAgentPodPolicy = ReturnType<typeof captureAgentPodPolicy>
