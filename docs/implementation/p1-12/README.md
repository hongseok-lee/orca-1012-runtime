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
- The DB owner is supplying migration 011 with producer bindings, contiguous
  committed/processed watermarks, claim metadata and protections. The queue SQL
  uses the root's specified contract. Until the delivered migration and corrected
  common API are combined and tested, **actual PG PASS is not established**.
- No DB migration, dependency/package, dispatcher/provider/lifecycle or shared
  runtime source is changed by this queue branch.

Actual workload authentication, physical fencing, provider completion, Agent
durable spool, Runtime Port transport and provider context delivery remain outside
this module's demonstrated scope. Dedicated PG fixtures are module tests, not
authentication/provider/UI success. No Expo screen change is made here; reporting
captures must identify their actual PG evidence rather than claim an app result.

Root retains planning, acceptance and merge responsibility.
