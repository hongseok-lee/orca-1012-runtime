# Internal cancellation, execution claim and recovery context

Implementation pin `ae861915091894e91b66dcb766956205f870c83b`. The independent branch originated on PR17's historical09a89f8e head. PR17 was subsequently root-merged at main8edb42e1; this worktree has not been rebased or synchronized to the live runtime. The exact isolated gateway prerequisite is9052837192bba831a4f0b444e02e51da57c13709 and schema013 prerequisite is7a560c6f77cd8bbbd9f67c1c597da75964f6c8c4. Shared schema/package/identity/Port/gateway files are not changed.

`recordInputCancel(tx, snapshotRequest, expectedUnitId)` is exported from `input/cancel.ts` and `input/execution.ts`. Its expectedUnitId is RuntimeUnitId or null; null retains the wrapper's missing-membership failure and cannot authorize writes. It verifies actual held Session/Unit locks and rechecks the original membership. The caller fixes snapshotRequest before its first await; the core also clones its DTO before its first await. It returns provisional cancellation acceptance data, creates no nested receipt/transaction/COMMIT, and composes with an outer Catalog receipt and Tab tombstone. The existing wrapper retains the original receipt contract. Interrupt outbox hint kind is kept after its facts spread.

`requestInputCancel(pool, request)` consumes an upper-authenticated Session/terminal scope and fixed Message identity through the existing P1-03 receipt contract. It preserves original delivery/attempt/epoch, first cancel time and independent Stop receipts. Pre-effect cancellation differs from actual interruption. Existing verified stop observations can yield ALREADY_SETTLED; an ACK/boolean does not become a proof. History and context do not wake a Unit.

`input/execution.ts` exposes `stageInputInTransaction`, `claimInputEffectInTransaction`, `observeInputDeliveryInTransaction` and `sealInputMessageInTransaction`. The caller holds Session/Unit/operation in the existing P1-03 transaction. Gateway authority/claims are composed in that transaction. Stage stores its exact seal/context/body binding in the immutable stageInput command, resolves that command with STAGED and writes the delivery atomically. Dispatch retains only Message/delivery IDs, finds the original resolved stage and combines current context, target, ACTIVE grant and Message CAS with the actual dispatch claim. Helper failure must unwind the owning transaction. TRANSACTION_LOCAL is provisional; only the owning P1-03 observed COMMIT can precede external effects. Replay/lookup/uncertainty cannot authorize a new effect.

`context/index.ts` exposes `getRecoveryContextFrame`, `readRecoveryContextFrame`, `recordContextDeliveryInTransaction` and `isCurrentContextDeliveredInTransaction`. Frame data is immutable, canonically hashed and ordered. It quotes original compositions, cancellation/execution facts and, when referenced, immutable failed-event payloads in `originalEvents`. Mutable queue claim/retry state is not reinterpreted as a new execution directive; the source owner's failure record is retained without recreating it. No original input/event is re-enqueued. The frame type and VerifiedContextDeliveryProof are owned here once for both provider consumers.

Context proof storage uses exact013's append-only table and checks frame/Session/revision/hash/binding/attempt/Pod/epoch/native references. Exact retries retain the original row and conflict on different evidence content. `currentSatisfied` separately checks the current binding, attempt and frame. Historical old-binding proofs remain history. Neither proof storage nor a true context query supplies execution permission.

## Validation status

See [module-status.json](module-status.json). The historical INTERRUPTED correction9756b3db focused case passed once after a resource-profile fixture FK correction. The aaaca922 API dedicated typecheck/lint passed before the latest source/test additions; its initial nullable rowCount diagnostic was corrected. These historical results are not relabeled as latest-head success. Ten new boundary cases are written and **not executed**. The root paused remote access after the initial Kubernetes API timeout; no repeated connection/test/install/build/capture was attempted. Actual module results and the first report screenshot remain pending. No real provider, public RPC, login, native iPhone/Mac, active runtime, HA or physical fencing success is claimed. Existing P103/P104/P105/06 evidence is reused without repeating its tests or images.

## Narrow verifier entry

After root restores the approved remote path, use an isolated role-owned source/execution directory and the existing dependency cache. Management hosts only edit/synchronize/control; product verification runs in the assigned remote Node24 environment. Set ORCA_CONTEXT_EXECUTION_ROOT to the owned ephemeral execution directory and ORCA_CONTEXT_TOOL_PACKAGE_JSON to the existing tool cache manifest. Use the unchanged private PGPASSFILE injection; do not print its content or build a credential URL. PGDATABASE must match the guarded orca_p107_* namespace. Source includes the exact immutable001–013 owner-provided migration prefix.

```sh
cd "$ORCA_CONTEXT_EXECUTION_ROOT"
node "$ORCA_TYPESCRIPT_BIN" -p config/tsconfig.durable-runtime-execution-tests.json
node docs/implementation/p1-07-08/build-execution-verifiers.mjs
node verifiers/prepare-execution-verification.mjs
node --test --test-reporter=tap verifiers/execution.test.mjs
```

ORCA_TYPESCRIPT_BIN refers to the existing approved TypeScript cache, not a new install. Set ORCA_CONTEXT_REVISION, ORCA_CONTEXT_SCHEMA, ORCA_CONTEXT_GATEWAY and ORCA_CONTEXT_RESULT for exact credential-free result metadata. Direct stdout/stderr to role-owned private0600 logs. On a new failure, retain the original log and use ORCA_CONTEXT_CASE for only its necessary focused correction; do not rerun passing cases. `prepare-execution-verification` applies migrations only to the guarded validation DB, never by application imports or to shared dev. Synthetic authority/proof/callback fixtures are test-only and do not establish authentication, actual provider behavior or physical writer fencing.

[Full assigned contract](contract.md). Root alone decides final acceptance/base/merge and remaining integration. No source/remote runtime activation, new schema/Port field, package installation or policy extension is included.
