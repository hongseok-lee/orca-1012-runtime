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
