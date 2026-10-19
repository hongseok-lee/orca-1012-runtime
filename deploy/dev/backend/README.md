# Node-only backend development

Foundation scope: pinned upstream plus common patches, a separate dev Pod (development: on-demand with `safe-to-evict: "false"`, see `../storage/README.md`),
and source watch/reload. This does not implement HA, PostgreSQL persistence or
new product RPCs. The Pod manifest deliberately starts a holding process so
admission and initial dependencies can be checked before runtime startup.

Use a dedicated development kubeconfig/context. Required NFS paths are
`dev/backend/home` and `dev/backend/source`, owned by UID/GID1000. Check the
server dry-run of the Pod itself: requests must remain CPU1, memory4Gi and
ephemeral8Gi, with no CPU or memory limit. Stop for review if admission changes
those values. No administrative Orca process or existing credential is reused.

```sh
kubectl --kubeconfig <dev-kubeconfig> --context <dev-context> create --dry-run=server -f deploy/dev/backend/pod.yaml -o json
kubectl --kubeconfig <dev-kubeconfig> --context <dev-context> create -f deploy/dev/backend/pod.yaml
kubectl --kubeconfig <dev-kubeconfig> --context <dev-context> create -f deploy/dev/backend/service.yaml
```

Inside the remote Pod, clone the approved public source revision under
`/workspace/backend/checkout`. Initial dependency/native preparation uses the
existing source policy, without an Electron download or desktop/image build:

```sh
cd /workspace/backend/checkout
mkdir -p "$HOME/.local/bin"
corepack enable --install-directory "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"
ELECTRON_SKIP_BINARY_DOWNLOAD=1 corepack pnpm install --frozen-lockfile --ignore-scripts
node config/scripts/ensure-native-runtime.mjs --runtime=node
# Initial relay transformation, if the SSH path is used:
corepack pnpm run build:relay
node --test config/scripts/dev-orcad.test.mjs
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON config/scripts/dev-orcad.mjs -- --port 16768 --bind 0.0.0.0 --pairing-address 127.0.0.1:16768 --mobile-pairing --json
```

The runner incrementally bundles the main/daemon/watcher entries together into
memory, rejects Electron/node:sqlite imports, and stages complete artifacts in
`out/orcad-dev/generations/`. It writes the existing content-derived `.version`,
copies agent-browser, sets both child `ORCA_VERSION` and `ORCA_APP_VERSION` to
that exact artifact version, gracefully stops only its runtime PID and then starts the
new generation. Generation paths remain immutable so detached daemon siblings
remain available. `out/orcad` release artifacts are untouched. The esbuild
onEnd barrier serializes adoption; failed compilation/graph/artifact staging
leaves the running PID and current generation unchanged. Historical generations
are retained; this runner does not perform garbage collection.

`out/orcad-dev/.runner-lock` prevents concurrent supervisors. A stale lock after
an unclean supervisor/Pod exit requires explicit operator recovery. The lock records
an owner UUID, Pod UID, runner PID and runtime PID. Read this metadata, verify both
recorded processes have exited in the same Pod, or verify the old Pod UID has been
terminated in the dedicated context after Spot recovery. The holding Pod may still
be live after supervisor SIGKILL: stop only its recorded runtime PID gracefully and
wait for that PID's exit first. Never kill a PID from a different Pod namespace.

```sh
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON config/scripts/dev-orcad.mjs --confirm-owner-exited <recorded-owner-uuid>
```

The recovery command requires exact owner confirmation and refuses live recorded
PIDs within the same Pod. Cross-Pod liveness requires the explicit operator Pod-UID
check; this dev tool does not infer process death from missing contact and does not
implement distributed writer fencing. Recovery deletes only that confirmed lock.
Do not edit/remove it while the prior runner or runtime is live. A legacy/malformed
lock is rejected and requires manual inspection instead of an automatic unlock.

Runtime stdout/stderr and compilation diagnostics go directly to a new private
0600 log in `$HOME/.local/state/orca-dev/`; pairing offers must stay private.
Supervisor output contains only build/restart metadata, generation, PID and
artifact hash. A `started` event means process spawn, not authenticated readiness.
The existing Orcad runtime has its own bounded shutdown; the runner escalates only
its owned PID after17s. Unexpected runtime exit is reported and does not create a
restart loop; a subsequent successful source build can launch another runtime.

