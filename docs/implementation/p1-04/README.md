# P1-04 attachment storage module

This change adds transaction-bound PostgreSQL upload/blob/alias helpers and a
separate Linux materializer. It does not enable clipboard RPC, preview, provider,
or application paths. The root delegation fixes the schema; its DB owner delivers
the migration and common identity/transaction implementation separately.

Initial source base: `a959c22b3d2333e6f3c45d6fb8c3d3d25c7bd184`.
Initial transaction/nominal API reference: `778aa223d76a5f2d6188c6e8aab025e7f505006c`;
the root reports compatible API in `8064b0f2703c36df28a3d2735e0d6276d6f80ae1`.
The attachment migration has not been delivered. Typecheck and PostgreSQL
verification are pending; no validation success is claimed by this initial code.

Store callers pass a verified paired-device UUID or authenticated credential
fingerprint through the explicit principal namespace constructors. Neither takes
the raw `RpcContext.clientId`. These constructors validate representation, not
authentication. Upload UUIDs are reserved by the server. Alias root is trusted
server configuration, never a client path or socket identifier.

Every store operation takes the P1-02 `DurableTransaction`. Callers acquire common
aggregate locks first (ranks 1–4), then uploads (rank 5, lexical UUID order), then
aliases (rank 6, lexical path order). Store helpers do not take Session locks or
perform filesystem/SSH/provider I/O. Do not interleave a later upload lock after
an alias operation in one transaction. Let errors unwind the owning transaction;
receipt replay and uncertain COMMIT handling remain P1-03 responsibilities.

`startAttachmentUpload` is owner-scoped and checks immutable retry fields.
`appendAttachmentChunk` preserves text/hash and original successful boundary on
an exact retry; conflicting or out-of-order chunks fail. Empty appends are no-ops.
`commitAttachmentUpload` validates reconstructed text and decodes it, atomically
stores SHA-256 bytes/alias/state, and preserves incomplete uploads for a later
transaction. `saveAttachmentImage` uses the same path for single-frame input.
`abortAttachmentUpload` preserves committed aliases, blob data and chunks.
There is no deletion, cleanup, expiry or new aggregate quota API.

Return `readCommittedAttachment` from a successfully committed outer transaction
before invoking `materializeAttachment(snapshot, trustedTargetRoot)`. A caller
must not materialize before COMMIT. The materializer checks bytes/hash, pins each
Linux directory via `/proc/self/fd`, refuses symlinks, writes/fsyncs a private
exclusive file, and links it into place without overwriting an existing target.
Existing targets are reused only after hash/length verification. It never changes
the stable alias or blob metadata. Non-Linux materialization, SSH transport and
Agent write authority are not enabled here; P1-10 integration remains separate.

No provider/native/Expo/RPC acceptance or P1-04 completion is claimed. Existing
Mac runtime-owner composer restrictions remain in place. Actual remote schema,
transaction/crash/race/materialization evidence will be recorded after the DB
owner's schema and root's execution baseline arrive.
