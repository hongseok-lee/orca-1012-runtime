import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { counter, logicalId } from '../../../shared/durable-runtime/identity.ts'
import type { SessionId } from '../../../shared/durable-runtime/identity.ts'
import { DurableDatabaseError, runDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { appendAudit } from '../journal/store.ts'
import { currentAuthoritySql } from './gateway/authority.ts'
import type { DurableTransaction } from '../db/connection.ts'
import { DurableCodexDriver } from '../providers/codex/driver.ts'
import { ClaudeDurableProvider } from '../providers/claude/driver.ts'
import { agentClaudeTransport } from './agent-claude-transport.ts'
import { settleOrphanedTurn } from './orphaned-turn-settlement.ts'
import type { CodexProtocolDependencies } from '../providers/codex/protocol.ts'
import type { ProviderDispatchRequest, ProviderDispatchResult, ProviderObservationSink, ReadyProviderBinding } from '../providers/shared/contracts.ts'
import { immutableSnapshot } from '../providers/shared/immutable-snapshot.ts'
import type { createAgentCodexTransport, AdoptedAgentControl } from './agent-codex-transport.ts'
import { createAdoptedDispatchPermit } from './adopted-dispatch-permit.ts'
import type { ExecutorId, GatewayContext } from './gateway/types.ts'
import type { PodUid, ProviderRef, RuntimeReference, VerifiedWorkloadIdentity } from './runtime-evidence.ts'

const deny = (suffix: string): never => { throw new DurableDatabaseError(`ADOPTED_CODEX_${suffix}`) }
type Transport = ReturnType<typeof createAgentCodexTransport>
export type AdoptedCodexTarget = Readonly<{
  attemptId: string; runtimeUnitId: string; operationId: string; podName: string; podUid: string
  executionEpoch: string; specHash: string; agentId: string
  /** Bundle the recorded host runs; null for hosts recorded before migration 025. */
  controlSha256: string | null
}>
export type AdoptedCodexExecutorConfiguration = Readonly<{
  sessionId: SessionId
  executorId: ExecutorId
  /** Trusted composition: the same concrete transport config the cold path used for this Pod. */
  deployment(target: AdoptedCodexTarget): Promise<Readonly<{ transport: Transport; checkout: string; nativeOptions: Readonly<Record<string, string>> }>>
  /** Highest notification sequence already in the output spool for this connection. */
  journaledSequence(connectionId: string): number
  sink: ProviderObservationSink
  onNativeNotification?: CodexProtocolDependencies['onNativeNotification']
  onReady?(): void
  /** Absent means Codex. */
  provider?: 'claude'
}>
type Row = { attempt_id: string; runtime_unit_id: string; pod_uid: string; execution_epoch: string; incarnation: string
  control_id: string; control_pid: number; control_start_ticks: string; root_device: string; root_inode: string
  connection_instance_id: string; control_sha256: string | null; operation_id: string; resource_name: string; spec_hash: string; tab_id: string
  terminal_handle: string; provider_binding_revision: string; agent_id: string; native_session_ref: string | null
  producer_id: string | null; producer_incarnation: string | null }

/** Takes over a READY Codex provider that an earlier backend process started,
 * by re-attaching to its recorded Pod-local control host. It never creates a
 * Pod, control, native process, thread or writer grant; when the recorded
 * control is gone it fails and leaves the attempt to orphan reconciliation. */
export function createAdoptedCodexExecutor(pool: Pool, original: AdoptedCodexExecutorConfiguration) {
  const selected = immutableSnapshot({ sessionId: original.sessionId, executorId: original.executorId })
  const deployment = original.deployment.bind(original), journaled = original.journaledSequence.bind(original)
  const sink = original.sink.bind(original), onReady = original.onReady?.bind(original)
  const onNativeNotification = original.onNativeNotification?.bind(original)
  let used = false, phase = 'UNUSED'
  let driver: DurableCodexDriver | ClaudeDurableProvider | null = null, ready: ReadyProviderBinding | null = null
  const provider = original.provider ?? 'codex'
  let control: AdoptedAgentControl | null = null, context: GatewayContext | null = null
  let workload: VerifiedWorkloadIdentity | null = null
  const own = new Set<string>()
  async function dispatch(originalContext: GatewayContext, originalRequest: ProviderDispatchRequest,
    commitGuard?: (tx: DurableTransaction) => Promise<void>): Promise<ProviderDispatchResult> {
    const supplied = immutableSnapshot(originalContext), request = immutableSnapshot(originalRequest)
    const native = ready, activeDriver = driver, adopted = control, owner = context?.controller
    if (!native || !activeDriver || !adopted || !owner || !activeDriver.ownsReadyBinding(native) || !adopted.valid() ||
        supplied.runtimeUnitId !== native.runtimeUnitId || supplied.controller.scope !== owner.scope ||
        supplied.controller.owner !== owner.owner || supplied.controller.term !== owner.term) { return deny('DISPATCH_OWNER') }
    const effect = createAdoptedDispatchPermit(pool, supplied, { kind: 'DISPATCH', binding: native,
      commandClaim: request.commandClaim, messageId: request.sealed.messageId, deliveryAttemptId: request.deliveryAttemptId,
      sealedRevision: request.sealed.sealedRevision, sealedPayloadHash: request.sealed.payloadHash,
      contextRevision: request.context.revision, contextHash: request.context.hash }, adopted, commitGuard)
    own.add(request.deliveryAttemptId)
    return activeDriver.dispatch(request, effect.permit)
  }
  return Object.freeze({
    phase: () => phase,
    current: () => ready && driver?.ownsReadyBinding(ready) && control?.valid() && context && workload
      ? Object.freeze({ binding: ready, driver, context, executorId: selected.executorId, dispatch,
        protection: Object.freeze({ takePreparedProtection: () => Object.freeze({ workloadIdentity: workload! }) }) }) : null,
    async adopt(controller: GatewayContext['controller']): Promise<void> {
      if (used) { return deny('ALREADY_USED') }
      used = true
      try {
        phase = 'READ_RECORD'
        const found = await pool.query<Row>(`SELECT a.id AS attempt_id,a.runtime_unit_id,a.pod_uid,a.execution_epoch::text,a.incarnation,
          h.control_id,h.control_pid,h.control_start_ticks,h.root_device,h.root_inode,h.connection_instance_id,h.control_sha256,
          p.operation_id,p.resource_name,p.spec_hash,t.id AS tab_id,t.terminal_handle,s.provider_binding_revision::text,s.agent_id,
          (SELECT e.next_state->'providerRef'->>'nativeSessionRef' FROM durable_runtime.runtime_audit_events e
            WHERE e.kind='INITIAL_PROVIDER_READY' AND e.next_state->>'attemptId'=a.id::text ORDER BY e.occurred_at DESC LIMIT 1) AS native_session_ref,
          r.producer_id,r.incarnation AS producer_incarnation
          FROM durable_runtime.sessions s JOIN durable_runtime.runtime_members m ON m.session_id=s.id
          JOIN durable_runtime.runtime_units u ON u.id=m.runtime_unit_id JOIN durable_runtime.attempts a ON a.id=u.active_attempt_id
          JOIN durable_runtime.agent_control_hosts h ON h.attempt_id=a.id AND h.provider=$2
          JOIN durable_runtime.agent_pod_plans p ON p.attempt_id=a.id
          JOIN durable_runtime.tabs t ON t.session_id=s.id AND t.kind='terminal' AND t.lifecycle='OPEN'
          LEFT JOIN durable_runtime.runtime_event_producers r ON r.attempt_id=a.id
          WHERE s.id=$1 AND s.lifecycle='OPEN' AND u.phase='READY' AND a.status='READY' AND a.stopped_at IS NULL`, [selected.sessionId, provider])
        if (found.rowCount !== 1 || !found.rows[0].native_session_ref) { return deny('NO_ADOPTABLE_RECORD') }
        const row = found.rows[0], nativeSessionRef = found.rows[0].native_session_ref
        phase = 'DEPLOYMENT'
        const prepared = await deployment(Object.freeze({ attemptId: row.attempt_id, runtimeUnitId: row.runtime_unit_id,
          operationId: row.operation_id, podName: row.resource_name, podUid: row.pod_uid, executionEpoch: row.execution_epoch,
          specHash: row.spec_hash, agentId: row.agent_id, controlSha256: row.control_sha256 }))
        const identity = Object.freeze({ controlId: row.control_id, pid: row.control_pid, startTicks: row.control_start_ticks,
          device: row.root_device, inode: row.root_inode })
        const adoption: { current: ReturnType<Transport['adopt']> | null } = { current: null }
        // Replay starts after what is already journaled in PG as well as in the
        // local spool: a new owner's spool may be empty, and a frame journaled
        // twice under one source key conflicts and stops the session's queue.
        const stored = await pool.query<{ last: string | null }>(`SELECT max((body->'notification'->>'sequence')::bigint)::text AS last
          FROM durable_runtime.session_events WHERE session_id=$1 AND body->>'kind'='TERMINAL_CODEX_NOTIFICATION'
          AND body->'notification'->>'connectionId'=$2`, [selected.sessionId, row.connection_instance_id])
        const lastSeq = Math.max(journaled(row.connection_instance_id), Number(stored.rows[0]?.last ?? 0))
        // This private cast follows the recorded native session of the READY audit.
        const providerRef: ProviderRef = Object.freeze({ provider, nativeSessionRef: nativeSessionRef as RuntimeReference<'provider-session'> })
        const binding: ReadyProviderBinding = immutableSnapshot({ sessionId: selected.sessionId, tabId: logicalId('tab', row.tab_id),
          terminalHandle: row.terminal_handle, providerBindingRevision: counter('row:provider-binding', row.provider_binding_revision),
          runtimeUnitId: logicalId('runtime-unit', row.runtime_unit_id), attemptId: logicalId('attempt', row.attempt_id),
          podUid: row.pod_uid as PodUid, executionEpoch: counter('execution-epoch', row.execution_epoch),
          connectionInstanceId: row.connection_instance_id, providerRef })
        // Completion of a turn the lost owner admitted is recorded here (live or replayed).
        const notify: typeof onNativeNotification = notification => {
          onNativeNotification?.(notification)
          void settleOrphanedTurn(pool, binding as ReadyProviderBinding, notification, own).catch(() => { /* retried by the next completion or recovery */ })
        }
        const attach = async (handlers: Parameters<Transport['adopt']>[2]) => {
          adoption.current = prepared.transport.adopt(identity, lastSeq, handlers)
          control = await adoption.current.ready
          return control.connection
        }
        let adopted: ReadyProviderBinding
        phase = 'ATTACH'
        if (provider === 'claude') {
          // The Claude process is alive in the Pod: re-attach and replay, nothing to resume.
          const claudeDriver = new ClaudeDurableProvider(() => Promise.reject(new Error('ADOPTED_CLAUDE_NO_COLD')), sink, row.connection_instance_id)
          driver = claudeDriver
          adopted = await claudeDriver.adopt(binding, agentClaudeTransport({ controlId: row.control_id,
            frameSequence: () => adoption.current?.frameSequence() ?? 0 }, attach, notify))
        } else {
          const codexDriver = new DurableCodexDriver({
            open: () => Promise.reject(new Error('ADOPTED_CODEX_NO_COLD')), onNativeNotification: notify,
            connectionId: row.connection_instance_id, frameSequence: () => adoption.current?.frameSequence() ?? 0, attach }, sink)
          driver = codexDriver
          adopted = await codexDriver.adopt(binding, prepared.checkout, prepared.nativeOptions)
        }
        if (!control || control.pod.pod.uid !== row.pod_uid) { return deny('ATTACHED_POD') }
        // Same shape as controlledWorkloadIdentity of the cold owner; the
        // producer stays the control's, so its event stream continues.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: re-authenticated Pod (TokenReview on ATTACH) of this exact attempt.
        workload = Object.freeze({ attemptId: binding.attemptId, podUid: binding.podUid, executionEpoch: binding.executionEpoch,
          incarnation: row.producer_incarnation ?? row.incarnation, producerId: row.producer_id ?? logicalId('producer', row.control_id),
          principalRef: `kubernetes-service-account:${control.pod.namespace}:${control.pod.serviceAccount.uid}`,
          authenticationEvidenceRef: `kubernetes-pod-auth:sha256:${control.pod.evidenceDigest}` }) as unknown as VerifiedWorkloadIdentity
        // Input delivery is anchored on the provider's original operation under
        // the CURRENT controller term, as lifecycle reconcile adopts operations.
        phase = 'OPERATION_ADOPTION'
        const owned = await runDurableTransaction(pool, async tx => {
          await lockAggregates(tx, { runtimeUnitIds: [binding.runtimeUnitId] })
          const auth = [controller.scope, controller.owner, controller.term]
          const before = await tx.query<{ controller_term: string }>('SELECT controller_term::text FROM durable_runtime.operations WHERE id=$1 AND runtime_unit_id=$2',
            [row.operation_id, row.runtime_unit_id])
          if (before.rowCount !== 1) { return deny('OPERATION_MISSING') }
          if (before.rows[0].controller_term === String(controller.term)) { return true }
          const moved = await tx.query(`UPDATE durable_runtime.operations SET controller_term=$3,revision=revision+1
            WHERE id=$4 AND runtime_unit_id=$5 AND controller_term<>$3 AND ${currentAuthoritySql} RETURNING id`,
          [...auth, row.operation_id, row.runtime_unit_id])
          if (moved.rowCount !== 1) { return deny('OPERATION_ADOPTION_STALE') }
          const event = { kind: 'RECONCILE_OPERATION_ADOPTED', operationId: row.operation_id, previousTerm: before.rows[0].controller_term,
            controllerTerm: String(controller.term), reason: 'PROVIDER_ADOPTED', attemptId: row.attempt_id, controlId: row.control_id }
          await appendAudit(tx, { actorId: 'orca-adopted-codex-runtime', runtimeUnitId: row.runtime_unit_id, attemptId: row.attempt_id,
            podUid: row.pod_uid, sessionId: selected.sessionId, operationId: row.operation_id, kind: event.kind, nextState: event,
            occurredAt: new Date(), receivedAt: new Date(), producerId: randomUUID(), producerSeq: counter('sequence:producer', '1'), evidenceRefs: [] })
          return true
        })
        if (!owned.ok || owned.commitOutcome !== 'ACKNOWLEDGED' || owned.cleanupFailed) { return deny('OPERATION_ADOPTION_UNCONFIRMED') }
        context = Object.freeze({ runtimeUnitId: binding.runtimeUnitId, operationId: logicalId('operation', row.operation_id), controller })
        ready = adopted; phase = 'READY'
        onReady?.()
      } catch (error) {
        phase = 'ADOPT_FAILED'
        throw error
      }
    },
  })
}
