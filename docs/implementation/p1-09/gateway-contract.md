# P1-09 PG command gateway — early implementation facts

Baseline: merged `33b40ea11ccdc1c3aae0d8db309d1cdbf26d8e98` (P1-02 DB and accepted Port declarations). This early API contains SQL-only command ledger helpers under `src/main/durable-runtime/runtime/gateway/`. It is not an activated runtime or complete P1-09/V1-09 implementation.

## Actual APIs and transaction boundary

- `LockedGatewayAuthority.acquire(tx, context)` consumes the existing `DurableTransaction` and shared aggregate locks. It locks Unit → operation → controller lease, checks the operation's actual unit/scope, then reads current lease owner/term/expiry using a fresh DB-clock query after the lock wait. Lease renewal/adoption transactions must lock only the lease and must not wait for Unit/operation in reverse order. Invoke gateway acquisition before later aggregate-lock ranks; use one acquired authority per operation/action transaction.
- `assertExecutionTarget` checks operation step, intent/epoch, expected Pod and active attempt Pod against current Unit/operation rows. A null target is explicit create-without-Pod. This DB check is not a substrate fence. Mutation SQL also checks DB-clock lease validity at write time.
- `submitCommand` verifies the protected canonical JSON input/hash, original key/envelope, and PG terminal predecessor rather than trusting the caller's RECONCILED assertion. Different unresolved commands block a new submission. A same original command returns its stored receipt without triggering an executor.
- `lookupCommand` returns the exact original identity for the actual unit/operation. `takeOverCommand` changes owner term/history only, preserving original request, state and execution token. It cannot make EXECUTING/UNKNOWN claimable.
- `claimCommand` conditionally changes ACCEPTED → EXECUTING with one UUID token/executor and returns a **TRANSACTION_LOCAL** claim. It has no COMMIT, provider call or external callback. P1-03 must confirm commit before an executor can attempt an effect; a provisional claim is insufficient.
- `markCommandUnknown` preserves an original claimed execution for lookup/reconciliation. `settleOwnedExecution` requires the exact original token/executor/identity and current claim owner; late old-owner results cannot overwrite an adopted/settled row. `reconcileCommand` requires future verified original-execution/target evidence. There is no reconciliation factory, unconditional UNKNOWN reset or retry helper.
- Command mutations append history in the same transaction and propagate errors. Callers must roll back on failure so future P1-03 journal/audit/outbox composition is atomic. This module does not copy the uncertain-COMMIT framework or hide transaction commits.

Shared controller identity and verified reconciliation brands are declarations for later authenticated/evidence boundaries; no public handler or external-string-to-verified factory is supplied. Stored JSON/ref strings are not provider/compute/storage proofs. Full Phase 2 method names remain contracts, not successful adapters or advertised capabilities. Ledger UNKNOWN is unresolved execution ownership and differs from a provider dispatch result whose `effect` is UNKNOWN.

## Owner-provided schema / upper mutation prerequisites

The first API targets root's pending `runtime_commands` and `runtime_command_history` SQL contract. Existing baseline has neither table. Column/state/trigger/index and row-projection integration must follow the DB owner's separate migration commit. History INSERT currently uses `executor_id` and default timestamp; exact names/defaults require that handoff. No migration or shared row projection is authored here.

The P1-03 commit/uncertainty/journal/audit API is also absent from this baseline. No code claims these APIs exist or repeats their implementation. Gateway transaction helpers must be joined with that actual API before durable claim-commit confirmation, real-PG failure/concurrency tests and acceptance can be reported. No schema or PG/P1-03 validation has yet run or passed at this early commit.

No K8s/provider/Cloud changes, public RPC/runner/app activation, lease timer reset, fake proof, source/runtime deployment, dependency install, image build or UI capture occurred. Subsequent independent-DB/callback-boundary evidence must remain distinct from actual external effect fencing and G-04/writer exclusion.
