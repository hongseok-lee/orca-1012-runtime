# Development PostgreSQL and NFS storage

This directory reproduces the storage part of the root [foundation PR specification](https://github.com/hongseok-lee/orca-1012-runtime/blob/foundation/pinned-upstream-and-pr-checks/docs/plans/orca-1012-foundation-pr-specs.md). It provides a new development dataset, not product HA, WAL recovery, or distributed writer fencing. The existing management environment and protected datasets are outside its scope.

| Role | Placement | CPU / memory requests | Ephemeral request / limit | Memory limit | Disk |
| --- | --- | --- | --- | --- | --- |
| PostgreSQL | Spot, required selector | 250m / 512Mi | 512Mi / 512Mi | 512Mi | 10Gi `pd-balanced`, Retain |
| Userspace NFS | On-demand, observed on a non-Spot node | 250m / 512Mi | 256Mi / 256Mi | 512Mi | 50Gi `pd-ssd`, Retain |

Neither server specifies a CPU limit. PostgreSQL's StatefulSet keeps PVCs on deletion and scale-down. Both CSI StorageClasses use `WaitForFirstConsumer`, `ext4`, and `Retain`. The RWX PV refers to the NFS export; its 50Gi capacity does not allocate another disk. PGDATA and pg_wal use the PostgreSQL block filesystem, separate from Agent/dev homes.

The four templates are Namespace/StorageClasses (`00`), PostgreSQL (`10`), NFS (`20`), and the static RWX PV/PVC (`30`). PostgreSQL uses the pinned official public image shown in its template. **`UNFS_IMAGE` is a required operator-selected `repository@sha256:<64 lowercase hex>` input.** Use the previously validated userspace unfs3 image with its longsocket fix and compatible `unfsd` command. This directory neither builds an image nor substitutes an unverified image.

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
