# P1-12 PostgreSQL queue module

This change supplies the queue module assigned by the root orchestrator: enqueue
and contiguous producer ACK, ordered consumer claims, attempt history and atomic
success/exhausted-failure commits. It does not complete P1-12 integration.

`events/store.ts` exports `registerEventProducer`, `enqueueRuntimeEvent`,
`claimRuntimeEvent`, `processRuntimeEvent`, `recordRuntimeEventFailure` and
`finalizeRuntimeEvent`. Workload callers must supply the existing
`VerifiedWorkloadIdentity` from the authentication boundary; this module adds no
identity-verification factory or public endpoint. Consumer authority is checked
against the locked PG controller lease, owner, term and database time.

Enqueue compares the original canonical event identity, producer/incarnation/
sequence, payload and complete immutable target set. Its result is returned only
after PG transaction commit. ACK is a contiguous stored prefix, independently of
consumer processing. A lost COMMIT response is an error, not a successful ACK;
the caller retransmits the same original event identity.

Consumer processing locks all discovered target Sessions in sorted order before
Runtime Unit, declared operation locks, controller lease, producer and queue.
Discovery is rechecked after locking. Head changes require a fresh transaction
instead of acquiring new Sessions late. Claims charge each STARTED attempt before
running a DB-only handler. P1-03's guarded mutation transaction prohibits hidden
transaction control; late/expired claims and stale controller terms cannot commit
new processing. Successful receipt lookup can replay an already committed result.

The root-specified `p1-12-backoff-v1` policy has six total attempts and five retry
delays of 1/2/4/8/16 seconds. A crashed attempt remains charged and gains an
UNCONFIRMED history record on takeover. Exhaustion calls only the generic
finalizer, preserving original payload and attempt evidence while atomically
storing each target's failure context/revision, notification, journal/outbox,
audit, FAILED terminal outcome and stream-head advancement. FAILED keeps
`processed_at=NULL`; failure history does not create new inputs or wakes.

## Source and schema dependencies

- Queue branch starts from public main `f01aa4d0d2d2288f99c97863a1e407a390d098b0`.
- Common DB/journal APIs are supplied by DB owner P1-03
  `cf0fbca42aaf79122ed1d5ac4caf32431628b75c`; this consumes the existing function
  signatures plus `isLockHeld(rank,key)` and `markLockAcquired(rank,key)`.
  Queue code does not copy or modify the common DB/journal implementations.
- The DB owner supplied migration 011 at
  `3d0b2baee962ccea74d0960e00ea0568e868382d` with producer bindings, contiguous
  committed/processed watermarks, claim metadata and protections. The queue SQL
  uses the root's specified contract. The pinned migration and corrected
  common API were combined in an isolated verifier tree and tested against an
  owned actual PG database. P1-03 has since merged into public main; executed evidence remains pinned to
  the corrected API above. Schema 011 is not authorized for shared dev application;
  no common-owner source is changed here.
- No DB migration, dependency/package, dispatcher/provider/lifecycle or shared
  runtime source is changed by this queue branch.

Actual workload authentication, physical fencing, provider completion, Agent
durable spool, Runtime Port transport and provider context delivery remain outside
this module's demonstrated scope. Dedicated PG fixtures are module tests, not
authentication/provider/UI success. No Expo screen change is made here; reporting
captures must identify their actual PG evidence rather than claim an app result.

Root retains planning, acceptance and merge responsibility.

## Executed evidence

[verification.json](verification.json) records **13 distinct passing actual-PG
cases across four disjoint runs (9 + 1 + 2 + 1), not one all-green full-suite run**.
[validation-readback.json](validation-readback.json) records PostgreSQL 16.15,
Node 24.15.0, all 11 owner migration checksums, source SHA256 equality and observed
zero budget/prefix violations or FAILED rows with a successful processed timestamp.
The first twelve passing cases precede root review. The additional focused case at
`aa314d27` verifies replay after membership removal, conflict/new-event rejection
and the original PG binding delivered to the handler. Replay authenticates the
immutable producer binding before comparing the saved event; current membership
admission applies only to new events. EventRecord exposes original attemptId,
Pod UID, executionEpoch and incarnation from PG. Forged claim origin is rejected;
caller payload cannot replace the stored handler input. This is historical-source
preservation, not acceptance of a current-state projection.

