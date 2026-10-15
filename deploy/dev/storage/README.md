# Development PostgreSQL and NFS storage

This directory reproduces the storage part of the root [foundation PR specification](../../../docs/plans/orca-1012-foundation-pr-specs.md). It provides a new development dataset, not product HA, WAL recovery, or distributed writer fencing. The existing management environment and protected datasets are outside its scope.

| Role | Placement | CPU / memory requests | Ephemeral request / limit | Memory limit | Disk |
| --- | --- | --- | --- | --- | --- |
| PostgreSQL | Spot, required selector | 250m / 512Mi | 512Mi / 512Mi | 512Mi | 10Gi `pd-balanced`, Retain |
| Userspace NFS | On-demand, observed on a non-Spot node | 250m / 512Mi | 256Mi / 256Mi | 512Mi | 50Gi `pd-ssd`, Retain |

Neither server specifies a CPU limit. PostgreSQL's StatefulSet keeps PVCs on deletion and scale-down. Both CSI StorageClasses use `WaitForFirstConsumer`, `ext4`, and `Retain`. The RWX PV refers to the NFS export; its 50Gi capacity does not allocate another disk. PGDATA and pg_wal use the PostgreSQL block filesystem, separate from Agent/dev homes.

The four foundation templates are Namespace/StorageClasses (`00`), PostgreSQL (`10`), NFS (`20`), and the static RWX PV/PVC (`30`). An optional NFS ingress policy (`25`) is described below. PostgreSQL uses the pinned official public image shown in its template. **`UNFS_IMAGE` is a required operator-selected `repository@sha256:<64 lowercase hex>` input.** Use the previously validated userspace unfs3 image with its longsocket fix and compatible `unfsd` command. This directory neither builds an image nor substitutes an unverified image.

## Private rendering and explicit target

Run the Python 3 tools from the checkout root; they use only the standard library. Rendering makes no API changes. Supply the operator's fresh namespace/dataset, globally unique StorageClass/PV names, verified NFS digest, and a private output directory **outside this checkout**. Rendered files are created exclusively with mode 0600; existing files are not overwritten. Keep the output directory private and outside every public checkout.

```sh
python3 deploy/dev/storage/tools/render_storage.py \
  --namespace "$NAMESPACE" --dataset "$DATASET" \
  --pg-storage-class "$PG_STORAGE_CLASS" \
  --nfs-storage-class "$NFS_STORAGE_CLASS" \
  --home-pv-name "$HOME_PV_NAME" --unfs-image "$UNFS_IMAGE" \
  --output-dir "$PRIVATE_MANIFEST_DIR"
```

Do not reuse the default kubeconfig. Every API operation must explicitly specify the dedicated `KUBECONFIG_PATH` and the exact `KUBE_CONTEXT`. Inspect existing resources and stop on a name collision. Use `kubectl create`, not overwrite/apply, for this fresh dataset. API errors do not establish absence.

Cluster provisioning remains a separately assigned operator action. The executed creation shape used GKE Autopilot, private nodes, a public control-plane endpoint restricted to the operator's /32, existing network/ranges/NAT and an existing node service account. The parameterized command is:

```sh
gcloud container clusters create-auto "$CLUSTER_NAME" \
  --project="$PROJECT_ID" --region="$REGION" \
  --release-channel=regular --cluster-version="$GKE_VERSION" \
  --network="$NETWORK" --subnetwork="$SUBNETWORK" \
  --cluster-secondary-range-name="$POD_RANGE_NAME" \
  --services-secondary-range-name="$SERVICE_RANGE_NAME" \
  --service-account="$NODE_SERVICE_ACCOUNT" \
  --scopes=https://www.googleapis.com/auth/cloud-platform \
  --enable-private-nodes --enable-ip-access --no-enable-private-endpoint \
  --enable-master-authorized-networks \
  --master-authorized-networks="$ADMIN_IPV4_CIDR" \
  --no-enable-google-cloud-access --logging=SYSTEM,WORKLOAD \
  --monitoring=SYSTEM --labels="purpose=development-foundation,dataset=$DATASET" \
  --async
```

Before creation, successfully list clusters across locations in the designated project and inspect any same-name cluster; never overwrite it. Observe the exact create operation to completion. Obtain credentials into the dedicated private kubeconfig without changing a management context. No existing network, IAM, API, NAT, firewall, or infrastructure Terraform changes are included here.

