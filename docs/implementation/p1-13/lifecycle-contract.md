# Lifecycle core source contract

This is the internal SQL/transport core for P1-13, not an activated controller,
Catalog handler, provider, Kubernetes actuator or public RPC path. Acceptance of
the complete P1-13/V1-08/HA/G04 behavior remains with root.

## Actual entries

- `requestUnitIntent(pool, request)` copies and freezes the authorized value
  fields before awaiting, reuses `inputPayloadHash`, and delegates receipt-first
  commit/replay/uncertainty to P1-03. A receipt replay does not rerun intent checks.
- `recordUnitIntent(tx, request, discoveredMembers)` is the same-transaction
  Catalog entry. It locks all discovered Sessions then the Unit using shared DB
  helpers, rechecks the complete membership and checks expected revisions.
- `reserveSleep(tx, request)` retains its Catalog signature. CLOSED memberships
  remain in locks and writer/dispatch checks but are not permanently busy merely
  because they are CLOSED. CLOSING defers cleanup. Prepared immutable current
  activity/pin absence blocks sleep; no production activity verifier is provided.
- `joinPendingUnitIntent(tx, request)` reads actual P1-05 pending rows and joins
  their current RUNNING intent. It never creates input, changes an intake receipt,
  synthesizes a work timestamp or creates another compatible operation. A queued
  obsolete sleep is cancelled only when no command was ever accepted. Idle due
  time derives from the persisted work timestamp and explicitly supplied policy.
- `readUnitProjection` is one read-only SQL snapshot. `listDueReconciliations`
  reads PG deadlines/retry/due/current desired state and runnable work. Neither
  entry writes activity, receipts or wake state.
- `prepareReconcileStep` snapshots its input and uses actual gateway authority,
  command submission/adoption and claim functions. Original unresolved commands
  are looked up/adopted rather than recreated. Name/deadline/retry are preserved.
  Only a new COMMITTED claim produces COMMITTED_EXECUTE; REPLAYED/UNCERTAIN return
  NO_EXECUTION. No actual external effect runs in this module.
- `recordReconcileObservation` binds the original Unit/operation/step/attempt/UID/
  epoch and sequence/watermark. Stale observations remain original history, not
  active-pointer/intent/grant updates. Raw absence/STOPPED/PRESENT observations
  do not establish provider readiness, permanent compute stop or writer fencing.
  Raw STOPPED writes audit history only, never attempts.status/stopped_at; UNKNOWN
  deliveries retain their stop barrier. PRESENT/STOPPED preserve phase, activity,
  binding facts and observation-loss timestamp. Only current missing/read-failed
  observations start/preserve loss; they cannot claim recovery or a fresh phase.
- `recoverListWatch` observes initial LIST and WATCH through the same sink and
  retries one LIST/WATCH recovery pass on disconnect/410. Persistence/read errors
  remain unverifiable. Resource versions are opaque. `resolveCreateObservation`
  queries the persisted original name and exact identity/spec; it never creates,
  deletes, invents a new name or adopts a conflicting object. It validates and
  freezes the complete original identity before GET. WATCH now carries explicit
  ADDED/MODIFIED/DELETED/BOOKMARK events; the sink receives event + LIST/WATCH
  source. Returned history retains deletes, while current inventory removes only
  the exact namespace/name/UID and preserves a same-name replacement.

## Source prerequisites

The branch starts at root main `ad11b7fbe4016fe1aef0f916f2af7735e04f8af9`.
Accepted main `8edb42e16caf0ddaa840dc16e4e886e6acaca328` supplies the unchanged
accepted input, gateway and queue APIs for consumption. No intermediate rebase,
shared source import commit, DB migration, identity or package change is made.
Gateway uses the reviewed canonical-byte sealing source `90528371`; the existing
13 direct gateway cases and P1-03 failure suites are not run again. Shared modules
are imported, not reproduced in this directory.

## Verification status

Only early intent/projection head `15b73eaf` previously received remote scoped
typecheck exit0. Immutable request correction `a99500d7`, Catalog sleep API
`d668ca34`, CLOSED cleanup correction `4db2bff7` and later local core/tests are
not yet typechecked or executed against PG. Written PG tests cover new lifecycle
meaning, including mutation during await, compatible operation sharing,
sleep/input/close ordering, complete member checks, read-only projections,
controller takeover/original identity, late observations and atomic rollback.
LIST/WATCH tests are deterministic fixtures, not real K8s/HA evidence.

The old remote environment is unavailable; root controls recovery. There is no
new remote connection, install/build/test/capture or live source/runtime sync.
No fresh PASS or report image is claimed. Actual provider event-to-activity
verification, context/cancel eligibility, permanent writer fencing, READY and
actuator execution remain unqualified until the separately owned APIs and real
evidence are supplied. No fake proof constructor/capability is added.


## Root observation review correction

PR23 review comment `6143507416` supplies four source findings, not runtime
failures. The first permitted verification adds only the unverified STOPPED →
UNKNOWN sleep barrier and PRESENT → retained READY/loss PG boundaries, extends
original create-identity mutation/validation, and adds exact-UID WATCH deletion
with name reuse/history. All new/extended fixtures remain unexecuted. The same-TX
`reserveSleep` signature and earlier CLOSED/CLOSING correction remain unchanged.
The transport event API changes only this owned driver/fixture boundary; there
is no controller activation or new provider/fence verifier.
