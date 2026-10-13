# P1-04 attachment storage module

This change adds transaction-bound PostgreSQL upload/blob/alias helpers and a
separate Linux materializer. It does not enable clipboard RPC, preview, provider,
or application paths. The root delegation fixes the schema; its DB owner delivers
the migration and common identity/transaction implementation separately.

Initial source base: `a959c22b3d2333e6f3c45d6fb8c3d3d25c7bd184`.
Initial transaction/nominal API reference: `778aa223d76a5f2d6188c6e8aab025e7f505006c`;
the root reports compatible API in `8064b0f2703c36df28a3d2735e0d6276d6f80ae1`.
Consumed schema predecessor: `34498b46c562a7a625d8dda3683f6ee56ecfdd8f`
(PR10). Migration 008 and the common API are supplied by the DB owner, unchanged.
Root subsequently merged those same schema bytes into main.
See [actual module report capture](store-evidence/results.png) and
[immutable capture provenance](store-evidence/capture-provenance.json). This is a
browser-rendered saved verification report, not native/RPC/product UI evidence.
See [store-verification.json](store-verification.json) for actual source hashes,
remote Node 24.15.0 checks and the distinction from the schema owner's five cases.

The canonical worker source directory is
`/home/orca-dev/implementation/p1-04-store/source` in the existing backend dev
Pod's NFS HOME. The disposable execution directory is
`/tmp/orca-p104-execution`. Root corrected the original `/home/node` assignment
after read-only mount metadata confirmed that it is ephemeral. Only these new
owned directories are prepared; live watch and the DB owner's source are preserved.

Actual module verification passed seven distinct PostgreSQL cases and four Linux
materializer cases. The initial PG run passed six cases and failed the seventh
because its fixture reused one parameter for UUID and text (`42P08`). Separating
those fixture parameters made the focused accepted-reference case pass; the other
six cases were not repeated. Dedicated typecheck and repository-configured lint
passed after safe lint/format changes and dividing the store into owned modules
for the repository's file-length limit. This is not evidence of one all-green
repeat suite. The source hash record distinguishes the behavioral runs and final
scoped typecheck/accepted-reference run.

Root's final source review identified a FIFO open that could block before fstat.
Correction `5a54339b32eb11707883cf118e8a6fcec876d33b` adds `O_NONBLOCK` to
`verifyTarget`'s existing read-only/no-follow open, preserving its non-regular
file rejection. One new owned temporary FIFO case passed without a writer
(21.88 ms total test time), followed by no repetition of the original PG7 or
materializer4 cases. Latest dedicated typecheck and modified-file lint passed.
The existing PNG/provenance deliberately retains baseline `1d368031` and its
original four materializer cases. [Correction relation](store-evidence/fifo-correction-relation.json)
and the separate `fifoCorrection` JSON record connect the later verified source;
the old capture is not relabelled as corrected/final-head execution.

The process-death injection killed only the verifier's forked child while its
second chunk was uncommitted. The committed prefix survived independent DB
requery and completed normally. No PG, Pod, backend or Metro was restarted.
Other cases cover exact/conflicting retries, gaps, incomplete commits, blob-only
deduplication, zero bytes, wrong principals, rollback after publication writes,
commit/abort contention, and accepted-reference FK/abort retention. Materializer
cases cover new attempt directories, reuse, conflicting bytes, symlinks,
concurrent publication and corrupt/empty snapshots.

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

No provider/native/Expo/RPC acceptance or full P1-04 completion is claimed.
Existing Mac runtime-owner composer restrictions remain in place. P1-03 business
receipt and uncertain COMMIT integration, P1-10 write authority, physical fencing
and HA remain outside this module verification.


## Isolated reproduction

Use the existing backend dev Pod and its dependency caches. Prepare this public
revision in the dedicated canonical source and disposable execution directories;
leave the live backend checkout and other owners' directories unchanged. Set
`ORCA_ATTACHMENT_REVISION` to this PR's exact implementation revision and
`ORCA_DEV_KUBECONFIG` to the separate dev kubeconfig. Source copying must preserve
both archive and kubectl exit status (`set -o pipefail`). After an identical
rebase, compare the owned hashes and reuse these results rather than reinstalling.

