# P1-10 storage identity and grant module

This change implements the root-assigned canonical directory checks and transaction-bound storage registry. It does not mount volumes, start an Agent, stop Compute, expose a public RPC, or implement a production proof authority.

`canonicalizeObservation` maps the longest mountpoint and its filesystem root to the PV authority's backing root. Bind aliases converge on a single backend/export/directory; device/inode equality is checked against the backing path. Mountinfo escapes, root, separator/dot normalization, mount boundary escape, and parent/child overlap are handled. Its result is an unverified candidate. IP, local device numbers, and export source strings never become permanent backend IDs.

`StorageStore` requires a privileged `StorageEvidenceAuthority`. There is no public proof factory or production verifier implementation. Reference strings, Pod annotations, NodeNotReady, lease expiry, and HTTP failure do not verify identity or Compute termination. Synthetic authority implementations belong only to tests. Actual production integration remains closed until an authenticated observer and immutable PV/domain configuration are supplied.

The authority must pin PV UID, server Pod UID, observation generation, mount topology, realpath, and inode while a transaction uses the result. Registration checks twice around lock acquisition; reserve/activation revalidate the original binding. Inode/generation changes cannot silently replace a binding and result in BLOCKED. A check alone cannot eliminate arbitrary NFS rename/TOCTOU; if the authority cannot maintain immutability until commit, it must return unavailable. No filesystem mutation or freeze mechanism is invented here.

All helpers use the P1-03 transaction and held-lock API: Session → Runtime Unit → storage domain → operation. A caller may enter with those locks already held. Binding revision serializes mount writes too because the existing mount table has no independent revision column. Attempt, Pod UID, execution/storage epochs, unit membership, optional operation revision, and current execution grant are checked. Existing SQL unique/domain overlap triggers remain in force even if callers bypass the module.

RO registration is RESERVED until an actual VFS RO observation is verified; RW activation additionally requires the current ACTIVE execution grant. Actual write rejection on an Agent is a separate outstanding gate. RESERVED/ACTIVE/REVOKING writers protect parent/child paths. Unknown or failed revocation preserves the old grant and records BLOCKED/reconcile intent. Confirmed revoke requires the exact old attempt/Pod/incarnation/Node/Compute reference and numeric instance ID with a verified no-reentry deletion disposition. Temporarily STOPPED Compute is insufficient. No actuator is supplied.

Revocation, epoch increment, and a next reservation may be composed in the same transaction using returned revisions. If a next reservation fails, the transaction must roll back. Every transition writes journal, audit, and outbox using the existing P1-03 APIs; helpers never COMMIT or perform effects. The caller must use the authorized mutation/receipt boundary and acknowledge only a confirmed commit.

## Dependency and verification status

The initial code uses main `f01aa4d0d2d2288f99c97863a1e407a390d098b0` plus P1-03 corrected API `cf0fbca42aaf79122ed1d5ac4caf32431628b75c`. The rebased dependency `a2acecc6463d3999a3a62e2512f21dc41f0fcaf6` has byte-identical connection/locks/atomic/journal-store APIs. No common owner files are changed by this module.

Initial API commit: implementation is pending focused remote typechecking and independent-DB tests. This document is not an execution success claim.

Actual Agent RO write test, old Compute disconnection/return, physical fencing, live RW transition, G-04, and full P1-10 acceptance remain unverified. Existing foundation and P1-01 tests are reused and not repeated.
