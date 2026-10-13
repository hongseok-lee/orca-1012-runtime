# Common durable input / merge boundary module

Initial worktree base: `bf3704cd6ca3c679108e04e0a52d815336108c45`.
Root's actual P1-03 held-lock API reference: `cf0fbca42aaf79122ed1d5ac4caf32431628b75c`
and publication `f0863eea076268e6a1e8b70bb36e140b1ec2f54b`; subsequently merged
main `4557607b53d37df97dfbb8fa85e5b2f30037d53f` is the consumed API source for
isolated checks. Common DB/schema/package files are not owned by this change.
Migration012 has not been delivered, applied or tested by this module.

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

P1-05/P1-06 PG tests and dedicated remote typecheck are pending. Code publication
is an early API handoff, not proof of schema compatibility or full acceptance.
No live runtime/RPC/provider/native activation, no P1-07 winner determination,
no repeated P1-03 COMMIT faults or existing attachment/Expo tests are included.
