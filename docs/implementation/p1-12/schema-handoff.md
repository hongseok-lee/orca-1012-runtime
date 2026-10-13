# Root producer/queue claim schema handoff

New011-runtime-event-producers.sql on separate implementation/p1-12-producer-schema follows P1-03 held-lock API and010 command schema. No applied migration is edited. This is schema/projection predecessor only; queue algorithms, Agent spool/authentication/Port transport and full acceptance remain with their owners.

runtime_event_producers columns are producer_id/incarnation PK, agent_id/runtime_unit_id/attempt_id/pod_uid/execution_epoch, committed_through/processed_through/revision/created_at. Pair and agent/unit/attempt/Pod/epoch binding is retained. A four-column attempt FK checks Pod and epoch against its actual attempt; Agent is checked against the unit's existing runtime_members→sessions relationship at registration. Agent/unit without any matching member cannot register with this schema; root reviews that concrete binding boundary. Original fields cannot change, watermarks/revision cannot regress and processed cannot exceed committed.

Queue retains canonical/producer unique identities and all original total6/retry5/terminal/FAILED-context constraints. New producer pair and producer+agent FKs protect enqueue ownership. claim_owner/claim_controller_term/claim_token/claim_expires_at exist iff PROCESSING. Counters cannot decrease when a claim is cleared. enqueue_transaction_id is set from actual PG xid8 on insert, is immutable, and allows targets only in that original transaction. Existing historical records retain NULL XID and cannot append new targets. Targets/attempt history remain append-only; existing FAILED deferred guard remains intact.

BIGINT/XID projections are decimal strings. Queue owner must follow sorted Session→Unit→operation→lease→producer/queue order and consume the actual held-lock API. Stored binding fields do not authenticate caller/workload. The early handoff preceded validation; the focused owned-DB result is recorded below. No production schema/fault/runtime/TTL changes.

Focused actualPG schema verification passed in the owned producer-schema DB: incorrect original Pod/attempt tuple rejects; producer binding/watermarks cannot regress; valid enqueue+targets in same transaction succeeds and post-transaction target append rejects; PROCESSING requires claim tuple, clearing claim cannot reset6/5budget. Typecheck/configured lint/format passed. See schema-results.json and actual readback. No queue algorithm/ACK/spool/finalization acceptance is implied;011 has not been applied to production.

## Source equivalence and existing consumer evidence

Root-authorized rebase from `2e9c988daecf91eacce5c4c7bed3f983f340e6a9` to `6d8a643c27084e0da4c15ed5df1c5aa0a784a928` on main `93f6c6bf4e3932687eeab9e16664c57b245768ef` preserved the following exact file bytes. This documentation update changes no DDL, row projection, test or schema result. The existing one-case TAP result is reused; no PG suite or capture is repeated.

| File | SHA256 |
|---|---|
| src/main/durable-runtime/db/migrations/011-runtime-event-producers.sql | `1e0bf2a76794f5b987ccfc2fe8f3efbadfdb0881baa227e96025cced1db0c92e` |
| src/main/durable-runtime/db/rows.ts | `f1b424a3549eaaf637926d14e35a829cb24558df51ee9f14dc4833e3e4122b02` |
| src/main/durable-runtime/db/producer-schema.test.mts | `3428acc2c757b10d9e43b24698b69a95bda7518d7979affe74c66e8bbfae9423` |
| docs/implementation/p1-12/schema-results.json | `e570ae6ca90fa7c05a8ec5a17bf716927d0b236a45fc4caba5b1f7b8b93f95e8` |
| docs/implementation/p1-12/schema-inspect.json | `c6980ef4c65a60b6c0fcd4e8a912569b88e8aba33c43fcf5c9a5828d4bcfc8f7` |

[Consumer PR12](https://github.com/hongseok-lee/orca-1012-runtime/pull/12) owns queue algorithm results and this existing actual result capture. Image SHA256: `a4fc8a4f5f31bb36a9873bcb789220be2c344b908086343fe57a309bde058879`. The consumer image is not a new schema capture or independent DDL proof. Original schema TAP is retained in the DB owner private evidence role; its checksum is in [schema-results.json](schema-results.json).

![Existing queue consumer results](https://github.com/hongseok-lee/orca-1012-runtime/blob/41009d4dc77f000eefb31efdd083a46420624bcd/docs/implementation/p1-12/results.png)