```bash
set -euo pipefail
: "${ORCA_ATTACHMENT_REVISION:?exact public revision required}"
: "${ORCA_DEV_KUBECONFIG:?dedicated dev kubeconfig required}"
ORCA_DEV_CONTEXT=gke_bold-hope-441519-s3_asia-northeast3_orca-dev-seoul-1012
ORCA_ATTACHMENT_SOURCE=/home/orca-dev/implementation/p1-04-store/source

git archive "$ORCA_ATTACHMENT_REVISION" \
  src/main/durable-runtime/attachments src/main/durable-runtime/db \
  src/shared/durable-runtime/identity.ts src/shared/rpc-contract/clipboard-params.ts \
  src/shared/clipboard-image.ts config/tsconfig.durable-runtime-attachments.json \
  docs/implementation/p1-04/build-verifiers.mjs package.json .oxlintrc.json \
  .oxfmtrc.json config/oxlint-plugins | \
  kubectl --kubeconfig="$ORCA_DEV_KUBECONFIG" --context="$ORCA_DEV_CONTEXT" \
    -n orca-dev exec -i orca-backend-dev -c backend -- bash -c \
    'set -euo pipefail; umask 077; mkdir -p /home/orca-dev/implementation/p1-04-store/source; tar -xf - -C /home/orca-dev/implementation/p1-04-store/source'

kubectl --kubeconfig="$ORCA_DEV_KUBECONFIG" --context="$ORCA_DEV_CONTEXT" \
  -n orca-dev exec -i orca-backend-dev -c backend -- bash <<'REMOTE'
set -euo pipefail
umask 077
mkdir -p /tmp/orca-p104-execution /home/orca-dev/implementation/p1-04-store/logs
cd /home/orca-dev/implementation/p1-04-store/source
tar -cf - src config docs package.json .oxlintrc.json .oxfmtrc.json | \
  tar -xf - -C /tmp/orca-p104-execution
cd /tmp/orca-p104-execution
mkdir -p node_modules/@types
ln -sfn /workspace/backend/p1-02-db/dependencies/node_modules/pg node_modules/pg
ln -sfn /workspace/backend/p1-02-db/dependencies/node_modules/@types/pg node_modules/@types/pg
ln -sfn /workspace/backend/checkout/node_modules/.pnpm/@types+node@25.9.5/node_modules/@types/node node_modules/@types/node
ln -sfn /workspace/backend/checkout/node_modules/zod node_modules/zod
node /workspace/backend/checkout/node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/bin/tsc \
  -p config/tsconfig.durable-runtime-attachments.json > /home/orca-dev/implementation/p1-04-store/logs/typecheck.txt 2>&1
node docs/implementation/p1-04/build-verifiers.mjs > /home/orca-dev/implementation/p1-04-store/logs/bundle.txt 2>&1
export PGHOST=postgres.orca-dev.svc.cluster.local PGUSER=postgres
export PGPASSFILE=/workspace/backend/p1-02-db/pgpass
# Use a separate worker-owned validation DB; never set this to orca_dev.
export PGDATABASE=orca_p104_owned
export ORCA_P104_WRITER_ENTRY=verifiers/chunk-crash-writer.mjs
node verifiers/prepare-verification.mjs > /home/orca-dev/implementation/p1-04-store/logs/prepare.txt 2>&1
node --test verifiers/materializer.test.mjs verifiers/store.test.mjs \
  > /home/orca-dev/implementation/p1-04-store/logs/tests.txt 2>&1
REMOTE
```

The explicit setup verifier creates only its guarded validation DB and applies
exact DB-owner migrations there. The normal store never creates a schema or DB.
Raw Node TS loading failed on an existing extensionless shared import before any
test body. Root approved existing esbuild 0.25.12 for these verifier entries only:
Node 24 ESM, installed packages external, output under the disposable execution
directory. Shared parsers, package/lock, the whole app and live runtime are
unchanged; no new loader/package install is needed. Keep private logs 0600 and
publish only the safe verification JSON and approved capture, never their raw
contents, credentials or synthetic attachment payloads.
