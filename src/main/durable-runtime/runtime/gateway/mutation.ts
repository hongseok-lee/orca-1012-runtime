import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ProducerId, Sequence, SessionId } from '../../../../shared/durable-runtime/identity.ts';
import { logicalId } from '../../../../shared/durable-runtime/identity.ts';
import { runDurableMutation, type MutationOutcome, type ReceiptIdentity } from '../../db/atomic.ts';
import { DurableDatabaseError, withDurableTransaction } from '../../db/connection.ts';
import { appendAudit, appendSessionEvent, enqueueOutbox } from '../../journal/store.ts';
import type { ExternalCommandIdentity } from '../command-types.ts';
import { LockedGatewayAuthority } from './authority.ts';
import { claimCommand, markCommandUnknown, reconcileCommand, settleOwnedExecution } from './claim.ts';
import { canonicalInput, inputDigest } from './input.ts';
import { lookupCommand, originalIdentity, submitCommand, takeOverCommand } from './store.ts';
import type {
  CommandClaim, CommandRow, ExecutorId, GatewayContext, JsonValue,
  SubmitCommand, TerminalOutcome, VerifiedCommandReconciliation,
} from './types.ts';

export type GatewayMutationAction =
  | { readonly kind: 'SUBMIT'; readonly request: SubmitCommand }
  | { readonly kind: 'TAKE_OVER'; readonly original: ExternalCommandIdentity }
  | { readonly kind: 'CLAIM'; readonly original: ExternalCommandIdentity; readonly executorId: ExecutorId }
  | { readonly kind: 'UNKNOWN'; readonly claim: CommandClaim }
  | { readonly kind: 'SETTLE'; readonly claim: CommandClaim; readonly outcome: TerminalOutcome }
  | { readonly kind: 'RECONCILE'; readonly verified: VerifiedCommandReconciliation };

export interface GatewayMutationRequest {
  readonly context: GatewayContext;
  // Same key and same input on retry, including when COMMIT is uncertain.
  readonly mutationKey: string;
  readonly action: GatewayMutationAction;
  readonly sessionIds: readonly SessionId[];
  readonly observation: {
    readonly producerId: ProducerId;
    readonly producerSeq: Sequence<'producer'>;
    readonly occurredAt: Date;
    readonly receivedAt: Date;
  };
}

function originalFor(action: GatewayMutationAction): ExternalCommandIdentity {
  if (action.kind === 'SUBMIT') return {
    command: action.request.command, originalEnvelope: action.request.envelope, inputHash: action.request.inputHash,
  };
  if (action.kind === 'TAKE_OVER' || action.kind === 'CLAIM') return action.original;
  if (action.kind === 'RECONCILE') return action.verified.original;
  return action.claim.identity;
}

function jsonDomain(value: unknown): JsonValue {
  // SQL receipt/domain JSON only; no response/log contains unfiltered object
  // keys such as private identity brands or Date/class instances.
  return JSON.parse(JSON.stringify(value));
}

function receiptIdentity(request: GatewayMutationRequest): ReceiptIdentity {
  const { context, action } = request;
  if (!request.mutationKey || originalFor(action).originalEnvelope.operationId !== context.operationId) {
    throw new DurableDatabaseError('COMMAND_MUTATION_IDENTITY');
  }
  return {
    key: {
      principalId: context.controller.owner, sessionScope: `runtime-unit:${context.runtimeUnitId}`,
      method: `internal-runtime-command.${action.kind}`, operationKey: request.mutationKey,
    },
    payloadHash: inputDigest(jsonDomain({
      context, action, sessionIds: [...new Set(request.sessionIds)].sort(),
      producerId: request.observation.producerId, producerSeq: request.observation.producerSeq,
    })),
  };
}

function response(disposition: string, row: CommandRow | null, claim?: CommandClaim): JsonValue {
  // Protected internal receipt may carry the claim token; it is not placed in
  // audit/outbox/journal or ordinary logs. This is not a public RPC method.
  return jsonDomain({ disposition, command: row === null ? null : {
    id: row.id, state: row.state, identity: originalIdentity(row), ownerControllerTerm: row.owner_controller_term,
    revision: row.revision, result: row.result, refusalCode: row.refusal_code,
  }, ...(claim ? { claim } : {}) });
}

