# Cancellation and recovery context early API

Separate worktree/branch starts on frozen PR17 head
`09a89f8e94c47bbead762442d1582d87cff0403e`; no PR17 source/head changes.
P1-03 held/journal API and root-accepted attachment source are consumed. Early
P1-07/08 code is not verified PG behavior or final module acceptance.

Actual early APIs:
- requestInputCancel(pool,request): fixed Message/request identity through P1-03
  receipt replay, Message/intent/context/journal/audit/interrupt hint transaction.
  Fresh cancel does not depend on current OPEN/fence/attempt; it never wakes a
  Unit or transfers intent to the latest screen/turn. Pre-effect projections can
  cancel; actual UNKNOWN/effect/settled states are retained. No provider I/O.
- readRecoveryContextFrame(tx,authority): already held Session lock, ordered PG
  context records and referenced original composition/current target facts,
  versioned canonical hash; immutable snapshots, not replay instructions.
- getRecoveryContextFrame(pool,authority): authorized scope plus Session lock.
- VerifiedContextDeliveryProof: existing opaque VerifiedEvidence with fixed
  Session/revision/hash/binding/attempt/Pod/epoch/native references. No production
  string/boolean proof constructor, verification bypass or actual provider proof.

013 schema has not arrived. Append-only context delivery storage, observations,
stage and joint gateway/Message execution claim are still being written and are
not exposed as working capabilities by this early commit. The existing delivery
projection has no sealed/context/Pod stage fields, and Port dispatchInput stores
only Message/Delivery IDs; root is being asked how to consume the immutable
stageInput command metadata for that fixed target. Shared DB/schema/Port/gateway
files remain owned by their owners and unchanged. No independent DDL expansion.

New API tests/typecheck and actual provider/native/Stop/HA behavior are pending.
Prepared controller/workload/provider proof fixtures will be explicitly synthetic;
they will not be advertised as physical execution or actual provider verification.