## Protected managed namespace and create-only leaves

The NFS template retains `/x (rw,no_root_squash,insecure)` and adds the sibling export `/exports/runtime-domains (rw,root_squash,insecure)` on the same backing SSD filesystem. `/exports`, the managed root, and each dataset parent must be root-owned `0:0/0755`; a leaf alone is `1000:1000/0700`. Managed leaf IDs are independent canonical lowercase UUIDs. An Agent or Session does not acquire a global one-to-one leaf relationship. This source neither moves existing data nor changes existing directory permissions.

`tools/managed_storage.sh` runs under BusyBox `/bin/sh` as UID 0 and accepts only these operations:

```text
bootstrap DATASET
ensure-leaf EXPECTED_POD_UID DATASET LEAF_UUID
inspect-leaf EXPECTED_POD_UID DATASET LEAF_UUID
```

The backing root, owners, and modes are fixed inside the helper. Dataset names must be canonical DNS-1123 labels of 1–63 characters; expected Pod UID and leaf ID must match the complete lowercase UUID form. Additional arguments and path-like or injected inputs are rejected without reflecting invalid values. All commands require a valid `ORCA_NFS_POD_UID`; ensure/inspect also require equality with the caller's expected UID. The Deployment provides this environment value through the Downward API. The equality check is a Pod-incarnation execution guard, not authentication or a physical authority proof.

Before work, the helper checks the backing root's directory type, absence of symlinks, exact realpath, and `0:0/0755` metadata. Managed parents and leaves must also match their required owner/mode and backing device. Existing incompatible or partial directories are rejected without repair, rename, delete, or ownership/permission changes. Creation uses exclusive `mkdir`, and only a successful creator sets its new directory's owner/mode. A mkdir loser checks the resulting directory once and fails if the winner is not observably complete. It never retries internally.

Startup calls bootstrap before the unchanged `unfsd` command. Existing `/exports/x`, `agents`, `dev`, and `test-homes` roots are checked as `1000:1000/0755` and left unchanged. On a fresh missing `/exports/x`, the helper initializes its children while the new parent is still `0:0/0700`, then publishes that new parent's final owner/mode. If an already workload-writable `/exports/x` is missing a required child, bootstrap refuses that incomplete state: it cannot safely perform root path-based initialization through that mutable parent. This conservative failure needs operator review; it does not silently reconstruct or repair existing data.

New managed root/dataset paths are created only by bootstrap. Ensure only creates the requested leaf under already protected parents. A newly created path triggers one `/bin/busybox sync -f /exports` followed by final metadata checks; inspect and existing-path reuse perform no sync or writes. BusyBox 1.36.1's permitted help read confirms `-f` means the underlying filesystem, but no actual helper or durability qualification has yet run. A crash can leave an incomplete path for operator judgment. Matching raw metadata does not independently attest a past creation's durability.

The versioned output is raw JSON containing operation, dataset, leaf ID, Pod UID, `created`, newly created paths, and backing/managed/parent/leaf path-device-inode-owner-mode metadata. It contains no token, Verified brand, physical pin, or writer grant. Collection authentication, server/client device correspondence, and authority lifetime through COMMIT/ROLLBACK remain separate contracts. Workloads must later receive only their authorized leaf mount, retain non-root/drop-ALL/no-host-networking constraints, and use the NFS ingress boundary. Root squashing alone does not establish read-only isolation or stop old writers.

The renderer embeds the exact helper bytes as ConfigMap `binaryData` with `immutable: true`, under `nfs-managed-storage-<first 16 SHA256 hex characters>`. It does not substitute or execute the shell content. The tools volume is read-only and the file is invoked via `/bin/sh`, without a new image or package. Full exports/helper SHA256 annotations on the Pod template make changes rollout inputs. The existing read-only `/etc/exports` subPath remains; changing ConfigMap contents does not deliver new bytes to the running process. Old helper ConfigMaps are not automatically removed.

This change is source-only. Bootstrap, leaf creation, rendering, sync, admission, rollout, and new Node kernel mounts have not been executed for this helper. A separately assigned rollout must account for interruption and recovery of existing NFS clients; uninterrupted service is not promised. Existing PG/backend/Expo data and source-watch remain protected, and this source is not acceptance of namespace authority, native provider behavior, old-writer fencing, or HA.