On the operator machine, establish separate localhost forwards:

```sh
kubectl --kubeconfig <dev-kubeconfig> --context <dev-context> -n orca-dev port-forward --address 127.0.0.1 service/orca-backend-dev 16768:16768
kubectl --kubeconfig <dev-kubeconfig> --context <dev-context> -n orca-dev port-forward --address 127.0.0.1 pod/<client-dev-pod> 8081:8081
```

The operator browser uses `http://localhost:8081`, with the paired backend at
`ws://127.0.0.1:16768`. If forwarding runs on a remote management host, map those
new loopback listeners through an approved SSH tunnel. Service DNS alone is not
operator reachability. A remote browser in the client Pod needs its own local TCP
forward to the backend Service because it has a different localhost namespace.
No public firewall or Tailscale change is required by these command shapes.

Actual validation must check browser secure context/WebCrypto, normal pairing,
authenticated encrypted RPC, then source update generation/hash/PID and an existing
endpoint observation. TCP connectivity and static manifests are not runtime
acceptance. Client screenshots and Expo Web/native iPhone results are distinct.

Before the client's actual Save, the backend operator checks the handed-off
offer against the normal pairing source and the current private registry in
the backend Pod. It writes a separate private0600 validity JSON; neither the
offer nor the registry is published or modified. The client needs fresh
metadata, not an invented expiry timer. The minimum fields used by this run are:

```json
{
  "checkedAt": "<UTC timestamp from backend check>",
  "policy": "direct-no-time-expiry",
  "expiresAt": null,
  "expired": false,
  "registryMatch": true,
  "pending": false,
  "valid": true,
  "pendingRequiredForValidity": false
}
```

The normal direct offer schema has no time-expiry field; relay invite expiry
applies only when a relay offer actually contains it. Registry equality and
pending state are derived inside the backend's private runtime. Before Save,
require `valid === true` and `registryMatch === true`; `pending` is observational
metadata, not a validity requirement. Successful server authentication changes
`lastSeenAt` from zero but does not invalidate the credential: `validateToken`
still accepts the same unrevoked token on a fresh connection. Recheck the same
offer against the current registry before retrying; do not reissue it merely
because `pending` is false. Do not export tokens, URLs or credential fingerprints.
If issuance is actually required, use only the existing normal issuance path and
wait for the coordinator if it requires changing the running PID.

A nonzero `lastSeenAt` supports reaching the server authentication callback;
it does not prove client pairing or Save completed. The client processes the
encrypted authentication response, settles capability negotiation before
publishing `connected`, and the pairing candidate must return a successful
`status.get` before the host is saved. WebSocket frame counts alone are insufficient.

The existing headless status updater reads `ORCA_APP_VERSION`, while Orcad
readiness reads `ORCA_VERSION`. Check both against the generated `.version`;
setting only the latter can leave authenticated `status.get.appVersion` at
the updater's `0.0.0-dev` fallback even though readiness has the artifact version.

After first normal client pairing/catalog/capture, coordinate exactly three
connection transitions with the client: `1새runner채택`,
`2임시source변경watch`, `3source원복watch`. Each stage waits for the backend
PID/generation/hash/encrypted-API evidence and the client's reconnect observation
before the next stage. New-runner initial startup is separate from source-watch
validation. Temporary source edits are restored byte-for-byte; restoration must
also trigger incremental reload and match the final PR source.

The observed run preserved the original stage 1 proof/client acknowledgement,
then adopted the approved two-variable version correction separately. That
additional adoption kept the product bundle unchanged and has no independent
UI checkpoint claim. Stage 2 records the corrected PID as its predecessor;
stage 3 restores the original bytes and bundle hash. The first stage 3 API
attempt failed with a connection error; a later normal encrypted `status.get`
succeeded after readiness was independently observed. Retain both results.

## 개발환경 controller inventory 연결 준비

