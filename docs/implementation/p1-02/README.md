# P1-02 PostgreSQL module evidence

The isolated `durable_runtime` module adds explicit migrations, logical identity types, stable aggregate locks and independent CAS helpers. Existing SQLite, public RPC and live dev source are unchanged. Dataset: `orca-1012-dev-v1`.

Behavioral code was finalized in `8064b0f2703c36df28a3d2735e0d6276d6f80ae1`; early identity/connection/lock API was published in `778aa223d76a5f2d6188c6e8aab025e7f505006c`. The subsequent publication rebase and evidence commit preserve product file hashes in [source-sha256.json](source-sha256.json). Final formatting/lint edits followed behavioral execution; the evidence is not a single all-green suite at the final commit.

## Public API

- `identity.ts`: `logicalId`, `counter`, `incrementCounter`, branded logical IDs and independently branded SessionFence, ExecutionEpoch, ControllerTerm, StorageEpoch, row/intent/step/context/message/cancel/profile revisions and sequences. BIGINT values use decimal strings; constructors enforce signed BIGINT limits and reject JS numbers.
- `connection.ts`: `createDurablePool`, SQLstate-only `DurableDatabaseError`/`safeDatabaseError`, `DurableTransaction.query`, `withDurableTransaction`. Explicit READ COMMITTED transaction, rollback on failure, no automatic retries. SQL-only callback contract excludes provider/K8s/file/network effects; TypeScript cannot enforce that effect restriction.
- `locks.ts`: `lockAggregates`. Lexical Session IDs, Runtime Unit IDs, storage `(backend,export)` domain keys, then operation IDs. A subset follows the same ranks; reversing ranks/keys is rejected. Direct SQL callers must follow the contract; helper tracking cannot prevent arbitrary SQL locks.
- `cas.ts`: session fence, execution attempt claim, controller lease, operation step, storage epoch and proof-bearing execution revoke helpers compare identity plus their independent counters/revisions in SQL. Operation step also verifies owner/lease expiry and expected Pod identity.
- `rows.ts`: selected row projections, not an exhaustive typed ORM. `migrate.ts`: checksum-verified explicit migration apply with advisory transaction lock and transactional ledger.

## Actual PostgreSQL results

Remote execution used the existing backend Node `v24.15.0` with isolated source/dependency paths and an ephemeral execution mirror. Product driver `pg` and `@types/pg` are pinned to `8.23.1`; only their necessary lock graph was added. No application/native/image build or full reinstall was run.

[verification.json](verification.json) records **17 distinct passing real-PG cases** across three disjoint evidence runs: four initial cases, twelve remaining/focused cases, one corrected CAS fixture case. Initial fixture errors and the CAS parameter error are retained as failures corrected before focused reruns. Repository-configured remote oxlint, oxfmt and dedicated TypeScript check passed. CAS-only control stream ended EOF after persisted TAP completed with zero failures; that test was not repeated.

First SQL apply failed in `005-events-replay.sql` line 87, position 5998, SQLSTATE `42601`: unquoted reserved `offset`. Quoting the column and PK fixed it before successful application. Later fixture corrections supplied mandatory attempt status and separated UUID/text parameter types (`42P08`).

Validation DB and authorized target schema both have seven applied migrations, 44 tables, 73 FK, 134 CHECK, 44 PK, 36 unique constraints and two deferred constraint triggers. [Validation readback](validation-inspect.json), [target readback](orca-dev-inspect.json) and [ledger/checksums](migration-manifest.json) preserve actual timestamps and driver/server versions. PostgreSQL: `16.15`. Applied migration bytes are frozen.

Storage trigger functions fix `search_path` to `pg_catalog, durable_runtime, pg_temp`. Default `$user, public` and temporary shadow relations were tested. Direct-SQL writer insertion and binding epoch mutation serialize on the same domain row; writer rereads binding state after serialization. Actual transactions in both orders observed a PG lock wait and rejected the stale mutation with `23514`. Epoch lock/revalidation cannot be replaced by app helper assumptions.

Cancel target tuple includes provider turn ref. Non-null retarget/erase is prohibited. NULL-to-ref remains prohibited pending the explicit P1-07 contract. Execution/storage revoke requires evidence; held grants cannot be freed solely by lease expiry or Pod absence. Path overlap uses directory boundaries and protected states; RO is plural. Actual path normalization and physical fencing remain unconnected.

## Explicit execution

In an operator-prepared Node 24 environment with the isolated PG dependencies, set standard PG configuration without echoing credentials:

```sh
node config/scripts/durable-runtime-db.mjs manifest
node config/scripts/durable-runtime-db.mjs migrate
node config/scripts/durable-runtime-db.mjs inspect
node node_modules/typescript/bin/tsc -p config/tsconfig.durable-runtime-db.json
PGDATABASE=orca_p102_owned node --test src/main/durable-runtime/db/postgres.test.mts
```

The suite requires a separately owned `orca_p102_*` validation DB. Existing owner fixtures are retained. `DURABLE_DB_FOCUS=remaining` skips the four initial passing cases; `DURABLE_DB_ONLY='<exact case name>'` selects one case. These are reproducibility commands, not an instruction to repeat already passed checks. Imports and Orca startup do not apply migrations.

## Unjoined scope

No P1-03 atomic business/journal/outbox/receipt composition, uncertain COMMIT resolution or publish-after-commit algorithm; no intake/provider/controller/replay policy activation; no RPC ACK evidence; no physical writer fencing, HA/Spot loss or native/UI acceptance. Phase 2 snapshot/storage relations are representations only. Storage identity proof in synthetic tests is not proof of actual symlink/PVC identity. Existing cold/idle mapping remains G-01/P1-29 work. No quota/split/summary/delete/GC or durability override was added.

The screenshot is an actual browser-rendered view of the saved SQL readback and test summary, with its sources and capture provenance. It is not a product UI capture or new runtime check.
