import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host.ts'
import type { AbortableInventoryTransport } from '../durable-runtime/ha/pass.ts'
import type { ControllerWorker, ControllerWorkerSnapshot } from '../durable-runtime/ha/worker.ts'
import type { ResourceWatchEvent } from '../durable-runtime/lifecycle/watch.ts'
import { captureDurableCatalogReadConfig } from '../durable-runtime/rpc/config.ts'
import type { OrcadDurableCatalog } from './orcad-durable-catalog.ts'
import { captureOrcadControllerConfig, invalidOrcadControllerConfig, OrcadControllerConfigurationError,
  type OrcadControllerConfig } from './orcad-controller-config.ts'

export type OrcadControllerObservation = Readonly<{
  source: 'LIST' | 'WATCH'
  type: ResourceWatchEvent['type']
  resourceVersion: string
  observedAt: string
  counts: Readonly<{ total: number; list: number; watch: number }>
  resource: Readonly<{ namespace: string; name: string; uid: string; unitId: string; operationId: string;
    executionEpoch: string; specHash: string }> | null
}>
export type OrcadControllerSnapshot = Readonly<{
  worker: ControllerWorkerSnapshot | null
  latestObservation: OrcadControllerObservation | null
  lastFailure: Readonly<{ stage: 'START' | 'STOP' | 'INVENTORY'; code: string }> | null
}>
export type OrcadControllerOwner = OrcadDurableCatalog & Readonly<{
  startController(config: OrcadControllerConfig): Promise<void>
  controllerSnapshot(): OrcadControllerSnapshot
}>

// Local bytes only, no download, exec plugin, env credential, or outward bytes accessor.
// Following a projected token/CA symlink is intentional: the private JSON has a different NOFOLLOW boundary.
function credential(path: string, kind: 'CA' | 'TOKEN'): Buffer {
  const code = `CONTROLLER_STARTUP_${kind}_FILE`, limit = 1024 * 1024
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const before = fstatSync(fd)
    if (!before.isFile() || before.size < 1 || before.size > limit) { invalidOrcadControllerConfig(code) }
    const buffer = Buffer.alloc(limit + 1)
    let used = 0, count: number
    do { count = readSync(fd, buffer, used, buffer.length - used, null); used += count } while (count && used < buffer.length)
    if (!used || used > limit) { invalidOrcadControllerConfig(code) }
    return Buffer.from(buffer.subarray(0, used))
  } catch (error) {
    if (error instanceof OrcadControllerConfigurationError) { throw error }
    return invalidOrcadControllerConfig(code)
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { invalidOrcadControllerConfig(code) } }
  }
}

/** Real PR58 transport, with owned file readers. Raw CA/token bytes never enter snapshots/errors or an exported accessor. */
export async function prepareOrcadControllerInventory(input: OrcadControllerConfig): Promise<AbortableInventoryTransport> {
  const config = captureOrcadControllerConfig(input)
  const ca = Buffer.from(credential(config.inventory.caFile, 'CA'))
  try {
    const { createKubernetesInventoryTransport } = await import('../durable-runtime/lifecycle/kubernetes-inventory.ts')
    const transport = createKubernetesInventoryTransport({ ...config.inventory, ca,
      readBearerToken(signal) {
        if (signal.aborted) { invalidOrcadControllerConfig('CONTROLLER_INVENTORY_ABORTED') }
        // Read the current projected symlink target for every actual HTTP request. Never retain the prior token.
        const token = credential(config.inventory.tokenFile, 'TOKEN').toString('utf8').trim()
        if (signal.aborted) { invalidOrcadControllerConfig('CONTROLLER_INVENTORY_ABORTED') }
        if (!/^[A-Za-z0-9\-._~+/]+=*$/u.test(token)) { invalidOrcadControllerConfig('CONTROLLER_INVENTORY_TOKEN_FAILED') }
        return token
      } })
    async function guarded<T>(action: () => Promise<T>): Promise<T> {
      try { return await action() }
      catch { return invalidOrcadControllerConfig('CONTROLLER_INVENTORY_UNAVAILABLE') }
    }
    return Object.freeze({
      list: (signal: AbortSignal) => guarded(() => transport.list(signal)),
      watch: (version: string, signal: AbortSignal) => guarded(() => transport.watch(version, signal)),
      get: (namespace: string, name: string, signal: AbortSignal) => guarded(() => transport.get(namespace, name, signal))
    })
  } catch (error) {
    if (error instanceof OrcadControllerConfigurationError) { throw error }
    return invalidOrcadControllerConfig('CONTROLLER_INVENTORY_UNAVAILABLE')
  }
}

