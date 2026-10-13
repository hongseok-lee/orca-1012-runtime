# Common durable input / merge boundary module

Initial worktree base: `bf3704cd6ca3c679108e04e0a52d815336108c45`.
Root's actual P1-03 held-lock API reference: `cf0fbca42aaf79122ed1d5ac4caf32431628b75c`
and publication `f0863eea076268e6a1e8b70bb36e140b1ec2f54b`; subsequently merged
main `4557607b53d37df97dfbb8fa85e5b2f30037d53f` is the consumed API source for
isolated checks. Common DB/schema/package files are not owned by this change.
Exact 012 predecessor `5dc1f9bb1ad03fbff00f94652be17bc4f0dc255c` was
consumed with immutable migrations001–011. The full 12 migration prefix was
applied only to this module's guarded validation DB, never dev/production.

Actual internal exports:
- `acceptInput(pool, request)`: scope authorization preflight, then P1-03 receipt
  lookup/Session→Unit locking/recheck. Only a new receipt runs state, attachment,
  component, journal, reconcile/wake hint and Message updates. COMMIT outcome is
  the unchanged P1-03 `MutationOutcome`; unknown outcomes stay unknown.
- `resolveInputReceipt(pool, request)`: same original identity/hash and authorized
  Session/terminal scope, without a new operation key or current lifecycle gate.
- `closeInputMergeBoundary(tx, authority)`: requires an already held Session lock;
  closes only the latest mergeable group, with no wake/activity/provider work.
- `sealInputMessage(pool, request)`: same Session lock, exact Message revision,
  original ordered PG component/attachment composition, immutable payload/hash,
  `merge_closed` and `DISPATCH_INTENT`. This is not a provider execution claim.

`InputAuthority` represents an upper layer's authenticated/authorized principal
and Session/terminal scope, not authentication by a format constructor. Principal
uses P1-04's verified paired-device/fingerprint namespace. Scope checks retain the
actual terminal→Session relation but do not reject old receipt replay because a
Tab/Session is currently closed. New input checks OPEN/fence/current Unit/DELETED.
Membership changes after discovery return an error with no business rows; another
Unit is not locked out of order. Upper wire adapters remain responsible for actual
wire parsing/classification and removing auth credentials from original JSON.

Canonical hash covers preserved original request, method/scope/operation identity,
logical target and classified kind. Object keys only are normalized; strings and
array order remain exact. Receipt hash is never the merged Message hash. Alias
locks use sorted unique paths while occurrences/positions remain in original
order. Attachments are checked with the committed P1-04 alias/owner/hash/blob API;
there is no filesystem materialization in the transaction.

Submission events have internal producer identity `(Session UUID,
'durable-input-v1', Input Component sequence)` and explicitly carry the component
ID/sequence/original hash and Message identity. They are not provider-native
receipts. Unit intent increments only on SUSPENDED→RUNNING; otherwise it is shared.
Reconciliation due time and outbox hint are durable. No controller lease/term,
synthetic operation, READY observation, provider/Pod creation or execution occurs.

Actual implementation `5ae4f671d0227abbc144f5ef6ba50a0346e59950` passed
8 newly scoped real-PG cases in its first actual run (8 PASS, 0 FAIL). Dedicated
remote typecheck and repository-configured lint passed. No PG focused rerun was
needed: initial verifier TS7034/TS7005 (untyped alias array) and a curly style
error were corrected before PG ran. Existing P1-03/attachment/Expo tests were not
repeated. [Safe verification JSON](input-verification.json), [actual result capture](evidence/results.png)
and [immutable provenance](evidence/capture-provenance.json) record exact source,
predecessor/dependency hashes and accumulated validation-DB counts.

P1-05 evidence covers concurrent identity/conflict/independent same-body inputs,
ACK-loss replay through closed Tab/Session and fence changes, foreign principal
non-disclosure, rollback after journal/outbox/wake effects, membership change,
and attachment authorization/order/retention. P1-06 evidence covers 100 original
components/receipts in one pending Message, exact revision seal/append contention,
immutable full payload and persistent command/raw boundaries. Boundary persistence
used a fresh DB connection, not a product process restart. Original components
and receipts each total 112 across all fixtures; accepted-without-row remains 0.
This is module verification, not full P1-05/P1-06 product acceptance.
No live runtime/RPC/provider/native activation, no P1-07 winner determination,
no repeated P1-03 COMMIT faults or existing attachment/Expo tests are included.


## Existing-tool reproduction boundary

Supply the separately managed dev connection and worker-owned execution root
privately. These paths/credentials are not checked into the report. Source inputs
are the exact predecessor and owned module files recorded in the JSON; canonical
and ephemeral execution owned hashes were compared after synchronization. Use
`ORCA_INPUT_EXECUTION_ROOT` and `ORCA_INPUT_TOOL_PACKAGE_JSON` to point to the
owned execution directory and existing esbuild cache manifest. Outputs stay in
that execution directory. No loader/package installation or shared import rewrite.

After consuming the exact schema/API inputs and connecting unchanged existing
PG/type caches, run the dedicated TypeScript compiler with
`-p config/tsconfig.durable-runtime-input.json`, then:

```bash
node docs/implementation/p1-05-06/build-verifiers.mjs
# Supply private PGHOST/PGUSER/PGPASSFILE and an owned orca_p105_* PGDATABASE.
node verifiers/prepare-verification.mjs
node --test --test-reporter=tap verifiers/intake.test.mjs verifiers/attachments.test.mjs
```

Keep child stdout/stderr in precreated 0600 private log files and publish only safe
JSON/report capture. `prepare-verification` is an explicit guarded operator helper,
not an app startup or migration/package change. Reproduce only changed boundaries;
identical publication rebase/docs changes reuse these results. The early branch
base predates the common API/schema merge; final standalone source/base alignment
follows root's publication instruction, not an automatic live sync/restart.
