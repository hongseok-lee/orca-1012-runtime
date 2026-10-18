import type { Pool } from 'pg'
import type { ControllerPassRequest } from '../durable-runtime/ha/pass.ts'
import { listOrphanCandidates, observeAgentPod, reconcileOrphanedAttempt } from '../durable-runtime/runtime/orphan-reconcile.ts'
import type { OrcadControllerConfig } from './orcad-controller-config.ts'
import { readOrcadControllerCredential } from './orcad-controller-credential.ts'

export type OrcadOrphanReconcileSnapshot = Readonly<{ passes: number; reconciled: number; skipped: number; lastError: string | null }>

/** Controller-pass hook. Every active attempt whose Agent Pod name is absent,
 * or now names another UID, is revoked under the pass's own controller term.
 * An unknown observation reconciles nothing and is retried on a later pass. */
export function prepareOrcadOrphanReconcile(pool: Pool, config: OrcadControllerConfig, ca: Uint8Array) {
  const caBytes = Buffer.from(ca)
  let passes = 0, reconciled = 0, skipped = 0, lastError: string | null = null
  const reconcileOrphans: NonNullable<ControllerPassRequest['reconcileOrphans']> = async (signal, controller) => {
    passes++
    let handled = 0
    for (const candidate of await listOrphanCandidates(pool)) {
      if (signal.aborted) { break }
      const reviewer = readOrcadControllerCredential(config.inventory.tokenFile, 'TOKEN').toString('utf8').trim()
      const observed = await observeAgentPod({ apiOrigin: config.inventory.apiOrigin, ca: caBytes,
        namespace: config.inventory.namespace, reviewer }, candidate, signal)
      if (observed.state !== 'GONE') { skipped++; continue }
      const result = await reconcileOrphanedAttempt(pool, { scope: controller.scope, owner: controller.owner, term: controller.term },
        candidate, observed, controller.owner)
      if (result.ok && !result.cleanupFailed) { handled++; reconciled++ } else { lastError = result.ok ? 'CLEANUP' : String(result.error) }
    }
    return handled
  }
  return Object.freeze({ reconcileOrphans,
    snapshot: (): OrcadOrphanReconcileSnapshot => Object.freeze({ passes, reconciled, skipped, lastError }) })
}
