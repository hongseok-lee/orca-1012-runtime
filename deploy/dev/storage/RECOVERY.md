# P1-01 backup and PostgreSQL container recovery

This records the root-assigned portion of [P1-01](../../../docs/plans/orca-1012-specs/P1-01.md) under [COMMON](../../../docs/plans/orca-1012-specs/COMMON.md). It extends the accepted foundation evidence with a logical backup/isolated restore, one PostgreSQL immediate shutdown and WAL recovery, and an actual same-directory postmaster lock rejection. Full P1-01 acceptance remains root's decision.

The executed environment used PostgreSQL 16.15 and the existing pinned official image, one Spot StatefulSet replica, the retained 10Gi block disk, and a separate retained NFS SSD for homes. PG shared a Spot node with backend and Expo dev workloads. Root deferred actual Compute removal to the P1-14/G-04 shared fault integration; no Node/VM deletion, disk deletion, forced detach, replacement workload, or resource change was performed.

## Assigned operator execution

The standard-library `tools/pg_recovery_probe.py` requires explicit dedicated kubeconfig/context, fresh-dataset namespace/label, current Pod UID and PV identity, a private directory outside public checkouts, and root-assigned exclusive fault ownership. Arguments are operator inputs; do not put their operational values in a PR.

Read the actual Pod, StatefulSet, Node, attached PV and GCE disk metadata and same-node workloads before the fault. A successful list/identity match is required; never infer absence from an API error. Confirm the fixture and restore names are new. Other DB mutation/migration tests must wait for root to release the shared fault interval.

The private recovery directory must be mode0700. Files are created exclusively with mode0600. Dump stdout streams directly to that private file without TTY, model output or public checkout storage. Credentials are neither fetched from the Secret nor printed; these commands use the existing container-local PostgreSQL connection.

```sh
python3 deploy/dev/storage/tools/pg_recovery_probe.py backup-restore \
  --root-assigned --kubeconfig "$KUBECONFIG_PATH" --context "$KUBE_CONTEXT" \
  --namespace "$NAMESPACE" --dataset "$DATASET" --pod "$PG_POD" \
  --pod-uid "$PG_POD_UID" --pv-name "$PG_PV_NAME" \
  --database "$PG_DATABASE" --private-dir "$PRIVATE_RECOVERY_DIR"
```

This creates only its own small randomly named schema/fixture and commits marker1. It runs a full single-database custom-format `pg_dump`, creates a new temporary DB from template0, then performs `pg_restore --exit-on-error --single-transaction`. The normalized schema-only dump hash and owned fixture count/content hash must match before the fault phase is eligible. No restore into the source database, `--clean`, production migration, or old data import occurs.

The archive excludes global objects such as roles/tablespaces. Schema comparison omits dump comments, owner/ACL commands and generated restrict keys; row comparison covers the owned fixture rather than exhaustive application content. The restore DB uses the same server/disk, so it is neither independent disaster recovery nor physical backup/PITR. Treat the dump as potentially sensitive even if this particular test dataset is small. Retain the private dump and temporary fixture/restore DB for root inspection; this tool does not drop them automatically.

After backup and restore verification, root's assigned fault owner can invoke the one-shot phase:

```sh
python3 deploy/dev/storage/tools/pg_recovery_probe.py crash-once \
  --root-assigned --kubeconfig "$KUBECONFIG_PATH" --context "$KUBE_CONTEXT" \
  --namespace "$NAMESPACE" --dataset "$DATASET" --pod "$PG_POD" \
  --pod-uid "$PG_POD_UID" --pv-name "$PG_PV_NAME" \
  --database "$PG_DATABASE" --private-dir "$PRIVATE_RECOVERY_DIR"
```

Marker2 is committed before the fault; marker3 is inserted into a separate open transaction whose xid and PgSleep state are observed. An independent SQL query sees only markers1/2. The tool checks `fsync`, `synchronous_commit`, and `full_page_writes`, records the flushed WAL position, and verifies the single container, Pod UID, dataset and bound PV again.

