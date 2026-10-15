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

The regular `nfs-storage-bootstrap` init container calls bootstrap using the same image, Downward API Pod UID, full `/exports` volume, and read-only helper volume. It has no `/x` subPath, exports-file mount, or network port. Init alone explicitly runs as UID/GID 0 with privilege escalation disabled, drops `ALL` capabilities, and adds only `CHOWN,FOWNER`. Its explicit requests (CPU 250m, memory 512Mi, ephemeral storage 256Mi) and limits (memory 512Mi, ephemeral storage 256Mi) match the existing main container. Main resources/security/placement are unchanged, and main still calls bootstrap before the unchanged `unfsd` command.

This init ordering addresses the source-level conflict where kubelet can create a missing app-container subPath before that app's command runs: init prepares the root before app mounts are set up. See the [init container completion contract](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/) and upstream [subPath preparation](https://github.com/kubernetes/kubernetes/blob/v1.34.1/pkg/kubelet/kubelet_pods.go#L310-L342) and [init/app start ordering](https://github.com/kubernetes/kubernetes/blob/v1.34.1/pkg/kubelet/kuberuntime/kuberuntime_manager.go#L1357-L1381). 2026-10-15 최초 admission과 기존 PV의 실제 rollout/bootstrap은 아래 실제 검증 기록 범위에서 확인했습니다. Fresh PV 초기화는 미완료이며, 별도 Node 최초 kernel mount의 후속 수락 범위는 아래에 구분했습니다. 기존 부분 x 디렉터리를 새로 소유한 경로로 인수하지 않습니다.

Existing `/exports/x`, `agents`, `dev`, and `test-homes` roots are checked as `1000:1000/0755` and left unchanged. On a fresh missing `/exports/x`, the helper initializes its children while the new parent is still `0:0/0700`, then publishes that new parent's final owner/mode. If an already workload-writable `/exports/x` is missing a required child, bootstrap refuses that incomplete state: it cannot safely perform root path-based initialization through that mutable parent. This conservative failure needs operator review; it does not silently reconstruct or repair existing data.

New managed root/dataset paths are created only by bootstrap. Ensure only creates the requested leaf under already protected parents. A newly created path triggers one `/bin/busybox sync -f /exports` followed by final metadata checks; inspect and existing-path reuse perform no sync or writes. BusyBox 1.36.1 도움말의 `-f` 의미를 확인한 뒤, 별도 승인된 실제 bootstrap과 고정 leaf 최초 ensure에서 filesystem sync까지 완료했습니다. 이 결과가 crash 이후 내구성 전체를 검증한 것은 아닙니다. A crash can leave an incomplete path for operator judgment. Matching raw metadata does not independently attest a past creation's durability.

The versioned output is raw JSON containing operation, dataset, leaf ID, Pod UID, `created`, newly created paths, and backing/managed/parent/leaf path-device-inode-owner-mode metadata. It contains no token, Verified brand, physical pin, or writer grant. Collection authentication, server/client device correspondence, and authority lifetime through COMMIT/ROLLBACK remain separate contracts. Workloads must later receive only their authorized leaf mount, retain non-root/drop-ALL/no-host-networking constraints, and use the NFS ingress boundary. Root squashing alone does not establish read-only isolation or stop old writers.

The renderer embeds the exact helper bytes as ConfigMap `binaryData` with `immutable: true`, under `nfs-managed-storage-<first 16 SHA256 hex characters>`. It does not substitute or execute the shell content. The tools volume is read-only and the file is invoked via `/bin/sh`, without a new image or package. Full exports/helper SHA256 annotations on the Pod template make changes rollout inputs. The existing read-only `/etc/exports` subPath remains; changing ConfigMap contents does not deliver new bytes to the running process. Old helper ConfigMaps are not automatically removed.

PR100의 source/최초 render·syntax·admission 기록은 당시 증거로 보존했습니다. 2026-10-15의 후속 실제 rollout/bootstrap·기존 kernel marker·고정 leaf ensure/inspect는 아래 범위에서 확인했습니다. Fresh PV와 다른 Node/경로의 qualification은 미완료이며, 단일 Recreate의 짧은 중단을 무중단으로 표시하지 않습니다. 이 결과는 namespace authority, native provider, old-writer fencing 또는 HA의 수락이 아닙니다.

## 실제 적용과 고정 leaf 검증 — 2026-10-15

[실제 결과](evidence/managed-nfs-rollout.md), [정제 JSON](evidence/managed-nfs-rollout.json), [출처/hash](evidence/managed-nfs-rollout-provenance.json)에 후속 실행을 기록했습니다. 13:50 UTC에 helper ConfigMap create·exports CAS·Deployment template CAS를 각 1회 수행해 새 NFS Pod가 Ready에 도달했습니다. Init은 부모 2개만 create/sync했고 main은 created=false였습니다. Image/resources/security/배치와 PV/Service를 유지했으며 자동 retry/rollback은 0입니다.

기존 여섯 경로 metadata와 Backend의 기존 kernel marker 전후 write/fsync/readback·inode·18 B/hash가 유지됐습니다. Catalog의 별도 13:56 read-only 관측에서도 기존 Pod/PID/startticks와 선택 source/raw manifest identity가 같았습니다. 전체 checkout SHA나 모든 filehandle을 증명하지 않습니다.

