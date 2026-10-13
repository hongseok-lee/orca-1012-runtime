import type { Pool } from 'pg'
import type { AttemptId, ExecutionEpoch, RuntimeUnitId, RowRevision } from '../../../shared/durable-runtime/identity.ts'
import { counter } from '../../../shared/durable-runtime/identity.ts'
import type { MutationOutcome } from '../db/atomic.ts'
import type { PreparedCatalogCall } from './request.ts'
import { captureCatalogParsed } from './immutable.ts'
import { capturePreparedCatalogCall, lockCatalogWorkspaceMetadata, mutateCatalogWorkspace, publishCatalogMutation } from './mutation.ts'
import { loadCatalogTabs, resolveCatalogTab } from './metadata.ts'
import { CatalogError } from './errors.ts'

declare const trustedPhysicalEvidence: unique symbol
/** Issued/pinned by the physical observation owner; Catalog cannot manufacture it. */
export type PreparedCatalogBindingObservation = {
  readonly [trustedPhysicalEvidence]: true
  readonly workspaceSelector: string
  readonly publicTabId: string
  readonly publicationEpoch: string
  readonly expectedBindingRevision: RowRevision<'catalog-tab-binding'>
  readonly runtimeUnitId: RuntimeUnitId
  readonly attemptId: AttemptId
  readonly executionEpoch: ExecutionEpoch
  readonly podUid: string
  readonly terminalHandle: string
  readonly ptyId: string
  readonly incarnationId: string
  readonly kind: 'BOUND' | 'STOPPED'
  readonly evidenceRef: string
}

export interface CatalogPhysicalObservationAuthority {
  /** Synchronous check of already prepared local evidence; no I/O/issuer here. */
  isPinned(observation: PreparedCatalogBindingObservation): boolean
}

/** Logical CLOSED never changes back to OPEN. A bare RPC terminal string is insufficient. */
export async function applyCatalogBindingObservation(
  pool: Pool, input: PreparedCatalogCall<'session.tabs.closeLifecycle'>,
  prepared: PreparedCatalogBindingObservation, proof: CatalogPhysicalObservationAuthority
): Promise<MutationOutcome> {
  const call = capturePreparedCatalogCall(input)
  // Validate/pin the actual owner object before copying or awaiting. No string proof factory.
  const pinned = Object.isFrozen(prepared) && proof.isPinned(prepared) === true
  const observation = captureCatalogParsed(prepared) as PreparedCatalogBindingObservation
  if (!pinned || !observation.evidenceRef || !observation.podUid || !observation.ptyId || !observation.incarnationId ||
    call.params.worktree !== observation.workspaceSelector || call.params.publicationEpoch !== observation.publicationEpoch ||
    call.params.terminal !== observation.terminalHandle || observation.kind !== 'STOPPED') throw new CatalogError('CATALOG_PHYSICAL_PROOF_REQUIRED')
  return mutateCatalogWorkspace(pool, call, observation.workspaceSelector, async (tx, workspace, membership) => {
    await lockCatalogWorkspaceMetadata(tx, membership)
    const target = resolveCatalogTab(await loadCatalogTabs(tx, workspace.workspace_id), call.params)
    const head = (await tx.query<{ publication_epoch: string }>(
      'SELECT publication_epoch FROM durable_runtime.catalog_heads WHERE scope=$1', [`workspace:${workspace.workspace_id}`])).rows[0]
    if (head?.publication_epoch !== observation.publicationEpoch || target.public_tab_id !== observation.publicTabId ||
      target.terminal_handle !== observation.terminalHandle || target.binding_revision !== observation.expectedBindingRevision ||
      target.payload.incarnationId !== observation.incarnationId || target.payload.ptyId !== observation.ptyId) {
      throw new CatalogError('CATALOG_STALE_BINDING_OBSERVATION')
    }
    const tuple = (await tx.query(`SELECT a.id FROM durable_runtime.runtime_members m
      JOIN durable_runtime.runtime_units u ON u.id=m.runtime_unit_id
      JOIN durable_runtime.attempts a ON a.id=u.active_attempt_id AND a.runtime_unit_id=u.id AND a.execution_epoch=u.execution_epoch
      WHERE m.session_id=$1 AND u.id=$2 AND a.id=$3 AND u.execution_epoch=$4 AND a.pod_uid=$5`,
      [target.session_id, observation.runtimeUnitId, observation.attemptId, observation.executionEpoch, observation.podUid])).rows[0]
    if (!tuple) throw new CatalogError('CATALOG_STALE_BINDING_OBSERVATION')
    // Retire only the current physical binding. User close/lifecycle remains independent.
    const payload = { ...target.payload, ptyId: null, incarnationId: null, status: 'pending-handle', terminal: null }
    await tx.query(`UPDATE durable_runtime.catalog_tab_metadata SET payload=$2,binding_revision=binding_revision+1,
      updated_at=clock_timestamp() WHERE tab_id=$1 AND binding_revision=$3`,
      [target.tab_id, JSON.stringify(payload), observation.expectedBindingRevision])
    counter('row:catalog-tab-binding', BigInt(observation.expectedBindingRevision) + 1n)
    await publishCatalogMutation(tx, call, workspace.workspace_id, 'CATALOG_BINDING_RETIRED',
      { publicTabId: target.public_tab_id, evidenceRef: observation.evidenceRef })
    return { closed: true }
  })
}