이 절과 `inventory-rbac.yaml`, Pod의 projected mount는 2026-10-16 Root 계약에 따른 **source 후보**입니다. 아직 apply·credential 발급·Pod 교체·controller 시작·server dry-run·시험을 수행하지 않았습니다. 기존 개발 watch와 NFS source/dependency/private 설정을 보존한 실제 연결은 최종 source와 복구 명령을 Root가 검토한 뒤 별도로 수행합니다.

전용 ServiceAccount `orca-backend-inventory`와 같은 `orca-dev` namespace의 Role/RoleBinding을 사용합니다. Role은 core `pods`의 `get`, `list`, `watch`만 허용합니다. Secret·exec·Pod mutation·nodes·cluster 권한은 없으며 Agent workload에 이 계정을 부여하지 않습니다. Pod와 ServiceAccount의 자동 token mount는 모두 false입니다. 명시한 `controller-credentials` projected volume만 backend 컨테이너의 `/var/run/orca-controller`에 read-only로 mount합니다.

| Projected 파일 | Source와 설정 |
|---|---|
| `token` | serviceAccountToken, expirationSeconds 3600. `audience`를 생략해 Kubernetes API server의 기본 audience를 사용합니다. 임의 외부 audience를 지정하지 않습니다. |
| `ca.crt` | 같은 namespace의 기존 `kube-root-ca.crt` ConfigMap의 `ca.crt` key입니다. |
| `namespace` | downward API의 `metadata.namespace`입니다. |