It sends **SIGQUIT to the verified PID1 PostgreSQL postmaster inside the assigned container**. PostgreSQL's [immediate shutdown](https://www.postgresql.org/docs/16/server-shutdown.html) exits without normal shutdown processing and requires WAL recovery at the next start. This is an intentionally abnormal PostgreSQL shutdown, not a smart/fast shutdown, SIGKILL experiment, actual GCP Spot reclamation, or HA failover. No whole process group or other container is killed.

The durable local `fault-attempt.json` is written before any fault command. Existing attempt/phase output files prevent automatic replay, including after controller interruption. Do not delete these sentinels to retry a failure. Stop and report the current state to root. The tool will not inject a second fault, delete/recreate a Pod or volume, or force a disk detach when recovery is not confirmed.

The previous container exited with code0 (`Completed`) following SIGQUIT. This process exit code is distinct from database shutdown state: server logs explicitly observed an unclean shutdown and WAL recovery. The kubelet restarted the container in the same Pod. Recovery verification checks the new container incarnation and postmaster start time, restart count increment, retained PV/PVC identity and DB system identifier. Independent SQL must return markers1/2 and no marker3. Selected recovery messages and SQL availability sample timestamps are private evidence; raw session logs are not public artifacts. Availability samples include kubectl/network/command overhead and are not exact external-service downtime or product ACK evidence.

Once recovered and while fault ownership is still assigned, the local writer-lock check is:

```sh
python3 deploy/dev/storage/tools/pg_recovery_probe.py writer-lock \
  --root-assigned --kubeconfig "$KUBECONFIG_PATH" --context "$KUBE_CONTEXT" \
  --namespace "$NAMESPACE" --dataset "$DATASET" --pod "$PG_POD" \
  --pod-uid "$PG_POD_UID" --pv-name "$PG_PV_NAME" \
  --database "$PG_DATABASE" --private-dir "$PRIVATE_RECOVERY_DIR"
```

A bounded attempt to open the same PGDATA must fail on the existing `postmaster.pid`. It uses no second RW mount or replica. The verified PID file and process metadata show one parent postmaster with its expected children. This is local data-directory lock evidence. RWO allows multiple writers on one node, and a single observed attachment does not establish cross-node fencing or protection from a stale writer after a node partition.

After recovery and this check, notify root that the fault interval can be returned. Root releases the other DB worker's wait. No further mutation/fault is performed as part of publication.

## Transaction synchronization evidence

Before the signal, the existing private synchronization record observed the dedicated fixture session as `active`, with a non-null backend xid and `PgSleep` wait. That session executed `BEGIN; INSERT marker3; SELECT pg_sleep(120); ROLLBACK;` under `ON_ERROR_STOP=1`, so reaching PgSleep demonstrated that INSERT had completed in the still-open transaction. A separate connection observed only markers1/2. The synchronization timestamp precedes the signal timestamp. Recovery independently observed markers1/2 and no marker3. Selected fields are included in the public JSON; no new SQL test was run to obtain them.

## Actual observations

[Selected recovery evidence](evidence/p1-01-recovery.json) comes from the assigned run, rather than a simulation:

- One full custom-format logical dump, 2,887 bytes, privately retained with SHA256 `0415a3c6e21a43e4edb88dcd886e5c29af9ad44179bff3ba58a7c6bc2cff6722`. Original/restored schema hash and fixture count/content hash match.
- SIGQUIT at 2026-10-13 01:03:49.626842 UTC; verification completed at 01:03:53.572580 UTC. The same Pod/PV/PVC, DB system identifier, PGDATA and WAL filesystem were retained. Restart count0→1 and container incarnation/postmaster start changed.
- SQL had two failed samples, then succeeded. Committed markers1/2 survived and the open transaction marker3 was absent. Logs show interrupted shutdown, WAL redo and end-of-recovery checkpoint.
- A second same-directory postmaster was rejected by `postmaster.pid`. There was no second mounted replica or new node.

Actual Spot loss/replacement, product durable ACK during DB unavailability, HA, cross-node fencing, independent-server/PITR restore, G-03 Agent qualification and full P1-01 acceptance remain unverified. These criteria were retained and assigned to later integration by root. No same-input foundation smoke, installation, image build or Expo UI test was repeated.