export async function runGatewayCommandMutation(
  pool: Pool, request: GatewayMutationRequest,
): Promise<{ readonly identity: ReceiptIdentity; readonly mutation: MutationOutcome }> {
  const identity = receiptIdentity(request);
  const original = originalFor(request.action);
  const { context } = request;
  const sessionIds = [...new Set(request.sessionIds)].sort();
  const mutation = await runDurableMutation(pool, {
    ...identity, locks: { sessionIds, runtimeUnitIds: [context.runtimeUnitId], operationIds: [context.operationId] },
  }, async (tx) => {
    // Requires DB-owner held-row reentry correction; original rank order is
    // unchanged. Never emulate/reset the shared lock tracker here.
    const authority = await LockedGatewayAuthority.acquire(tx, context);
    for (const sessionId of sessionIds) {
      const member = await tx.query(
        'SELECT session_id FROM durable_runtime.runtime_members WHERE session_id=$1 AND runtime_unit_id=$2',
        [sessionId, context.runtimeUnitId],
      );
      if (member.rowCount !== 1) throw new DurableDatabaseError('COMMAND_SESSION_SCOPE');
    }
    const previous = await lookupCommand(authority, original);
    let row: CommandRow | null;
    let result: JsonValue;
    const action = request.action;
    switch (action.kind) {
      case 'SUBMIT': {
        const submitted = await submitCommand(authority, action.request);
        row = submitted.command;
        result = response(submitted.disposition, row);
        // A blocker belongs to its own operation and is only observed here.
        if (submitted.disposition === 'BLOCKED_BY_UNRESOLVED_COMMAND') return result;
        break;
      }
      case 'TAKE_OVER':
        row = await takeOverCommand(authority, action.original);
        result = response('OBSERVED', row);
        break;
      case 'CLAIM': {
        const claimed = await claimCommand(authority, action.original, action.executorId);
        row = claimed.command;
        result = response(claimed.disposition, row, claimed.disposition === 'CLAIMED' ? claimed.claim : undefined);
        break;
      }
      case 'UNKNOWN':
        row = await markCommandUnknown(authority, action.claim);
        result = response('OBSERVED', row);
        break;
      case 'SETTLE':
        row = await settleOwnedExecution(authority, action.claim, action.outcome);
        result = response('OBSERVED', row);
        break;
      case 'RECONCILE':
        row = await reconcileCommand(authority, action.verified);
        result = response('OBSERVED', row);
        break;
    }
    if (row && (!previous || previous.revision !== row.revision)) {
      const event: JsonValue = {
        kind: 'RUNTIME_COMMAND_TRANSITION', commandId: row.id, operationId: context.operationId,
        runtimeUnitId: context.runtimeUnitId, state: row.state, revision: row.revision,
      };
      const { observation } = request;
      await appendAudit(tx, {
        actorId: context.controller.owner, runtimeUnitId: context.runtimeUnitId, operationId: context.operationId,
        kind: `COMMAND_${row.state}`, previousState: previous ? { state: previous.state, revision: previous.revision } : null,
        nextState: event, occurredAt: observation.occurredAt, receivedAt: observation.receivedAt,
        producerId: observation.producerId, producerSeq: observation.producerSeq, evidenceRefs: row.evidence_refs,
      });
      // One canonical event ID per Session source and a unit-level outbox if no
      // Sessions exist. No request bodies, credentials or execution tokens.
      if (sessionIds.length) {
        for (const sessionId of sessionIds) {
          const journal = await appendSessionEvent(tx, { sessionId, source: {
            kind: 'PRODUCER', sourceKind: 'runtime-command', producerId: observation.producerId,
            incarnation: `controller:${context.controller.term}`, producerSeq: observation.producerSeq,
          }, body: event });
          await enqueueOutbox(tx, { eventId: journal.eventId, aggregateId: row.id,
            aggregateKind: 'runtime-command', revision: row.revision, event });
        }
      } else {
        await enqueueOutbox(tx, { eventId: logicalId('event', randomUUID()), aggregateId: row.id,
          aggregateKind: 'runtime-command', revision: row.revision, event });
      }
    }
    return result;
  });
  if (mutation.status === 'REPLAYED') {
    // Atomic receipt replay skips its callback. Authorize access using actual
    // operation/unit/lease rows even for replay; never produce a new claim or
    // invoke an effect from a replayed receipt.
    await withDurableTransaction(pool, async (tx) => {
      const authority = await LockedGatewayAuthority.acquire(tx, context);
      await lookupCommand(authority, original);
    });
  }
  return { identity, mutation };
}

// runDurableMutation returns UNCERTAIN without rerunning the action. Consumers
// use P1-03 resolveReceipt with this exact identity; NOT_FOUND is not retry proof.
// No external executor/substrate/provider entry point is supplied by this file.