The pre-registration-correction source `5d0595e5` mechanically separates queue helpers and aligns repository
format/lint rules. The affected TypeScript check and lint pass (0 errors/warnings);
behavioral evidence stays attached to its actual executed revisions. No successful
PG case was repeated solely for publication. The current verification manifest records source hashes for `98d995ed`.

The first actual PG fixture failed with 42P08 from reusing one parameter as UUID
and text; its dependent failures were not passes. Separate parameters and fixture
rollback corrected it. The later connection-crash boundary actually produced
57P01; only that assertion's case was rerun. Source/API tests are real PG fixture
checks; fixture workload type assertions are expressly not authentication evidence.
Reply loss uses a driver hook **after a real PG commit**, while finalizer failure
uses actual termination of its own verification connection **before commit**.
The third/sixth STARTED takeover uses **PG lease row replacement**; no actual
child-worker or Active process was terminated. That integration remains unverified.

For reproduction in an approved owned verification environment, assemble the
pinned common/schema predecessors and queue sources without changing shared live
source. Use the preinstalled TypeScript/PG cache and a narrow `tsc -p` with
ESNext/Bundler, strict, noEmit, allowImportingTsExtensions and absolute paths to PG
types. TypeScript 7 has removed baseUrl. Transform only `actual-pg.test.mts` with
existing esbuild (`bundle:true`, `platform:node`, `target:node24`, `format:esm`,
`packages:external`); preserve installed/native packages as external. Do not edit
extensionless product imports or reinstall packages for a test loader.

Supply PGHOST/PGUSER/PGDATABASE/PGPASSFILE per command without echoing credentials;
PGDATABASE must be an owned `orca_p112_*` DB. Set P112_MIGRATIONS to the 11 pinned
SQL files, P112_SOURCE_REVISION/P112_COMMON_REVISION/P112_SCHEMA_REVISION to the
exact revisions and optionally P112_EVIDENCE to an owned private results file.
Execute Node 24 `node --test --test-reporter=tap <owned compiled test.mjs>`.
`--test-name-pattern` selects only an unresolved boundary after a correction.
The owned DB and fixtures are retained; no shared Pod/Node fault, live source
sync/restart, Expo repetition or management-service change was performed.

[results.png](results.png) is the single final browser-rendered view of saved PG evidence, not a
product UI screenshot. Authentication/Port/provider/Agent spool and P1-12 whole
integration remain unverified and subject to root review/acceptance/merge.

[Capture provenance](capture-provenance.json): 2026-10-13 03:16:42.765 UTC,
1280 × 1280 viewport, Chromium 147.0.7727.15 / Playwright 1.59.1,
target code `5d0595e5cd62fa7d755299b5e5408c4ee5c554d4`. The saved result,
report HTML and recovered PNG SHA256 values are recorded together. This was the
first successfully recovered PNG; no further capture or PG suite run was made.

## Producer registration replay correction

Root review [6137555040](https://github.com/hongseok-lee/orca-1012-runtime/pull/12#issuecomment-6137555040)
identified that producer registration still checked current membership before an
existing immutable producer. Source `98d995ed2b2a493de0cf73f970bbd991c93f9dc4`
now looks up an existing producer first and compares its locked original
agent/Unit/attempt/Pod/epoch binding against the authenticated input. Exact replay
returns without new-registration admission. Current attempt and Agent-to-Unit
membership validation remain required for new producers; conflicting originals
are rejected. Original authentication evidence checks remain on every call.

[Focused evidence](actual-pg-registration-correction.json), recorded at
2026-10-13 03:32:25.271 UTC, is one PASS with exit 0. The existing membership-change
case was extended to assert identical producer re-registration succeeds after
membership removal, changed binding rejects with EVENT_PRODUCER_CONFLICT and a
new producer rejects with EVENT_BINDING. Related TypeScript/lint pass. This is an
expanded execution of the existing thirteenth case: **13 distinct cases, 14 saved
passing executions**, not 14 distinct cases or a repeated whole suite.

The PNG and HTML are retained unchanged from source `5d0595e5`; their captured
result artifact is now preserved byte-for-byte as
[verification-before-registration-correction.json](verification-before-registration-correction.json).
The original capture hashes still match. That PNG does not depict the later
producer correction; the new focused JSON and current verification manifest do.
No new capture, shared runtime sync/restart, installation or shared fault occurred.
Root requested rebase after the schema predecessor merge; PR16 remained OPEN at
this correction, so the current base is preserved pending that predecessor.