13:57 UTC에는 고정 leaf 1개만 1000:1000/0700으로 최초 생성했고 inspect가 같은 identity·created=false를 반환했습니다. 새 Agent/production binding/authority 발급은 하지 않았습니다. G03의 별도 첫 mount는 초기 준비에서 미완료로 분리했으며 14:15 Root 수락 뒤 아래 한정 결과를 통합했습니다. Client의 14:06:37.253Z 후속 원본 [Expo 화면](evidence/managed-nfs-rollout-expo.png)을 Root가 수락했습니다. 과거 PNG와 bytes는 같지만 현재 job의 [provenance](evidence/managed-nfs-rollout-expo-provenance.json)는 별도이며, 같은 상세/한글/로딩·오류 부재만 확인했습니다. Native/현재 PG/전체 below-fold 합격은 아니며 Infra의 재촬영·원격 시험은 0입니다.

Fresh PV·다른 Node/경로/provider·continuous availability·physical pin/RO/old writer/HA/native 기기는 여전히 미완료입니다. 기존 PG/Backend/Expo source/config/인증 상태를 바꾸지 않았으며, 운영주소·원 UID·private 경로·full preimage는 비공개 증거로만 보존했습니다.

### 별도 Node 최초 mount의 후속 수락

G03는 14:03:37 UTC에 정확히 결합된 PV/PVC/Pod를 1 batch로 생성했고 14:07:09 Ready/restart 0을 확인했습니다. Kubernetes Node 등록은 14:04:34Z로 Pod API 생성 뒤였으며 Spot label true, 관측 시 다른 일반 workload 0개/system DaemonSet 12개였습니다. Compute GET은 0이고 numeric annotation을 Compute 인증으로 사용하지 않습니다.

14:08:44 probe 1회에서 UID/GID 1000의 정확한 leaf kernel mount와 새 home/project·고유 62 B marker의 exclusive 생성/fsync/readback이 성공했습니다. 같은 Pod의 14:09:39–42 직접 Service TCP 1회는 3초 내 timeout, payload 0이었습니다. 소유 child는 종료했고 자원/leaf를 보존했습니다. [상세 결과](evidence/managed-nfs-rollout.md)는 server/client metadata namespace·관측 시각과 남은 authority/RO/old writer/HA 경계를 분리합니다. 이 결과만으로 production binding, 미래 Node 격리 또는 Compute fault 권한을 발급하지 않습니다.

### 같은 leaf의 최초 RO 관측

[RO 정제 결과](evidence/managed-leaf-readonly.md)와 [JSON/provenance](evidence/managed-leaf-readonly-provenance.json)에 14:48 Root 수락의 VFS ro·open 1회 EROFS·write 0·기존 marker 불변·직접 TCP timeout 및 원 비교 실패→로컬 교정을 구분했습니다. PR102의 14:06 PNG는 RO 이전 UI 이력으로만 참조하며 다수 RO 전체/production authority/old writer fencing/HA 합격은 아닙니다.

## Optional NFS kernel-client ingress boundary

`25-nfs-kernel-clients.yaml.in` selects the NFS Pods by both `app.kubernetes.io/name=orca-dev-nfs` and the exact dataset label in the chosen namespace. It permits ingress on TCP 2049 from one operator-verified node primary IPv4 subnet. It adds no egress rule, Pod/namespace peer selector, external Service, or host-network exception. Both existing NFS and MOUNT services use TCP 2049.

After root review, the operator can include the optional policy in a fresh private render by adding `--nfs-node-cidr "$NFS_NODE_CIDR"` to the rendering command above. Omitting the option produces no `25` file and preserves the existing foundation outputs and required inputs. The option accepts only a strict, canonical IPv4 CIDR with a nonzero prefix length; IPv6, `/0`, host bits, noncanonical netmask notation, and injected text are rejected. It reuses the exclusive mode-0600 output rule. The renderer does not query or authenticate subnet ownership, dataplane behavior, or access denial. Use a verified narrow node primary subnet, not a Pod/Service CIDR or an inferred NAT range.

This boundary is specific to GKE Dataplane V2 (`ADVANCED_DATAPATH`). [GKE documents that `ipBlock` rules do not include Pod traffic in Dataplane V2](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/network-policy#ipblock_behavior_in_gke_dataplane_v2). The reviewed development metadata has intra-node visibility enabled, a ClusterIP NFS Service on TCP 2049, and NoSNAT declarations covering the NFS Pod and Service destinations. These declarations are prerequisites, not packet observations. Do not generalize this boundary to another CNI or treat `secure` export options as per-request NFS source-port enforcement.

The [bounded observation](evidence/nfs-kernel-client-ingress.json) and [provenance](evidence/nfs-kernel-client-ingress-provenance.json) record the first authorized check on 2026-10-15. From the same existing backend Pod, one new TCP connection to each NFS Service/Pod destination succeeded before policy creation; after creation, one new connection to each destination timed out within three seconds. Concurrent write/fsync/readback of one owned synthetic marker through the existing kernel NFS mount succeeded. NFS/backend/Expo Pod UIDs stayed unchanged, all remained Ready, and restart counts stayed zero. The policy was retained without rollback. No NFS RPC payload or product authentication request was sent. 기존 연결은 conntrack으로 유지될 수 있으므로, 당시 관측 하나만으로 새 Node/Agent의 최초 kernel mount를 수락하지 않았습니다. 별도로 수락된 첫 managed leaf mount는 위에 기록했으며, 어느 관측도 전체 RO 경로나 물리 writer fencing 합격이 아닙니다.

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

This evidence does not cover WAL crash recovery, forced restart, failover, cross-node failure, writer fencing, Agent/provider lifecycle, P1-01 as a whole, P1-14 HA, or installed iPhone behavior. The infrastructure worker did not start backend/Expo software. 후속 실제 Client 화면과 선택 Backend/Expo revision은 위 managed NFS evidence에 연결했습니다. 화면의 한정 범위와 기존 foundation smoke 이력을 구분하며, 현재 문서 PR의 최종 리뷰·수락은 Root가 담당합니다. No image, desktop, or release build was run for this storage publication.
