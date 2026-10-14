import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { logicalId } from '../../../shared/durable-runtime/identity.ts'
import { withDurableTransaction } from '../db/connection.ts'
import { lockAggregates } from '../db/locks.ts'
import { fixture, counts, response, instrumentPool } from '../input/verification-fixtures.mts'
import { pairedDeviceAttachmentPrincipal } from '../attachments/types.ts'
import { snapshotUnaryTerminalIngress } from './ingress'
import { snapshotBinaryTerminalIngress } from './binary-ingress'
import { readTerminalFloorInTransaction, claimTerminalFloorInTransaction } from './floor-repository'
import { readTerminalDraftInTransaction } from './draft-repository'
import { TerminalDraftStoreError } from './durable-contracts'
import type { ManagedTerminalIngressRequest, TerminalDraftAttachment, TerminalFloorAuthorization } from './durable-contracts'
import type { TerminalDraftBinding, TerminalIngressScope } from './types'
import { encodeTerminalStreamFrame, TerminalStreamOpcode } from '../../../shared/terminal-stream-protocol'

export { counts, response, instrumentPool }

export async function terminalFixture(pool: Pool) {
  // Reuse original Input fixture data setup, not its passed test suite or intake algorithm.
  const base = await fixture(pool)
  const sessionId = base.request.authority.sessionId
  const unitId = logicalId('runtime-unit', base.unitId)
  const deviceId = base.request.authority.principal.slice('paired-device:'.length)
  const connectionId = `fixture-connection-${randomUUID()}`
  const registeredConnections = new Set([connectionId])
  const actors = new Map([[deviceId, base.request.authority.principal]])
  const binding: TerminalDraftBinding = {
    pairedDeviceId: deviceId, principalId: base.request.authority.principal,
    logicalHandle: base.terminalHandle, sessionId, connectionId,
    floorGeneration: '0', mode: 'AGENT_CHAT_COMPAT'
  }
  // Explicit synthetic allowlist for this PG dataset only; no production authority issuer/factory.
  const floorAuthorization: TerminalFloorAuthorization = {
    assertClaimAllowed(next) {
      assert.equal(next.logicalHandle, base.terminalHandle)
      assert.equal(next.sessionId, sessionId)
      assert.equal(next.principalId, actors.get(next.pairedDeviceId))
      assert.ok(registeredConnections.has(next.connectionId))
    },
    assertReattachAllowed(previous, nextConnection) {
      assert.equal(previous.binding.logicalHandle, base.terminalHandle)
      assert.equal(previous.binding.sessionId, sessionId)
      assert.equal(previous.binding.principalId, actors.get(previous.binding.pairedDeviceId))
      assert.equal(registeredConnections.has(previous.binding.connectionId), false)
      assert.ok(registeredConnections.has(nextConnection))
    }
  }
  await withDurableTransaction(pool, async (tx) => {
    await lockAggregates(tx, { sessionIds: [sessionId] })
    await claimTerminalFloorInTransaction(tx, binding, null, floorAuthorization)
  })
  return { ...base, sessionId, unitId, binding, registeredConnections, actors, floorAuthorization }
}

export type DurableTerminalFixture = Awaited<ReturnType<typeof terminalFixture>>

export async function readStored(pool: Pool, f: DurableTerminalFixture, binding = f.binding) {
  return withDurableTransaction(pool, async (tx) => {
    await lockAggregates(tx, { sessionIds: [f.sessionId] })
    const floor = await readTerminalFloorInTransaction(tx, binding)
    const draft = await readTerminalDraftInTransaction(tx, binding)
    return { floor, draft }
  })
}

async function currentScope(pool: Pool, f: DurableTerminalFixture, binding: TerminalDraftBinding): Promise<TerminalIngressScope> {
  const stored = await readStored(pool, f, binding)
  assert.ok(stored.floor)
  return { binding, ingressId: randomUUID(), draftRevision: stored.draft?.draft.revision ?? '0',
    ptyIncarnationId: null, semanticAdapterRequired: false, stream: null }
}