/** Wrap the original Pool owner before validation/I/O. Entry cleanup runs RPC first; publication wraps this owner outside. */
export function ownOrcadController(catalog: OrcadDurableCatalog): OrcadControllerOwner {
  const readConfig = catalog.readConfig, stopCatalog = catalog.stop.bind(catalog)
  let worker: ControllerWorker | null = null, closing = false
  let starting: Promise<void> | null = null, completion: Promise<void> | null = null
  let latestObservation: OrcadControllerObservation | null = null
  let lastFailure: OrcadControllerSnapshot['lastFailure'] = null
  let total = 0, list = 0, watch = 0
  return Object.freeze({
    readConfig,
    startController(input: OrcadControllerConfig): Promise<void> {
      if (closing) { invalidOrcadControllerConfig('CONTROLLER_STARTUP_CLOSED') }
      if (starting) { return starting }
      // Own all values, the original host-check receiver and Pool before the first await.
      const config = captureOrcadControllerConfig(input)
      let captured: ReturnType<typeof captureDurableCatalogReadConfig>
      try { captured = captureDurableCatalogReadConfig(readConfig) }
      catch { return invalidOrcadControllerConfig('CONTROLLER_STARTUP_CATALOG') }
      starting = Promise.resolve().then(async () => {
        if (closing) { return }
        const [{ createControllerWorker }, { CONTROLLER_SCOPE, CONTROLLER_DATASET }, { LIFECYCLE_CONTROLLER_SCOPE }] = await Promise.all([
          import('../durable-runtime/ha/worker.ts'), import('../durable-runtime/ha/instance.ts'), import('../durable-runtime/lifecycle/intent.ts')
        ])
        if (closing) { return }
        if (CONTROLLER_SCOPE !== LIFECYCLE_CONTROLLER_SCOPE || config.datasetName !== CONTROLLER_DATASET ||
            captured.datasetName !== config.datasetName || captured.hostId !== LOCAL_EXECUTION_HOST_ID) {
          invalidOrcadControllerConfig('CONTROLLER_STARTUP_CATALOG')
        }
        captured.assertCurrentHost()
        const transport = await prepareOrcadControllerInventory(config)
        // Dataset 전체 queue 소비를 서버가 명시적으로 선택합니다. 원 transaction에서 claim 뒤 payload를 검증합니다.
        // Payload 없는 head로 kind를 추정하거나 새 권한을 만들지 않습니다.
        const selectedEventWork = config.structuredOutput ? Object.freeze({
          handler: (await import('../durable-runtime/events/structured-output.ts')).structuredOutputEventHandler,
          options: Object.freeze({ claimDurationMs: config.structuredOutput.claimDurationMs })
        }) : null
        if (closing) { return }
        captured.assertCurrentHost()
        // Plan/execute/lookup 대체 callback이나 별도 queue 소비 loop는 만들지 않습니다.
        worker = createControllerWorker(captured.pool, config.policy, {
          ...(selectedEventWork ? { eventWork: () => selectedEventWork } : {}), inventory: { transport,
          async sink(event, source) {
            if (closing) { return }
            captured.assertCurrentHost()
            total++; if (source === 'LIST') { list++ } else { watch++ }
            const object = event.type === 'BOOKMARK' ? null : event.object
            latestObservation = Object.freeze({ source, type: event.type,
              resourceVersion: event.type === 'BOOKMARK' ? event.resourceVersion : event.object.resourceVersion,
              observedAt: new Date().toISOString(), counts: Object.freeze({ total, list, watch }),
              resource: object ? Object.freeze({ namespace: object.namespace, name: object.name, uid: object.uid,
                unitId: object.unitId, operationId: object.operationId, executionEpoch: object.executionEpoch, specHash: object.specHash }) : null })
          } } })
        if (!worker.start()) { invalidOrcadControllerConfig('CONTROLLER_STARTUP_WORKER_REJECTED') }
      }).catch(error => {
        const code = error instanceof OrcadControllerConfigurationError ? error.code : 'CONTROLLER_STARTUP_UNAVAILABLE'
        lastFailure = Object.freeze({ stage: 'START', code })
        return invalidOrcadControllerConfig(code)
      })
      return starting
    },
    stop(): Promise<void> {
      closing = true
      completion ??= Promise.resolve().then(async () => {
        try {
          if (starting) { await starting.catch(() => undefined) }
          try { await worker?.stop() }
          catch {
            lastFailure = Object.freeze({ stage: 'STOP', code: 'CONTROLLER_STOP_UNAVAILABLE' })
            invalidOrcadControllerConfig('CONTROLLER_STOP_UNAVAILABLE')
          }
        } finally { await stopCatalog() }
      })
      return completion
    },
    controllerSnapshot(): OrcadControllerSnapshot { return Object.freeze({ worker: worker?.snapshot() ?? null, latestObservation, lastFailure }) }
  })
}