Projected `defaultMode`는 0444(JSON 정수 292)로 UID 1000이 읽을 수 있게 합니다. 새 mount에는 subPath를 쓰지 않으므로 kubelet의 projected token rotation을 그대로 읽습니다. [Kubernetes 공식 projected volume 문서](https://kubernetes.io/docs/concepts/storage/projected-volumes/#serviceaccounttoken)의 API server 기본 audience와 kubelet rotation 의미를 따릅니다. Token/CA 내용은 source·PR·로그에 넣지 않습니다. 기존 두 NFS subPath와 이미지·requests·CPU/memory limit 미설정·Spot/amd64·HOME·Service·termination 설정은 유지합니다.

Controller private JSON은 runtime UID 1000 소유의 일반 파일, mode 0600으로 두며 symlink는 허용하지 않습니다. 해당 경로를 `ORCA_DURABLE_CONTROLLER_CONFIG`로 지정하는 실제 작업은 아직 수행하지 않았습니다. 실제 API origin은 cluster CA와 맞는 in-cluster HTTPS origin을 사용하며 TLS 검증을 완화하거나 admin credential을 복사하지 않습니다. 아래 예제의 키는 현재 `OrcadControllerConfig`와 같고 `structuredOutput`은 포함하지 않습니다. 예제는 활성화 성공이나 실제 적용 증거가 아닙니다.

```json
{
  "datasetName": "orca-1012-dev-v1",
  "inventory": {
    "apiOrigin": "https://kubernetes.default.svc",
    "namespace": "orca-dev",
    "dataset": "orca-1012-dev-v1",
    "caFile": "/var/run/orca-controller/ca.crt",
    "tokenFile": "/var/run/orca-controller/token",
    "requestTimeoutMs": 10000,
    "watchTimeoutSeconds": 5,
    "listLimit": 100
  },
  "policy": {
    "lease": {
      "revision": "orca-dev-controller-inventory-v1",
      "durationMs": 30000
    },
    "renewIntervalMs": 10000,
    "standbyPollIntervalMs": 5000,
    "passPollIntervalMs": 1000,
    "maximumWork": 32,
    "externalBudgetMs": 12000
  }
}
```

### Agent 재부착·정리 설정 (PR #167–#169)

위 예제에 아래 키를 더하면 backend가 재기동하거나 교체돼도 Agent 세션이 이어집니다. 실행 중이던 provider를 다시 붙이고, 실제 종료 증거가 확인된 attempt의 grant를 회수하며, owner를 잃은 입력을 UNKNOWN으로 정리합니다(재전송 없음).

```json
{
  "orphanReconcile": true,
  "inputRecoveryAll": true,
  "adoption": { "configFile": "/home/orca-dev/.local/state/orca-dev/adoption.json" }
}
```

- `orphanReconcile`: Pod 404·다른 UID·terminal phase만으로 writer를 해제하지 않는다. 정확한 UID의 인증된 종료 증거(모든 실제 container terminated, `restartPolicy: Never`, 삭제 시작, `PodReadyToStartContainers=False`) 또는 기존 collector의 정확한 Compute 영구 삭제 증거가 있어야 write/exec grant·mount를 회수하고 storage/execution epoch를 올린다. attempt는 `STOPPED WRITER_STOP_CONFIRMED`가 된다.
- 종료 증거가 없는 사라진/종료 중 Pod는 writer와 epoch를 보존하고 `REVOKING/BLOCKED`로 유지한다. 실제 상태 변경은 기존 audit/outbox와 notification에 한 번 기록하며, 증거 확인 시 notification을 해소한다. DURABLE/UNKNOWN 입력은 재전송하거나 삭제하지 않는다.
- 새 Agent Pod는 `orca.dev/writer-stop` finalizer로 종료 상태를 DB 회수 commit까지 보존한다. 이전 plan의 live Pod도 삭제 전에 UID/resourceVersion 조건부 PATCH로 보존하며, 삭제는 원 UID의 `DeleteOptions.preconditions.uid`와 기본 grace를 사용한다. 삭제 응답은 종료 증명이 아니다. commit 후 finalizer 정리는 controller takeover 후에도 재시도한다. Agent create/delete Role에는 이 finalizer용 `pods/patch`가 필요하다.
- 실패한 ownerless WAKE는 현재 controller 권한으로 기존 operation/command를 takeover한 후 정확한 미준비 Pod만 종료 요청한다. READY runtime은 재부착 경로에 남긴다. Node나 공용 기반 시설을 삭제하지 않는다.
- Compute fallback은 기존 실행 target과 완전한 Compute 삭제 audit를 읽는다. Cloud Logging 조회 권한이 없거나 증거가 불완전하면 writer를 해제하지 않는다. [실측 기록](evidence/writer-lifecycle-20261019.json)의 unit01 시점에는 Logging 403이었다. 이후 unit02에서 root의 권한 부여와 HTTP 200·matching entries 0 확인이 보고됐으며, 실제 lost-node 복구는 여전히 검증되지 않았다.
- `inputRecoveryAll`: 이전 controller term에서 실행되다 owner를 잃은 모든 `dispatchInput`을 기존 owner-loss 규칙으로 UNKNOWN 정리한다. `inputRecoveryTarget`과 함께 쓸 수 없다.
- `adoption.configFile`: host가 기록된(`agent_control_hosts.control_sha256`) 모든 READY Codex/Claude 세션을 다시 붙이는 registry 설정이다. 파일은 UID 1000·mode 0600이며 형식은 다음과 같다.

```json
{
  "controlArtifactDirectory": "/home/orca-dev/.local/share/orca-backend-dev/control-artifacts",
  "runtimeServiceAccountName": "orca-runtime-agent",
  "runtimeServiceAccountUid": "<orca-runtime-agent SA uid>",
  "clusterIdentityRef": "<cluster identity ref>",
  "outputSpoolRoot": "/home/orca-dev/.local/state/orca-dev/adopted-spool",
  "timeoutMs": 120000
}
```

- `rewake.configFile`: Pod가 사라져(orphan 정리로 attempt `STOPPED`) 실행 주인이 없는 세션에 대기 입력(`DURABLE`)이 있으면 새 WAKE 작업으로 같은 leaf·같은 Pod 모양의 새 Agent Pod를 띄우고 같은 native 세션을 이어 받는다(Codex `thread/resume`, Claude `--resume`). READY가 되면 대기 입력을 보낸다. 실패한 재기동은 그 Pod를 지워 orphan 정리로 fencing한 뒤 작업을 마감하고 1분 간격으로 최대 3번 다시 시도한다. 형식:

```json
{
  "baseTargetFile": "<이전 first-managed target.json: credential·collector·podTokenFile·executorId>",
  "baseProfileFile": "<namespace accepted profile JSON (leafId·qualificationRef는 세션별로 채움)>",
  "controlArtifactFile": "<agent-control-<sha>.cjs>", "controlSha256": "<sha>",
  "codex": { "nativeArtifactFile": "…", "nativeSha256": "…", "nativeByteLength": 0, "codexAuthFile": "…" },
  "claude": { "nativeArtifactFile": "…", "nativeSha256": "…", "nativeByteLength": 0, "claudeTokenFile": "…" },
  "runtimeServiceAccountUid": "…", "clusterIdentityRef": "…", "projectId": "…", "projectNumber": "…",
  "stateDirectory": "/home/orca-dev/.local/state/orca-dev/rewake/runs", "timeoutMs": 240000,
  "nfsPodLabel": "app.kubernetes.io/name=orca-dev-nfs",
  "lifecyclePolicy": { "operationDeadlineMs": 600000, "idleDurationMs": null }
}
```

  WAKE 마감은 Spot 노드 확보와 cold start를 덮도록 10분으로 둔다. 실패한 Pod를 지우려면 `orca-first-managed-pod-create` Role에 pods `delete`가 필요하다. 한 프로세스 안에서 runtime unit의 주인은 하나다(`orcad-unit-ownership.ts`). first-managed·adoption·재기동 모두 unit의 현재 attempt(또는 진행 중 WAKE 작업)를 claim한 뒤에만 붙거나 띄우며, claim은 PG에서 그 attempt가 active·미정지이거나 작업이 열려 있을 때만 유효하다.

`controlArtifactDirectory`에는 `node config/scripts/build-agent-control.mjs <dir>`로 만든 `agent-control-<sha256>.cjs`(mode 0600)가 있어야 한다. 기록된 host와 같은 sha의 bundle로만 다시 붙는다. `outputSpoolRoot` 아래에는 세션별 spool 디렉터리가 생긴다. dev runner(`dev-orcad.mjs`)는 요청하지 않은 runtime 종료가 나면 같은 generation을 다시 띄운다.

현재 Backend는 Deployment owner가 없는 독립 Pod입니다. SA/volume 같은 불변 spec 필드를 실제 반영하려면 Root가 정확 UID 조건의 정상 종료와 Pod 재생성, 같은 NFS source/dependency/private 설정·watch 복구를 함께 배분해야 합니다. 기존 lock의 owner와 Pod UID를 대조하는 위 복구 절차를 유지하며 원 runner/runtime이 종료됐다는 근거 없이 lock을 삭제하지 않습니다. 새 설치·cache 복사·container/release image build를 이 준비의 부수 작업으로 추가하지 않습니다.

읽기 전용 준비 관측의 시각은 2026-10-16 Backend GET 00:15:33 UTC, 도구 metadata 종료 00:16:49 UTC, entry/config/live PG 관측 종료 01:03:31.611 UTC입니다. 당시 controller selector는 unset이었고, live PG ledger는 001–019였습니다. 이는 source 반영·migration·controller 활성화 성공이 아닙니다. 현재 PID·source/cache/config 경로·원 argv·정확 file hash와 복구 원자료는 private 운영 인계에 보존했으며 공개 문서에 인증/운영 식별 원문을 추가하지 않습니다. 기존 2026-10-15 19:53:29.593 UTC의 수락된 PNG는 당시 개발 화면이며 이번 source 후보의 새 화면 시험이 아닙니다.

이번 준비는 개발환경 controller의 읽기 전용 inventory 연결 범위입니다. 실제 launcher create/delete, trusted specHash 영속화, namespace physical pin·old writer 차단·writer grant, Spot active/standby 장애 인수와 native 기기 합격은 미완료입니다.

## 2026-10-16 실제 연결 결과

위 controller inventory 절은 PR112 당시 source 준비 이력입니다. 후속 [실제 연결 결과](evidence/controller-dev-connection.md)에서 live ledger 19→22, RBAC3·Backend 정상 교체1, 승인 delta5/config/watch, 기존 인증 encrypted status.get1, 새 Expo 목록 PNG1을 Root가 수락했습니다. 새 Pod Ready 관측은 01:46:33.593 UTC이고 화면 캡처는 01:58:40.109 UTC입니다.

Projected defaultMode 0444와 실제 token UID 1000/mode 0600을 구분합니다. Token은 runtime UID에서 읽을 수 있었고 CA·namespace는 0444였으며 credential 내용·hash는 읽지 않았습니다. 최초 admission 비교 실패와 fieldRef.apiVersion 기본값 교정을 보존했고 Pod DELETE/create를 재호출하지 않았습니다.

화면은 연결됨·한글 Ops·Unit 1 RUNNING 목록 카드이며 상세 dialog는 닫혀 있었습니다. Lease 1개·term 1·revision 28 관측은 실제 LIST/WATCH 증거가 아닙니다. 실제 가동 owner의 LIST/WATCH, 전체 checkout/type closure, production launcher/mount·physical pin/old writer fencing·HA/native는 미완료/미측정입니다. 이 결과를 묶는 문서 작업에서 새 실행·재시험·재촬영은 없습니다.

기존 Chromium 개발 wrapper의 CDP FD 전달 방식은 [browser-cdp-fd.md](browser-cdp-fd.md)에 있습니다.
기록된 검증을 재사용하며 새 설치나 촬영은 하지 않습니다.


### Node identity와 Compute 생성 증거 provenance (TODO-03)

후속 rewake는 기존 인증된 Pod/Node identity를 사용하는 승인된 간소화 경로를 유지한다. 내부의 명시적 `AUTHENTICATED_KUBERNETES_NODE` 모드는 TokenReview와 정확한 Pod/Node UID·resourceVersion·providerId·numeric instance ID 검사를 거친 뒤 Node identity만 기록한다. Google의 생성 operation·producer·insert ID·감사 timestamp를 만들지 않으며, Cloud Logging token이나 조회가 필요하지 않다. 초기 생성의 실제 Cloud Audit 경로는 기존 client/parser를 사용한다.

저장된 `compute_identity_evidence_ref`와 `readExecutionTarget(...).computeIdentityProvenance`의 의미는 다음과 같다. 새 grant 활성화 audit/outbox에도 같은 provenance와 원 evidence ref가 포함된다. 별도의 생성 증거 UI/RPC는 없으며 기존 UI는 변경하지 않았다.

| provenance | 저장 ref / 근거 | 의미 |
| --- | --- | --- |
| `AUTHENTICATED_KUBERNETES_NODE` | `kubernetes-node-identity:sha256:…`, 같은 인증 Pod 관측 digest | Kubernetes Node identity 관측. Compute 생성 완료를 주장하지 않는다. |
| `CLOUD_AUDIT_CREATION_COMPLETED` | `compute-creation-cloud-audit-v1:sha256:…` | 실제 생성 client/parser 결과의 정확한 scope·first/last receipt·producer·digest를 검증한 새 생성 관측. 현재 VM 상태나 종료 증명이 아니다. |
| `LEGACY_SYNTHETIC_NODE_IDENTITY` | 옛 `compute-creation-audit:sha256:…`와 알려진 fallback fingerprint가 정확히 일치 | 과거 synthetic 형식. Cloud Audit 증거로 취급하지 않는다. |
| `LEGACY_AMBIGUOUS` | 그 외 옛 `compute-creation-audit:sha256:…` | 저장된 digest만으로 원 수집 receipt를 복원할 수 없다. 실제 감사 경로였을 수도 있으나 genuine audit로 소급 확정하지 않는다. |
| `UNCLASSIFIED` | 인식되지 않거나 Node/Pod digest가 불일치하는 ref | 출처 미확인. |

과거 fallback fingerprint는 SHA256(JSON.stringify(`['node-identity', projectNumber, zone, instanceName, numericInstanceId]`))이다. 분류는 원 ref·observation digest를 보존하는 읽기 projection이며, immutable history를 갱신하거나 backfill하지 않는다. 운영자가 과거 ref의 `audit` 문자열만 보고 genuine audit로 단정하면 안 된다. 실제 PG의 17건을 읽은 결과와 Node 인증 관측은 [실측 기록](evidence/node-identity-provenance-20261019.json)에 구분해 기록했다.

이 provenance는 모두 **실행 target identity의 출처**다. `permanentComputeStop`/writer revoke 권한으로 승격하지 않는다. unit01의 실제 sandbox 종료 또는 기존 정확한 Compute 삭제 증거 요구는 유지된다. Logging 조회 권한의 HTTP 200·결과 0건은 삭제 operation이나 lost-node 복구 증거가 아니다.


### Durable rewake retry (TODO-07)

Rewake의 실패 Map은 정본이 아니다. migration `027-operation-recovery-retry.sql`이 기존 `operations`에 복구 root/claim/accounting metadata를 추가하고, 기존 `retry_at`·`deadline_at`을 재사용한다. 새 retry queue/engine은 만들지 않는다. 준비·NFS 조회 전에 현재 controller가 operation claim을 PG에 commit하며, 한 Unit의 여러 호출은 Session/Unit/operation/lease 경계에서 직렬화된다. 같은 현재 owner가 준비 중인 claim을 다른 호출이 ownerless로 처리하지 않는다.

- 기존 정책인 실패 최대 3회와 실패 후 60초 간격을 유지한다. 각 실패 outcome의 한 번뿐인 accounting과 root count·retry time·소진 이유·audit/outbox·notification을 같은 transaction에 기록한다. 원 command/attempt의 불확실성과 실제 writer-stop 증거는 그대로 보존한다.
- 사건 식별자는 원 WAKE/root operation이다. immutable Pod plan/name 때문에 물리 재시도는 child operation을 쓸 수 있지만 root의 같은 count/limit와 원 deadline을 상속한다. 새 process·controller term·child operation·compatible input으로 예산이나 마감을 갱신하지 않는다. DB trigger도 lineage·소비 횟수·deadline의 되돌림을 거부한다.
- 현재 후속 rewake는 마지막 실제 `attempt.ready_at`/execution epoch를 사건 경계로 사용한다. 같은 실패 중 추가된 입력은 같은 예산을 공유한다. 다음 실제 READY 경계를 통과한 뒤 발생한 독립 장애는 새 사건이 될 수 있다. 입력 읽기·새 receipt 자체는 reset이 아니다. root의 READY anchor는 nullable이므로 **첫 READY 전의 원 WAKE**도 같은 schema/settlement를 쓸 수 있다. 초기 시작 자동 복구는 이 unit에서 구현하지 않았으며 다음 작업은 이 engine을 확장해 재사용해야 한다.
- 마감 또는 횟수 소진은 `REWAKE_DEADLINE_EXHAUSTED` / `REWAKE_RETRY_EXHAUSTED`로 남기고 새 wake를 막는다. 원 DURABLE/UNKNOWN 입력을 지우거나 재전송하지 않는다. 기존 operation 조회의 `recovery`가 count/limit/due/deadline/root를 제공하고, notification에도 소진 사유가 남는다. 실제 READY 확인은 incident를 resolve하며 이미 소비한 예산을 되돌리지 않는다.
- 과거 operation이 식별되는 경우 READY 이후 epoch의 알려진 실패를 합산하고 가장 이른 원 operation lineage를 가져온다. 이전 Map에만 있었던 **operation 생성 전 실패나 nextAt은 복원할 수 없다**. 없는 due에는 한 번의 보수적인 60초 cooldown을 두되 원 deadline을 늘리지 않는다. 원 deadline도 없으면 `REWAKE_DEADLINE_UNAVAILABLE`로 막는다. 옛 private 디렉터리는 초기 legacy 발견 힌트이며 새 claim·budget의 정본이 아니다.

[실측과 한계](evidence/durable-rewake-retry-20261019.json)는 격리 실제 PG 경합·재접속·term takeover와 실제 `prepareOrcadRewake(...).wakePending(signal, controller)` 호출을 구분한다. unit02의 generation9 API health는 wakePending 실행을 증명하지 않았다. 이번 호출 검사는 의도한 준비 실패까지만 실행해 새 factory에서도 count/due를 보존했으며 provider/Pod/NFS 작업은 시작하지 않았다. 실제 Agent 회수나 HA failover를 반복 검증한 것으로 확대하지 않는다. 개발 적용 순서는 additive migration027 후 변경 소스의 기존 watch 반영이다.
