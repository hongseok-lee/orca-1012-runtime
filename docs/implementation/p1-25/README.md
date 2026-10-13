# P1-25 replay and notifications

Initial API handoff: `publishClaimToReplay(pool, {claim, streamId?})` accepts an
actual committed P1-03 OutboxClaim. It re-reads the original PG outbox and consumes
only id/owner/token from the claim; caller payload is ignored. Outbox rank8 then
stream head rank9 are held through atomic replay insert/head update/PUBLISHED.
Publication performs no network/provider I/O. Supported immutable source replay
returns the original cursor after a lost commit reply; other publication routes
are explicitly NOT_PUBLISHED_HERE and unsupported kinds stay claimed.

`readReplayPage(pool, {streamId, epoch, afterOffset, optionalUnitFilter?, limit})`
returns PAGE or RESET_REQUIRED. A repeatable-read snapshot fixes the high-watermark;
limit bounds the global scan, and nextCursor advances to its last examined offset,
including excluded filter rows. This avoids skips and cursor stalls. Changing a
filter requires re-reading its desired history. Future/malformed cursors and DB
failure are errors. Append-only retention floor is 1; no rotation/deletion exists.

Stream is `orca-1012-dev-v1:ops`, epoch 0; BIGINTs remain decimal strings.
Publication maps only explicit metadata. Actual P112 RUNTIME_EVENT_OUTCOME/FAILED
and RUNTIME_EVENT_FAILED notification sources preserve their canonical kind and metadata
from immutable terminal queue/producer/target records. Their occurredAt is the
actual terminal-decision timestamp, not the arbitrary original payload time.
NOTIFICATION_OPENED/OBSERVED/READ/RESOLVED sources use their stored source time.
Arbitrary outbox JSON, chat text and credentials are never copied wholesale.

Base is `7b7e32c281f674450a711fad17921d13fcb74cc1`, consuming accepted P103
common API and owner migrations 001–012. Common publisher/DB/row schema, existing
P112 files, live source/runtime and public HTTP handlers remain unchanged.
This early handoff has not passed actual PG validation. HTTP/SSE, authentication,
provider/producer spool and physical HA/fencing remain integration gates.
Root owns acceptance and merge.

## Notification state and immutable request boundary

`observeNotification`, `markNotificationRead`, `resolveNotification` use accepted
P103 `runDurableMutation`. Session/Unit/operation locks are declared up front;
original event/operation Unit refs are discovered before mutation and rechecked
against the locked notification target. A rank6 incident key lock covers absent
rows; UNIQUE incident_key remains the cross-owner race guard. Receipt is rechecked
after that lock for Agent-only targets with no business lock. P103 owns the atomic
receipt insertion, rollback and receipt resolution. No common source is copied.

Original first_seen stays fixed; last_seen/retry never regress. Read changes
read_at/revision and leaves OPEN/RESOLVED untouched. Only a trusted verified
recovery source can request RESOLVED; a late old failure cannot reopen the episode.
Each committed decision includes its audit/outbox/receipt. Trusted source and
authenticated principal types have no public constructor here. Their validation
must come from the existing adapters; verification refs are nonsecret references,
not credentials. This module does not implement authentication/provider recovery.

Root's early mutability review is applied before the first await: notification
requests copy target arrays, authority and Date before validation, hashing and
lock discovery. Date is cloned, not only Object.freeze'd. Publication copies only
claim id/owner/token; read options also use an owned snapshot. Subsequent SQL and
artifacts reuse those snapshots. A dedicated actual-PG fixture exercises caller
mutation after SQL awaits; it has not been executed while remote access is down.

## Current execution status

Replay API `c2e74040` passed its initial remote type/lint check. Later notification,
snapshot corrections and new PG fixtures are authored but **not yet type/lint/PG
verified**. The current kubeconfig API connection timed out before fresh Pod
readiness could be established. Root requested no additional remote connection,
test or capture until recovery. Existing successes are retained; no P112 or P103
suite/capture, installation, shared runtime or cloud action was repeated.

Public baseline is still `7b7e32c281f674450a711fad17921d13fcb74cc1`; later main
revisions are predecessor references only until root directs final publication.
