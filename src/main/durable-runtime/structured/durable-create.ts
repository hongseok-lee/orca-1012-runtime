import { runDurableMutation, type MutationOutcome, type JsonValue } from '../db/atomic.ts'
import { DurableDatabaseError } from '../db/connection.ts'
import { reserveCatalogAgentSessionInTransaction } from '../catalog/agent-session.ts'
import { captureCatalogParsed } from '../catalog/immutable.ts'
import type { PreparedCatalogAgentSession } from '../catalog/agent-session.ts'
import type { CatalogOwnerEntries } from '../catalog/owners.ts'
import type { StructuredSessionAliasRow } from '../db/structured-session-rows.ts'
import { appendSessionEvent } from '../journal/store.ts'
import { counter } from '../../../shared/durable-runtime/identity.ts'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { structuredCounterToNumber } from './counters.ts'
import type { DurableStructuredCreateCall } from './durable-types.ts'
import { capturedJson, jsonValue, prepareDurableStructuredCall, structuredReceiptIdentity, requireHeldStructuredSession } from './durable-common.ts'

/** Only intent-create. The returned reservation is not a fabricated provider-bound history page. */
export async function createDurableStructuredSession(call: DurableStructuredCreateCall): Promise<MutationOutcome> {
  const { wire, authority } = prepareDurableStructuredCall(call, 'agentSession.create')
  if (wire.target.kind !== 'WORKTREE' || !wire.mutation) {
    throw new DurableDatabaseError('STRUCTURED_ATTACH_VERIFIER_REQUIRED')
  }
  const mutation = wire.mutation
  const configuration = capturedJson(call.configuration)
  // SAFETY: detached owner-typed configuration; not an authority issuer or DTO conversion.
  const prepared = captureCatalogParsed(configuration.reservation) as PreparedCatalogAgentSession
  const receiver = call.entries
  const entries: CatalogOwnerEntries = Object.freeze({
    recordUnitIntent: receiver.recordUnitIntent.bind(receiver),
    reserveSleep: receiver.reserveSleep.bind(receiver),
    recordInputCancel: receiver.recordInputCancel.bind(receiver)
  })
  const pool = call.pool
  const identity = structuredReceiptIdentity(wire, authority, jsonValue(mutation.semanticBody))
  return runDurableMutation(pool, { ...identity, locks: {} }, async tx => {
    // Configuration checks occur only for a new effect, after P103's original receipt replay.
    if (prepared.authority.principalId !== authority.principal ||
      prepared.publicSessionId !== mutation.publicSessionId || prepared.operationKey !== mutation.operationKey ||
      prepared.runtime.agent.provider !== wire.params.agent ||
      configuration.location.workspaceId !== prepared.workspace.public_id ||
      !configuration.location.executionHostId) {
      throw new DurableDatabaseError('STRUCTURED_CREATE_CONFIGURATION')
    }
    const original = prepared.originalRequest
    const originalFingerprint = computeAgentSessionPayloadFingerprint({
      method: 'agentSession.create', sessionId: mutation.publicSessionId,
      fields: { worktree: original.worktree, agent: original.agent, resumeFrom: original.resumeFrom }
    })
    if (originalFingerprint !== mutation.wireFingerprint) {
      throw new DurableDatabaseError('agent_session_operation_conflict')
    }
    const existing = await tx.query('SELECT session_id FROM durable_runtime.structured_session_aliases WHERE public_session_id=$1', [mutation.publicSessionId])
    if (existing.rowCount) {
      throw new DurableDatabaseError('STRUCTURED_PUBLIC_SESSION_CONFLICT')
    }
    const reservation = await reserveCatalogAgentSessionInTransaction(tx, prepared, entries)
    requireHeldStructuredSession(tx, reservation.sessionId)
    const alias = (await tx.query<StructuredSessionAliasRow>(
      `INSERT INTO durable_runtime.structured_session_aliases
       (public_session_id,session_id,workspace_id,provider,execution_host_id,location,original_create,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [mutation.publicSessionId, reservation.sessionId, prepared.workspace.workspace_id,
        prepared.runtime.agent.provider, configuration.location.executionHostId,
        JSON.stringify(configuration.location), JSON.stringify(mutation.semanticBody), authority.principal]
    )).rows[0]
    const event = await appendSessionEvent(tx, {
      sessionId: reservation.sessionId,
      source: { kind: 'PRODUCER', sourceKind: 'STRUCTURED_SESSION_CREATED',
        producerId: reservation.sessionId, incarnation: 'structured-create-v1', producerSeq: counter('sequence:producer', '1') },
      body: { kind: 'STRUCTURED_SESSION_CREATED', version: 1, publicSessionId: mutation.publicSessionId,
        sessionId: reservation.sessionId, workspaceId: prepared.workspace.workspace_id,
        agentId: prepared.runtime.agent.id, runtimeUnitId: prepared.runtime.unit.id,
        tabId: reservation.tabId, provider: prepared.runtime.agent.provider,
        originalCreate: jsonValue(mutation.semanticBody) }
    })
    const response: JsonValue = {
      version: 1, kind: 'STRUCTURED_SESSION_RESERVED', publicSessionId: mutation.publicSessionId,
      reservation: jsonValue(capturedJson(reservation)),
      alias: { publicSessionId: alias.public_session_id, sessionId: alias.session_id,
        workspaceId: alias.workspace_id, provider: alias.provider },
      event: { eventId: event.eventId, epoch: event.journalEpoch, sequence: event.sequence },
      fence: 1, cursor: { epoch: event.journalEpoch, sequence: structuredCounterToNumber(event.sequence, 1) }
    }
    return response
  })
}