## Optional NFS kernel-client ingress boundary

`25-nfs-kernel-clients.yaml.in` selects the NFS Pods by both `app.kubernetes.io/name=orca-dev-nfs` and the exact dataset label in the chosen namespace. It permits ingress on TCP 2049 from one operator-verified node primary IPv4 subnet. It adds no egress rule, Pod/namespace peer selector, external Service, or host-network exception. Both existing NFS and MOUNT services use TCP 2049.

After root review, the operator can include the optional policy in a fresh private render by adding `--nfs-node-cidr "$NFS_NODE_CIDR"` to the rendering command above. Omitting the option produces no `25` file and preserves the existing foundation outputs and required inputs. The option accepts only a strict, canonical IPv4 CIDR with a nonzero prefix length; IPv6, `/0`, host bits, noncanonical netmask notation, and injected text are rejected. It reuses the exclusive mode-0600 output rule. The renderer does not query or authenticate subnet ownership, dataplane behavior, or access denial. Use a verified narrow node primary subnet, not a Pod/Service CIDR or an inferred NAT range.

This boundary is specific to GKE Dataplane V2 (`ADVANCED_DATAPATH`). [GKE documents that `ipBlock` rules do not include Pod traffic in Dataplane V2](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/network-policy#ipblock_behavior_in_gke_dataplane_v2). The reviewed development metadata has intra-node visibility enabled, a ClusterIP NFS Service on TCP 2049, and NoSNAT declarations covering the NFS Pod and Service destinations. These declarations are prerequisites, not packet observations. Do not generalize this boundary to another CNI or treat `secure` export options as per-request NFS source-port enforcement.

The [bounded observation](evidence/nfs-kernel-client-ingress.json) and [provenance](evidence/nfs-kernel-client-ingress-provenance.json) record the first authorized check on 2026-10-15. From the same existing backend Pod, one new TCP connection to each NFS Service/Pod destination succeeded before policy creation; after creation, one new connection to each destination timed out within three seconds. Concurrent write/fsync/readback of one owned synthetic marker through the existing kernel NFS mount succeeded. NFS/backend/Expo Pod UIDs stayed unchanged, all remained Ready, and restart counts stayed zero. The policy was retained without rollback. No NFS RPC payload or product authentication request was sent. Existing connections may survive through conntrack, so this does not qualify the first kernel NFS mount from a new Node or Agent, all RO paths, or physical writer fencing.

NetworkPolicy permissions are additive: another policy selecting the NFS Pods can widen ingress beyond this rule. All workload provider Pods must prohibit host networking and node proxies; every provider, init, sidecar, and ephemeral container must run as non-root and drop `ALL` capabilities without privileged access. Revisit this boundary if any allowed workload gains those privileges or networking paths, the node subnet or SNAT behavior changes, or NFS is exposed through an external Service. These are deployment conditions; this optional template does not enforce the workload security settings.

Nodes and kernel-originated traffic are trusted by this boundary. It does not defend against a compromised host or trusted administrator. Namespace/leaf permissions, actual mount mode, and old Compute termination remain separate conditions. The bounded observation is not a directory authority pin or completed writer fencing. Further rendering, admission, policy changes, and the first kernel mounts on new Nodes follow their separate root dispatch; the existing PG/backend/Expo connections must be preserved.

## Runtime Secret and admission

Create the rendered `00` file only after the exact target and absence of its resources are verified. The following helper checks that `postgres-runtime` is absent, generates its bootstrap password in memory, and sends JSON directly to `kubectl create` stdin. It suppresses credential-bearing output and refuses to replace an existing Secret.

```sh
python3 deploy/dev/storage/tools/create_postgres_secret.py \
  --kubeconfig "$KUBECONFIG_PATH" --context "$KUBE_CONTEXT" \
  --namespace "$NAMESPACE" --execute
```

The PostgreSQL container reads a mounted runtime Secret through `POSTGRES_PASSWORD_FILE`. Never dump the Secret, password, kubeconfig, readiness/authentication logs, or pairing values into evidence or a PR.

Server-dry-run the rendered `10` and `20` files with the exact kubeconfig/context. Also submit a corresponding direct Pod from each controller's `spec.template` to server dry-run: controller admission alone does not demonstrate Pod resource admission. Compare CPU, memory, ephemeral storage, limits, selectors, tolerations, capabilities, and storage before proceeding. Resource increases, privilege increases, Spot departure, or storage changes require root's decision. UID/status and other defaults that do not change those meanings can be recorded and continued.

PostgreSQL's actual admission changed its originally requested 60-second grace to 25 seconds and added one `cloud.google.com/gke-spot=true:NoSchedule` toleration. The public template explicitly declares both observed defaults. NFS retained its 30-second grace and was observed on a non-Spot node. These declarations do not change the approved requests, limits, security settings, or storage.

After accepted admission, create `10` and `20`, and observe actual Ready Pods, allocated/applied resources, and node Spot status. Inspect both bound CSI PVs and the corresponding GCE disk metadata: claim capacity alone is insufficient evidence of disk type and retention. Do not silently adopt API minimums or provision a replacement disk.

## RWX homes and role directories

Read the **new** NFS Service to render `30`; the tool checks namespace, dataset label, and ClusterIP type. It creates a private file and never applies it:

```sh
python3 deploy/dev/storage/tools/render_nfs_homes.py \
  --kubeconfig "$KUBECONFIG_PATH" --context "$KUBE_CONTEXT" \
  --namespace "$NAMESPACE" --dataset "$DATASET" \
  --home-pv-name "$HOME_PV_NAME" \
  --output "$PRIVATE_MANIFEST_DIR/30-agent-dev-homes.yaml"
```

Dry-run and create that file only within the assigned target. The mount is `/x`, NFSv3/TCP on port 2049 with `nolock,hard`. Preserve ordinary RW attribute caching; do not globally add `actimeo=0` or `nosharecache`. `nolock` does not fence distributed writers. A future read-only observer is a separate boundary.

The executed dataset also contains four role directories. On a **fresh, explicitly assigned export**, this reproduces the nonrecursive preparation:

```sh
kubectl --kubeconfig "$KUBECONFIG_PATH" --context "$KUBE_CONTEXT" \
  --namespace "$NAMESPACE" exec deployment/nfs -- sh -ec '
    for parent in /x/dev /x/dev/backend /x/dev/expo; do
      test ! -L "$parent"
    done
    for role in dev/backend/home dev/backend/source dev/expo/home dev/expo/source; do
      test ! -L "/x/$role"
      mkdir -p "/x/$role"
      chown 1000:1000 "/x/$role"
      chmod 0755 "/x/$role"
    done
  '
```

Only the four directory roots receive ownership/mode changes. Consumers mount PVC `agent-dev-homes` using `subPath` values `dev/backend/home`, `dev/backend/source`, `dev/expo/home`, and `dev/expo/source`; UID/GID 1000 can write. Backend/client owners provide their own approved dev Pods; no such Pod is defined here.

## Actual evidence and remaining scope

[Selected sanitized evidence](evidence/foundation-smoke.json) records the actual deployed foundation at its observation time. The public template is a parameterized reproduction of separately reviewed private manifests, not a claim that this later public commit was deployed byte-for-byte. Namespace/dataset/StorageClass/PV names, NFS Service IP, and private image reference become operator inputs; the PostgreSQL grace and Spot toleration are made explicit. Role directories were prepared in a separate authorized step.

Actual SQL smoke inserted and committed a fresh test row, then independently reread it through a separate psql invocation. `fsync`, `synchronous_commit`, and `full_page_writes` were on. Separate NFS write and read-only consumer Jobs completed, and a third server-side read produced the same SHA256. The test file was 29 bytes, UID/GID 1000, mode 0644. Actual PG and NFS Pods were Ready with zero restarts; both disk types/capacities and Retain policies matched the fixed shapes above.

This evidence does not cover WAL crash recovery, forced restart, failover, cross-node failure, writer fencing, Agent/provider lifecycle, P1-01 as a whole, P1-14 HA, or installed iPhone behavior. The infrastructure worker did not start backend/Expo software. Actual remote client/browser screenshots and their backend/Expo revisions will be linked when that owner's capture is available; this PR remains draft for root review. No image, desktop, or release build was run for this storage publication.
