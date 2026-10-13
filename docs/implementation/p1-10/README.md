# P1-10 storage identity and grant module

This change implements the root-assigned canonical directory checks and transaction-bound storage registry. It does not mount volumes, start an Agent, stop Compute, expose a public RPC, or implement a production proof authority.

`canonicalizeObservation` maps the longest mountpoint and its filesystem root to the PV authority's backing root. Bind aliases converge on a single backend/export/directory; device/inode equality is checked against the backing path. Mountinfo escapes, root, separator/dot normalization, mount boundary escape, and parent/child overlap are handled. Its result is an unverified candidate. IP, local device numbers, and export source strings never become permanent backend IDs.

`StorageStore` requires a privileged synchronous `StorageEvidenceAuthority` over immutable prepared proofs. External filesystem/K8s/Compute collection, authentication and topology/lifetime pin acquisition finish before entering the transaction. Accessor methods cannot return Promises or perform external I/O. Proof refs identify original immutable observations, not a mutable latest alias. There is no public proof factory or production verifier implementation. Reference strings, Pod annotations, NodeNotReady, lease expiry, and HTTP failure do not verify identity or Compute termination. Synthetic authority implementations belong only to tests. Actual production integration remains closed until an authenticated observer and immutable PV/domain configuration are supplied.

The authority must pin PV UID, server Pod UID, observation generation, mount topology, realpath, and inode while a transaction uses the result. Registration checks synchronous local pin validity around lock waits; reserve/activation compare the immutable original binding and local pin validity. The pin owner must maintain the lifetime through COMMIT/rollback and release it outside the transaction. Inode/generation changes cannot silently replace a binding and result in BLOCKED. A check alone cannot eliminate arbitrary NFS rename/TOCTOU; if the authority cannot maintain immutability until commit, its synchronous local validity accessor must return false and the store remains BLOCKED. No filesystem mutation or freeze mechanism is invented here.

All helpers use the P1-03 transaction and held-lock API: Session → Runtime Unit → storage domain → operation. A caller may enter with those locks already held. Binding revision serializes mount writes too because the existing mount table has no independent revision column. Attempt, Pod UID, execution/storage epochs, unit membership, optional operation revision, and current execution grant are checked. Existing SQL unique/domain overlap triggers remain in force even if callers bypass the module.

RO registration is RESERVED until an actual VFS RO observation is verified; RW activation additionally requires the current ACTIVE execution grant. Actual write rejection on an Agent is a separate outstanding gate. RESERVED/ACTIVE/REVOKING writers protect parent/child paths. Unknown or failed revocation preserves the old grant and records BLOCKED/reconcile intent. Confirmed revoke requires the exact old attempt/Pod/incarnation/Node/Compute reference and numeric instance ID with a verified no-reentry deletion disposition. Temporarily STOPPED Compute is insufficient. No actuator is supplied.

Revocation, epoch increment, and a next reservation may be composed in the same transaction using returned revisions. If a next reservation fails, the transaction must roll back. Every transition writes journal, audit, and outbox using the existing P1-03 APIs; helpers never COMMIT or perform effects. The caller must use the authorized mutation/receipt boundary and acknowledge only a confirmed commit.

## Actual observations

Focused verification ran in the existing remote Node24 dev container and an independent worker-owned PostgreSQL database. Existing cached TypeScript/esbuild/PG dependencies were used without installation, image builds, Pod changes or live source/restart. The proof authority in these tests is explicitly synthetic.

| Boundary | Actual result |
| --- | --- |
| Canonical mount-root/alias/path consistency | 5 initial cases passed; not repeated |
| Isolated PG writer/RO/revision/overlap/revocation boundaries | 11 distinct cases passed cumulatively |
| Corrected synchronous prepared-proof/pin boundary | 2 new PG cases passed; Promise-valued/invalid pins stayed BLOCKED |
| Atomic revoke → epoch → next reserve/activation | Focused case passed again after the accessor API correction |
| Namespace-local metadata reader | Owned disposable filesystem fixture symlink/inode/missing-path case passed; not actual NFS |
| Corrected API typecheck | Passed, including negative async-accessor contracts |

There were 19 distinct passing child cases cumulatively, not a single full final suite run. The first test-only TS2352 cast failed before DB creation. One initial rollback assertion wrongly expected an unsanitized error; the fixture was corrected and its rollback/journal/audit/outbox boundary passed. Earlier successful cases were not rerun without an affected boundary. Selected source/schema/API hashes, run completion bounds and failure resolutions are in [results.json](results.json).

The root-authorized one-time narrow retry returned instance-resource not-found for both historical GCE targets, and old NFS Pod not-found before stat ran. This classifies those current attempts only. It neither identifies the discarded original error nor proves old Compute termination, numeric identity or canonical NFS inode equality. Raw/operator evidence remains private.

Actual Agent RO write rejection, old Compute loss/return, physical fencing and live RW transition remain unverified. These observations do not qualify G-04, controller lease authority, full P1-10, product ACK or HA.

## Dependency and verification status

The initial code uses main `f01aa4d0d2d2288f99c97863a1e407a390d098b0` plus P1-03 corrected API `cf0fbca42aaf79122ed1d5ac4caf32431628b75c`. The rebased dependency `a2acecc6463d3999a3a62e2512f21dc41f0fcaf6` has byte-identical connection/locks/atomic/journal-store APIs. No common owner files are changed by this module. P1-09 current-controller-lease gateway integration is a later boundary; this store does not qualify controller authority.

Initial API was reviewed and corrected to reject async evidence accessors. Previously passed canonicalizer and isolated-PG evidence is retained; focused validation of the new synchronous/pin boundary passed. Production verifier and pin mechanisms remain unconnected.

Actual Agent RO write test, old Compute disconnection/return, physical fencing, live RW transition, G-04, and full P1-10 acceptance remain unverified. Existing foundation and P1-01 tests are reused and not repeated.

The publication base is root-merged main `4557607b53d37df97dfbb8fa85e5b2f30037d53f`. The storage source is byte-identical across rebase. Connection/held-lock/journal dependency sources changed formatting; their normalized esbuild emissions are identical to the tested API base. Their source/emission hashes are recorded in results.json, so existing evidence is reused without installation or full-suite reruns. No migration 010/011/012 or live development DB/runtime is changed by this role.

To reproduce only this module in an approved remote environment, provide an existing cache package.json, role-owned source/execution directories, and a separate `orca_p110_*` DB. Use the dedicated storage tsconfig, then `node prepare-tests.mjs "$SOURCE_ROOT" "$CACHE_PACKAGE_JSON" "$EXECUTION_ROOT"`. Set PGHOST/PGUSER/PGDATABASE/PGPASSFILE for each command privately and set `P110_MIGRATIONS` to the owned source migration directory. Run the prepared `.test.mjs` entries with Node24 `--test`; `P110_ONLY` may contain a JSON array of selected PostgreSQL case names. The local metadata fixture writes only its role-owned disposable directory. None of these commands belongs in product startup.
