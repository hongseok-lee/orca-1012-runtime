import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime.ts'
import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { DurableCatalogReadConfig } from './config.ts'
import { SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY } from '../../../shared/protocol-version.ts'

/** Synthetic transport context only; this is not a paired credential issuer. */
export const syntheticFingerprint = 'a'.repeat(64)
export function fixtureConfig(pool: Pool): DurableCatalogReadConfig {
  return { pool, datasetName: 'orca-1012-dev-v1', hostId: 'local', readHostIdentity: () => 'local',
    repositoryIds: [], projectGroupIds: [], workspacePublicIds: [], pollIntervalMs: 10 }
}
export function fixtureRuntime() {
  const cleanups = new Map<string, { close: () => void; connection?: string }>()
  const unexpected: string[] = []
  const target = {
    getRuntimeId: () => 'synthetic-public-read-runtime',
    getClientSettings: () => ({ experimentalStructuredNativeChat: false }),
    registerSubscriptionCleanup(id: string, close: () => void, connection?: string) { cleanups.set(id, { close, connection }) },
    cleanupSubscription(id: string) { const found = cleanups.get(id); cleanups.delete(id); found?.close() }
  }
  const runtime = new Proxy(target, { get(object, property, receiver) {
    if (Reflect.has(object, property)) { return Reflect.get(object, property, receiver) }
    if (property === 'routeClientHostedBrowserRpc') { return undefined }
    return () => { unexpected.push(String(property)); throw new Error('Unexpected old runtime path') }
  } }) as unknown as OrcaRuntimeService
  return { runtime, cleanups, unexpected }
}
export function fixtureContext(runtime: OrcaRuntimeService, overrides: Partial<RpcContext> = {}): RpcContext {
  return { runtime, authenticatedCallerFingerprint: syntheticFingerprint, connectionId: 'synthetic-connection',
    requestId: 'synthetic-request', clientKind: 'mobile', pairedDeviceId: 'synthetic-device',
    clientCapabilities: [SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY], ...overrides }
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export async function eventually(predicate: () => boolean, timeout = 3000): Promise<void> {
  const end = Date.now() + timeout
  while (!predicate() && Date.now() < end) { await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.ok(predicate(), 'focused fixture condition did not arrive')
}
