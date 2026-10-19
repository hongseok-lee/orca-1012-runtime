import type { RpcContext } from '../../runtime/rpc/core.ts'
import type { CapturedCatalogReadConfig } from './config.ts'
import type { TerminalRuntimeLookup } from '../input/runtime-input-types.ts'
import { withDurableTransaction } from '../db/connection.ts'
import { TerminalDraftStoreError } from '../terminal/durable-contracts.ts'
import { resolveCatalogTerminalTarget } from './terminal-target.ts'
import { borrowTerminalRuntimeReader } from '../runtime/terminal-runtime-reader.ts'

/** Read authority is checked against Catalog scope and the actual active
 * execution. Looking up an in-memory owner does not certify either. */
export function createCatalogTerminalRuntimeReader(config: CapturedCatalogReadConfig, context: RpcContext,
  terminal: string, target: NonNullable<Awaited<ReturnType<typeof resolveCatalogTerminalTarget>>>,
  lookup: TerminalRuntimeLookup) {
  const assertHost = () => {
    config.assertCurrentHost()
    if (context.signal?.aborted) { throw new TerminalDraftStoreError('TERMINAL_SUBSCRIPTION_ABORTED') }
  }
  return borrowTerminalRuntimeReader(target.sessionId, lookup, async port => {
    assertHost()
    await withDurableTransaction(config.pool, async tx => {
      const fresh = await resolveCatalogTerminalTarget(tx, config, context, terminal, assertHost)
      if (!fresh || fresh.lifecycle !== 'OPEN' || fresh.chat || fresh.sessionId !== target.sessionId ||
          fresh.sessionFence !== target.sessionFence || fresh.targetPin.tabId !== target.targetPin.tabId ||
          fresh.targetPin.tabRevision !== target.targetPin.tabRevision) {
        throw new TerminalDraftStoreError('TERMINAL_CATALOG_TARGET_CHANGED')
      }
      const b = port.binding, c = port.context.controller
      const active = await tx.query(`SELECT 1 FROM durable_runtime.sessions s
        JOIN durable_runtime.runtime_members m ON m.session_id=s.id
        JOIN durable_runtime.runtime_units u ON u.id=m.runtime_unit_id
        JOIN durable_runtime.attempts a ON a.id=u.active_attempt_id AND a.runtime_unit_id=u.id
        JOIN durable_runtime.agent_control_hosts h ON h.attempt_id=a.id
        JOIN durable_runtime.tabs t ON t.session_id=s.id
        WHERE s.id=$1 AND s.lifecycle='OPEN' AND s.session_fence=$2 AND s.provider_binding_revision=$3
        AND u.id=$4 AND u.phase='READY' AND u.execution_epoch=$5
        AND a.id=$6 AND a.pod_uid=$7 AND a.execution_epoch=$5 AND a.status='READY' AND a.stopped_at IS NULL
        AND h.connection_instance_id=$8 AND t.id=$9 AND t.terminal_handle=$10 AND t.lifecycle='OPEN'
        AND EXISTS(SELECT 1 FROM durable_runtime.controller_leases l
          WHERE l.scope=$11 AND l.owner=$12 AND l.term=$13 AND l.expires_at>clock_timestamp())`,
      [target.sessionId, target.sessionFence, b.providerBindingRevision, b.runtimeUnitId, b.executionEpoch,
        b.attemptId, b.podUid, b.connectionInstanceId, b.tabId, terminal, c.scope, c.owner, c.term])
      if (active.rowCount !== 1) { throw new TerminalDraftStoreError('TERMINAL_RUNTIME_UNAVAILABLE') }
      assertHost()
    })
    assertHost()
  })
}