function authorization(f: DurableTerminalFixture) {
  return {
    registeredConnections: f.registeredConnections,
    assertAuthenticatedOrigin(scope: TerminalIngressScope, origin: ManagedTerminalIngressRequest['origin']) {
      assert.equal(scope.binding.logicalHandle, f.terminalHandle)
      assert.equal(scope.binding.sessionId, f.sessionId)
      assert.equal(scope.binding.principalId, f.actors.get(scope.binding.pairedDeviceId))
      assert.equal(origin.authenticatedConnectionIncarnation, scope.binding.connectionId)
      if (!this.registeredConnections.has(scope.binding.connectionId)) {
        throw new TerminalDraftStoreError('FIXTURE_AUTH_CONNECTION')
      }
    }
  }
}

export async function unaryRequest(
  pool: Pool, f: DurableTerminalFixture, text: string, enter = false,
  attachments: readonly TerminalDraftAttachment[] = [], binding = f.binding
): Promise<ManagedTerminalIngressRequest> {
  const scope = await currentScope(pool, f, binding)
  const floor = (await readStored(pool, f, binding)).floor
  assert.ok(floor)
  const snapshot = snapshotUnaryTerminalIngress({ terminal: f.terminalHandle, text, enter,
    client: { id: 'fixture-payload-not-authority', type: 'mobile' } }, scope,
    attachments.map(({ attachmentId }) => ({ attachmentId })),
    (expected) => f.registeredConnections.has(expected.binding.connectionId))
  return { snapshot, origin: { kind: 'UNARY', authenticatedConnectionIncarnation: binding.connectionId,
    rpcRequestId: randomUUID() },
    authority: { principal: pairedDeviceAttachmentPrincipal(binding.pairedDeviceId),
      sessionId: f.sessionId, scope: { kind: 'TERMINAL', terminalHandle: f.terminalHandle } },
    sessionFence: f.request.sessionFence, expectedFloorRevision: floor.revision,
    attachments, authorization: authorization(f) }
}

export async function binaryRequest(
  pool: Pool, f: DurableTerminalFixture, bytes: Uint8Array,
  streamGeneration: string, binding = f.binding
): Promise<ManagedTerminalIngressRequest> {
  const current = await currentScope(pool, f, binding)
  const scope = { ...current, stream: { connectionId: binding.connectionId, streamId: 1,
    streamGeneration, ackMode: 'BYTES' as const } }
  const floor = (await readStored(pool, f, binding)).floor
  assert.ok(floor)
  const input = snapshotBinaryTerminalIngress(encodeTerminalStreamFrame({ opcode: TerminalStreamOpcode.Input,
    streamId: 1, seq: 0, payload: bytes }), scope, [],
    (expected) => f.registeredConnections.has(expected.binding.connectionId))
  assert.equal(input.kind, 'INPUT')
  if (input.kind !== 'INPUT') {
    throw new Error('Missing fixture Input snapshot')
  }
  return { snapshot: input.snapshot, origin: { kind: 'INGRESS',
    authenticatedConnectionIncarnation: binding.connectionId, ingressIdentity: scope.ingressId },
    authority: { principal: pairedDeviceAttachmentPrincipal(binding.pairedDeviceId), sessionId: f.sessionId,
      scope: { kind: 'TERMINAL', terminalHandle: f.terminalHandle } },
    sessionFence: f.request.sessionFence, expectedFloorRevision: floor.revision,
    attachments: [], authorization: authorization(f) }
}

export async function originalTexts(pool: Pool, f: DurableTerminalFixture): Promise<string[]> {
  const result = await pool.query(
    "SELECT body_or_blob_ref->'payload'->>'text' AS text FROM durable_runtime.input_components WHERE session_id=$1 ORDER BY input_seq",
    [f.sessionId]
  )
  return result.rows.map((row) => row.text)
}
