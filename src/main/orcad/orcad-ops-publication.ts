import { randomUUID } from 'node:crypto'
import type { RuntimeOpsHttpConfig } from '../durable-runtime/ops/runtime-config.ts'
import { OPS_REPLAY_STREAM } from '../durable-runtime/replay/types.ts'
import type { OpsReplayPassResult, OpsReplayPublicationWorker, OpsReplayWorkerConfig } from '../durable-runtime/replay/worker.ts'
import type { OrcadDurableCatalog } from './orcad-durable-catalog.ts'
import { invalidOrcadOpsConfig } from './orcad-ops-config.ts'

const policy = Object.freeze({ revision: 'ops-publication-v1', batchSize: 32, claimLeaseMs: 30000 })

/** Internal lifetime owner only. Pass results can contain claim identity and must not be logged or exposed over RPC. */
export type OrcadOpsPublicationOwner = OrcadDurableCatalog & Readonly<{
  startPublication(ops: Pick<RuntimeOpsHttpConfig, 'streamId' | 'pollIntervalMs'>): Promise<void>
  readonly lastResult: OpsReplayPassResult | null
  readonly lastFailure: OpsReplayPassResult | null
}>

/** The entry already stops RPC/subscriptions before this owner's stop. No Pool, SQL or retry loop is added here. */
export function ownOrcadOpsPublication(catalog: OrcadDurableCatalog): OrcadOpsPublicationOwner {
  const pool = catalog.readConfig.pool
  const stopCatalog = catalog.stop.bind(catalog)
  let worker: OpsReplayPublicationWorker | null = null
  let starting: Promise<void> | null = null
  let completion: Promise<void> | null = null
  let closing = false
  return Object.freeze({
    readConfig: catalog.readConfig,
    startPublication(ops: Pick<RuntimeOpsHttpConfig, 'streamId' | 'pollIntervalMs'>): Promise<void> {
      if (closing) { invalidOrcadOpsConfig('OPS_STARTUP_UNAVAILABLE') }
      if (starting) { return starting }
      // Capture the actual worker's entire input before the first await; this is not a HA lease identity.
      const config: OpsReplayWorkerConfig = Object.freeze({ owner: `${policy.revision}:${randomUUID()}`,
        streamId: OPS_REPLAY_STREAM, batchSize: policy.batchSize, claimLeaseMs: policy.claimLeaseMs,
        pollIntervalMs: ops.pollIntervalMs })
      const streamId = ops.streamId
      starting = Promise.resolve().then(async () => {
        if (streamId !== OPS_REPLAY_STREAM) { invalidOrcadOpsConfig('OPS_STARTUP_UNAVAILABLE') }
        const { createOpsReplayPublicationWorker } = await import('../durable-runtime/replay/worker.ts')
        if (closing) { return }
        worker = createOpsReplayPublicationWorker(pool, config)
        if (!worker.start()) { invalidOrcadOpsConfig('OPS_STARTUP_UNAVAILABLE') }
      }).catch(() => { invalidOrcadOpsConfig('OPS_STARTUP_UNAVAILABLE') })
      return starting
    },
    stop(): Promise<void> {
      closing = true
      completion ??= Promise.resolve().then(async () => {
        try {
          // A failed start remains the startup caller's failure; it cannot bypass original Pool cleanup.
          if (starting) { await starting.catch(() => undefined) }
          try { await worker?.stop() }
          catch { invalidOrcadOpsConfig('OPS_STARTUP_UNAVAILABLE') }
        } finally { await stopCatalog() }
      })
      return completion
    },
    get lastResult() { return worker?.lastResult ?? null },
    get lastFailure() { return worker?.lastFailure ?? null }
  })
}
